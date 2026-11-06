import { DEFAULT_AI_MODEL, readChatResponse, resolveAiModel } from "./ai-model";
import { extractCode, foldDigits } from "./extract";
import { errorText, logError } from "./log";
import type { CodeSource } from "./types";

export const AI_TIMEOUT_MS = 6000;

// The unified model (ai-model.ts) is a reasoning model: it spends a
// few hundred tokens thinking before it answers, so the 16-token
// ceiling that suited the previous non-reasoning model would cut every
// answer off before the code appears. 512 leaves headroom while still
// bounding cost; the AI path only runs when the regex found nothing.
const AI_MAX_TOKENS = 512;
const CANDIDATE_RE = /^(?=.*\d)[A-Za-z0-9]{4,8}$/;

const SYSTEM_PROMPT = [
  "你是短信验证码提取器。",
  "从用户给出的短信正文中找出验证码，只输出验证码本身：4 到 8 位数字，或 4 到 8 位字母数字组合，不含空格或标点。",
  "正文中的验证码中间可能带连字符或空格（如 613-408），输出时去掉分隔符，只输出连起来的数字。",
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

  const aiCode = await extractCodeWithAi(env.AI, content, AI_TIMEOUT_MS, resolveAiModel(env));
  return aiCode === null ? { code: null, source: null } : { code: aiCode, source: "workers-ai" };
}

// Exported for tests so the timeout can be shortened without waiting 4s.
export async function extractCodeWithAi(
  ai: Ai | undefined,
  content: string,
  timeoutMs = AI_TIMEOUT_MS,
  model: string = DEFAULT_AI_MODEL,
): Promise<string | null> {
  if (!ai || typeof ai.run !== "function") return null;
  try {
    const output = await withTimeout(
      ai.run(model, {
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
  // Shared dual-shape reader (ai-model.ts): accepts the native
  // { response } shape and the OpenAI chat-completion shape the
  // unified default model returns.
  const raw = readChatResponse(output);
  if (raw === null) return null;
  const text = raw.trim();
  if (!text || text.toUpperCase() === "NONE") return null;
  return text;
}

// Anti-hallucination: the candidate must look like a code and appear in
// the body, using the same full-width digit folding as extract.ts.
function validateCandidate(candidate: string | null, content: string): string | null {
  if (candidate === null) return null;
  if (!CANDIDATE_RE.test(candidate)) return null;
  const folded = foldDigits(content);
  if (appearsStandalone(folded, candidate)) return candidate;
  // Codes printed with a separator ("613-408") validate against the
  // separator-free text, so the model's joined digits still count as
  // appearing in the body.
  const squeezed = folded.replace(/(\d)[- ](?=\d)/g, "$1");
  return appearsStandalone(squeezed, candidate) ? candidate : null;
}

// The candidate must appear as a standalone token: a hit glued to more
// letters or digits is part of a longer string (e.g. "4829" inside
// "482913"), not the code itself.
function appearsStandalone(haystack: string, candidate: string): boolean {
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(candidate, from);
    if (index === -1) return false;
    const before = index > 0 ? haystack[index - 1]! : "";
    const after = haystack[index + candidate.length] ?? "";
    if (!/[A-Za-z0-9]/.test(before) && !/[A-Za-z0-9]/.test(after)) return true;
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
