// One chat model serves both Workers AI features in this Worker: the
// translation fallback (translate.ts) and verification-code recognition
// (code-recognition.ts). The model comes from the AI_MODEL Worker
// secret when it is configured — the deploy workflow syncs it from the
// GitHub repository secret of the same name (see docs/DEPLOY_SECRETS.md)
// — and falls back to the built-in default below when it is not, so the
// features keep working with no configuration at all.
declare global {
  interface Env {
    AI_MODEL?: string;
  }
}

// The model both features run on unless AI_MODEL overrides it. Chosen
// from Cloudflare's 2026-11-05 deprecation notice as the supported
// replacement for the retired llama-3.1-8b-instruct-fp8.
export const DEFAULT_AI_MODEL = "@cf/google/gemma-4-26b-a4b-it";

export function resolveAiModel(env: { AI_MODEL?: string } | null | undefined): string {
  const configured = env?.AI_MODEL?.trim();
  return configured ? configured : DEFAULT_AI_MODEL;
}

// Chat models on Workers AI answer in one of two shapes: the native
// { response: "..." } shape (llama family) or the OpenAI
// chat-completion shape { choices: [{ message: { content } }] }
// (gemma-4 and the gateway-routed models). Both features read model
// output through this one reader so a model swap — via the AI_MODEL
// secret — never strands one of them on a shape it cannot parse.
// Returns the raw answer text; each caller applies its own cleanup
// and validation.
export function readChatResponse(output: unknown): string | null {
  if (typeof output !== "object" || output === null) return null;
  const response = (output as { response?: unknown }).response;
  if (typeof response === "string") return response;
  const choices = (output as { choices?: unknown }).choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const message = (choices[0] as { message?: unknown }).message;
    const content =
      typeof message === "object" && message !== null
        ? (message as { content?: unknown }).content
        : undefined;
    if (typeof content === "string") return content;
  }
  return null;
}
