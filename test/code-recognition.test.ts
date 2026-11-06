import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AI_MODEL } from "../src/ai-model";
import {
  AI_TIMEOUT_MS,
  extractCodeWithAi,
  recognizeCode,
} from "../src/code-recognition";

function envWithAi(ai: Env["AI"] | undefined, aiModel?: string): Env {
  return { AI: ai, AI_MODEL: aiModel } as unknown as Env;
}

function aiBinding(run: (...args: unknown[]) => unknown): Env["AI"] {
  return { run } as unknown as Env["AI"];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recognizeCode", () => {
  it("returns the regex code and never calls Workers AI when the regex hits", async () => {
    const run = vi.fn(async () => ({ response: "999999" }));
    const result = await recognizeCode(
      envWithAi(aiBinding(run)),
      "您的验证码 123456，请勿泄露",
    );
    expect(result).toEqual({ code: "123456", source: "regex" });
    expect(run).not.toHaveBeenCalled();
  });

  it("uses Workers AI only after the regex misses", async () => {
    const run = vi.fn(async () => ({ response: "482913" }));
    const content = "登录凭据 482913，请勿泄露";
    const result = await recognizeCode(envWithAi(aiBinding(run)), content);
    expect(result).toEqual({ code: "482913", source: "workers-ai" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      DEFAULT_AI_MODEL,
      {
        messages: [
          { role: "system", content: expect.stringContaining("NONE") },
          { role: "user", content },
        ],
        temperature: 0,
        max_tokens: 512,
      },
    );
  });

  it("accepts a candidate that appears verbatim after full-width digit folding", async () => {
    const run = vi.fn(async () => ({ response: "482913" }));
    const content = "登录凭据 ４８２９１３，请勿泄露";
    const result = await recognizeCode(envWithAi(aiBinding(run)), content);
    expect(result).toEqual({ code: "482913", source: "workers-ai" });
  });

  it("accepts the model's joined digits for a hyphen-grouped code in the body", async () => {
    const run = vi.fn(async () => ({ response: "613408" }));
    const content = "<#> 您的 WhatsApp 验证码：613-408 请不要与他人共享这个密码 4sgLq1p5sV6";
    const result = await recognizeCode(envWithAi(aiBinding(run)), content);
    // The regex layer already joins the groups, so this returns before
    // the AI is consulted; the same content through the AI path is
    // covered by extractCodeWithAi below.
    expect(result).toEqual({ code: "613408", source: "regex" });
    const aiResult = await extractCodeWithAi(
      aiBinding(run),
      "登录凭据 613-408，请勿泄露",
    );
    expect(aiResult).toBe("613408");
  });

  it("accepts letters mixed with digits but rejects all-letter candidates", async () => {
    const mixed = vi.fn(async () => ({ response: "A1B2C3" }));
    const accepted = await recognizeCode(
      envWithAi(aiBinding(mixed)),
      "登录凭据 A1B2C3，请勿泄露",
    );
    expect(accepted).toEqual({ code: "A1B2C3", source: "workers-ai" });

    const letters = vi.fn(async () => ({ response: "ABCDEF" }));
    const rejected = await recognizeCode(
      envWithAi(aiBinding(letters)),
      "登录凭据 ABCDEF，请勿泄露",
    );
    expect(rejected).toEqual({ code: null, source: null });
  });

  it("drops a hallucinated candidate that is not in the SMS body", async () => {
    const run = vi.fn(async () => ({ response: "111111" }));
    const result = await recognizeCode(
      envWithAi(aiBinding(run)),
      "登录凭据 482913，请勿泄露",
    );
    expect(result).toEqual({ code: null, source: null });
  });

  it("drops malformed candidates: spaces, punctuation, and wrong lengths", async () => {
    for (const response of ["48 29 13", '"482913"', "4829", "123456789", "验证码 482913"]) {
      const run = vi.fn(async () => ({ response }));
      const result = await recognizeCode(
        envWithAi(aiBinding(run)),
        "登录凭据 482913，请勿泄露",
      );
      expect(result, response).toEqual({ code: null, source: null });
    }
  });

  it("treats NONE and empty output as no code", async () => {
    for (const response of ["NONE", " none ", "", "   "]) {
      const run = vi.fn(async () => ({ response }));
      const result = await recognizeCode(
        envWithAi(aiBinding(run)),
        "登录凭据 482913，请勿泄露",
      );
      expect(result, response).toEqual({ code: null, source: null });
    }
  });

  it("skips AI when the binding is missing or malformed", async () => {
    expect(await recognizeCode(envWithAi(undefined), "登录凭据 482913")).toEqual({
      code: null,
      source: null,
    });
    expect(await recognizeCode(envWithAi({} as Env["AI"]), "登录凭据 482913")).toEqual({
      code: null,
      source: null,
    });
  });

  it("swallows AI errors and logs without the body or code", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line) => {
      errors.push(String(line));
    });
    const run = vi.fn(async () => {
      throw new Error("model unavailable");
    });
    const result = await recognizeCode(
      envWithAi(aiBinding(run)),
      "登录凭据 482913，请勿泄露",
    );
    expect(result).toEqual({ code: null, source: null });
    expect(errors.join("")).toContain("workers_ai_code_failed");
    expect(errors.join("")).not.toContain("482913");
    expect(errors.join("")).not.toContain("登录凭据");
  });

  it("times out and returns no code", async () => {
    const run = vi.fn(() => new Promise(() => {}));
    const started = Date.now();
    const result = await extractCodeWithAi(aiBinding(run), "登录凭据 482913", 10);
    expect(result).toBeNull();
    expect(Date.now() - started).toBeLessThan(AI_TIMEOUT_MS);
  });

  it("accepts the OpenAI chat-completion shape from the unified model", async () => {
    // The unified default model (gemma-4) answers with
    // { choices: [{ message: { content } }] } instead of { response }.
    const run = vi.fn(async () => ({
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "482913" },
          finish_reason: "stop",
        },
      ],
    }));
    const result = await recognizeCode(
      envWithAi(aiBinding(run)),
      "登录凭据 482913，请勿泄露",
    );
    expect(result).toEqual({ code: "482913", source: "workers-ai" });
    expect(run).toHaveBeenCalledWith(DEFAULT_AI_MODEL, expect.objectContaining({ max_tokens: 512 }));
  });

  it("honors the AI_MODEL env override for code recognition", async () => {
    const run = vi.fn(async () => ({ response: "482913" }));
    const result = await recognizeCode(
      envWithAi(aiBinding(run), "@cf/test/custom-model"),
      "登录凭据 482913，请勿泄露",
    );
    expect(result).toEqual({ code: "482913", source: "workers-ai" });
    expect(run).toHaveBeenCalledWith("@cf/test/custom-model", expect.anything());
  });

  it("falls back to the default model when AI_MODEL is blank", async () => {
    const run = vi.fn(async () => ({ response: "482913" }));
    await recognizeCode(envWithAi(aiBinding(run), "  "), "登录凭据 482913，请勿泄露");
    expect(run).toHaveBeenCalledWith(DEFAULT_AI_MODEL, expect.anything());
  });

  it("returns no code for a non-string or missing response field", async () => {
    expect(await extractCodeWithAi(aiBinding(async () => ({})), "登录凭据 482913")).toBeNull();
    expect(
      await extractCodeWithAi(aiBinding(async () => ({ response: 482913 })), "登录凭据 482913"),
    ).toBeNull();
  });
});
