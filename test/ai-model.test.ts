import { describe, expect, it } from "vitest";
import { DEFAULT_AI_MODEL, readChatResponse, resolveAiModel } from "../src/ai-model";

describe("resolveAiModel", () => {
  it("defaults to the built-in unified model when AI_MODEL is not configured", () => {
    expect(DEFAULT_AI_MODEL).toBe("@cf/google/gemma-4-26b-a4b-it");
    expect(resolveAiModel(undefined)).toBe(DEFAULT_AI_MODEL);
    expect(resolveAiModel(null)).toBe(DEFAULT_AI_MODEL);
    expect(resolveAiModel({})).toBe(DEFAULT_AI_MODEL);
    expect(resolveAiModel({ AI_MODEL: undefined })).toBe(DEFAULT_AI_MODEL);
  });

  it("treats an empty or whitespace-only AI_MODEL as not configured", () => {
    expect(resolveAiModel({ AI_MODEL: "" })).toBe(DEFAULT_AI_MODEL);
    expect(resolveAiModel({ AI_MODEL: "   " })).toBe(DEFAULT_AI_MODEL);
  });

  it("returns the configured model, trimmed", () => {
    expect(resolveAiModel({ AI_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" })).toBe(
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    );
    expect(resolveAiModel({ AI_MODEL: "  @cf/test/model  " })).toBe("@cf/test/model");
  });
});

describe("readChatResponse", () => {
  it("reads the native { response } shape", () => {
    expect(readChatResponse({ response: "482913" })).toBe("482913");
  });

  it("reads the OpenAI chat-completion shape", () => {
    expect(
      readChatResponse({
        choices: [{ index: 0, message: { role: "assistant", content: "482913" }, finish_reason: "stop" }],
      }),
    ).toBe("482913");
  });

  it("prefers the native shape when both are present", () => {
    expect(
      readChatResponse({
        response: "native",
        choices: [{ message: { content: "openai" } }],
      }),
    ).toBe("native");
  });

  it("returns the raw text unmodified (cleanup is the caller's job)", () => {
    expect(readChatResponse({ response: "  padded  " })).toBe("  padded  ");
    expect(readChatResponse({ choices: [{ message: { content: "" } }] })).toBe("");
  });

  it("returns null for missing, non-string, or malformed output", () => {
    expect(readChatResponse(null)).toBeNull();
    expect(readChatResponse(undefined)).toBeNull();
    expect(readChatResponse("482913")).toBeNull();
    expect(readChatResponse({})).toBeNull();
    expect(readChatResponse({ response: 482913 })).toBeNull();
    expect(readChatResponse({ choices: [] })).toBeNull();
    expect(readChatResponse({ choices: [{ message: { content: null } }] })).toBeNull();
    expect(readChatResponse({ choices: [{ message: null }] })).toBeNull();
    expect(readChatResponse({ choices: [{}] })).toBeNull();
  });
});
