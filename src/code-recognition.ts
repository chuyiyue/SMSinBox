import { extractCode, foldDigits } from "./extract";
import { errorText, logError } from "./log";
import type { CodeSource } from "./types";

// Keep this in sync with wrangler.jsonc. The fp8 variant is the same Llama 3.1
// 8B instruction model with lower latency/cost on Workers AI.
export const AI_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";
export const AI_TIMEOUT_MS = 4000;

// A code is at most 8 characters, so a small ceiling is enough and bounds cost.
const AI_MAX_TOKENS = 16;
const CANDIDATE_RE = /^(?=.*\d)[A-Za-z0-9]{4,8}$/;

const SYSTEM_PROMPT = [
  "你是短信验证码提取器。",
  "从用户给出的短信正文中找出验证码，只输出验证码本身：4 到 8 位数字，或 4 到 8 位字母数字组合，不含空格或标点。",
  "正文中没有验证码时，只输出 NONE。",
  "不要解释，不要输出其他任何内容。",
].join("");

export interface RecognizedCode {
  code: string | null;
  source: CodeSource | null;
}

// Regex stays authoritative: Workers AI is only consulted when the regex finds
// nothing. Any AI failure degrades to "no code" so ingest never fails or waits
// on it for more than AI_TIMEOUT_MS.
export async function recognizeCode(env: Env, content: string): Promise<RecognizedCode> {
  const regexCode = extractCode(content);
  if (regexCode !== null) return { code: regexCode, source: "regex" };

  const aiCode = await extractCodeWithAi(env.AI, content);
  return aiCode === null ? { code: null, source: null } : { code: aiCode, source: "workers-ai" };
}

// Exported for tests so the timeout can be shortened without waiting 4s.
export async function extractCodeWithAi(
  ai: Ai | undefined,
  content: string,
  timeoutMs = AI_TIMEOUT_MS,
): Promise<string | null> {
  if (!ai || typeof ai.run !== "function") return null;
  try {
    const output = await withTimeout(
      ai.run(AI_MODEL, {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content },
        ],
        temperature: 0,
        max_tokens: AI_MAX_TOKENS,
      }),
      timeoutMs,
    );
    return validateCandidate(readAiResponse(output), content);
  } catch (error) {
    // Never log the SMS body or the model output: either could contain a code.
    logError({ message: "workers_ai_code_failed", error: errorText(error) });
    return null;
  }
}

function readAiResponse(output: unknown): string | null {
  if (typeof output !== "object" || output === null) return null;
  const response = (output as { response?: unknown }).response;
  if (typeof response !== "string") return null;
  const text = response.trim();
  if (!text || text.toUpperCase() === "NONE") return null;
  return text;
}

// Anti-hallucination: the candidate must look like a code and appear verbatim
// in the body, using the same full-width digit folding as extract.ts.
function validateCandidate(candidate: string | null, content: string): string | null {
  if (candidate === null) return null;
  if (!CANDIDATE_RE.test(candidate)) return null;
  const folded = foldDigits(content);
  // The candidate must appear as a standalone token: a hit glued to more
  // letters or digits is part of a longer string (e.g. "4829" inside
  // "482913"), not the code itself.
  let from = 0;
  for (;;) {
    const index = folded.indexOf(candidate, from);
    if (index === -1) return null;
    const before = index > 0 ? folded[index - 1]! : "";
    const after = folded[index + candidate.length] ?? "";
    if (!/[A-Za-z0-9]/.test(before) && !/[A-Za-z0-9]/.test(after)) return candidate;
    from = index + 1;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("ai_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
