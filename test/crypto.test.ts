import { describe, expect, it } from "vitest";
import { bytesToBase64Url } from "../src/auth";
import {
  decryptString,
  ENCRYPTED_PREFIX,
  resolveContentKey,
  revealCode,
  revealText,
  sealMessage,
  UNREADABLE_CONTENT,
} from "../src/crypto";
import { messageMatchesQuery } from "../src/search";

const PLAIN = {
  content: "验证码 123456",
  code: "123456",
  rawPayload: JSON.stringify({ sim: "1", device: "pixel", body: "验证码 123456" }),
};

function keyFrom(bytes: Uint8Array) {
  const resolved = resolveContentKey(bytesToBase64Url(bytes));
  if (resolved.state !== "on") throw new Error("expected a usable key");
  return resolved;
}

describe("optional AES-GCM storage", () => {
  it("leaves plaintext untouched when CONTENT_KEY is empty and rejects a short key", async () => {
    expect(resolveContentKey(undefined)).toEqual({ state: "off" });
    expect(resolveContentKey("  ")).toEqual({ state: "off" });
    const open = await sealMessage({ state: "off" }, PLAIN);
    expect(open).toEqual({ ...PLAIN, encrypted: 0 });
    expect(resolveContentKey("aaaa").state).toBe("invalid");
    expect(await sealMessage({ state: "invalid" }, PLAIN)).toEqual({ error: "invalid_key" });
  });

  it("round-trips content, code, and raw payload with a fresh IV", async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const key = keyFrom(bytes);
    const first = await sealMessage(key, PLAIN);
    const second = await sealMessage(key, PLAIN);
    expect("error" in first).toBe(false);
    expect("error" in second).toBe(false);
    if ("error" in first || "error" in second) return;
    expect(first.encrypted).toBe(1);
    expect(first.content.startsWith(ENCRYPTED_PREFIX)).toBe(true);
    expect(first.code?.startsWith(ENCRYPTED_PREFIX)).toBe(true);
    expect(first.content).not.toBe(second.content);
    expect(first.content).not.toBe(PLAIN.content);
    expect(await decryptString(bytes, first.content)).toBe(PLAIN.content);
    expect(await revealCode(key, first.code, true)).toBe("123456");
    expect(await decryptString(bytes, first.rawPayload)).toBe(PLAIN.rawPayload);

    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const standard = resolveContentKey(btoa(binary));
    expect(standard.state).toBe("on");
    if (standard.state !== "on") return;
    expect(await decryptString(standard.raw, first.content)).toBe(PLAIN.content);
  });

  it("fails closed when the ciphertext or key is wrong", async () => {
    const bytes = new Uint8Array(32);
    bytes[3] = 7;
    const key = keyFrom(bytes);
    const sealed = await sealMessage(key, PLAIN);
    if ("error" in sealed || sealed.code === null) throw new Error("seal failed");
    // The final base64url character can be unused padding bits, so flipping it
    // sometimes leaves the ciphertext bytes unchanged. Flip the first character
    // of the cipher segment, which always changes a decrypted byte.
    const cipherAt = sealed.content.indexOf(".") + 1;
    const cipherChar = sealed.content[cipherAt] === "a" ? "b" : "a";
    const flipped = `${sealed.content.slice(0, cipherAt)}${cipherChar}${sealed.content.slice(cipherAt + 1)}`;
    expect(await decryptString(bytes, flipped)).toBeNull();
    expect(await revealText(key, flipped, true)).toBe(UNREADABLE_CONTENT);
    const other = new Uint8Array(32);
    other[3] = 8;
    expect(await decryptString(other, sealed.content)).toBeNull();
    expect(await revealText({ state: "off" }, sealed.content, true)).toBe(UNREADABLE_CONTENT);
    expect(await revealCode({ state: "off" }, sealed.code, true)).toBeNull();
    expect(await revealText({ state: "off" }, "明文", false)).toBe("明文");
  });
});

describe("encrypted search", () => {
  it("matches decrypted content, sender, and code without treating the query as SQL LIKE", () => {
    const message = { content: "登录验证码 123456", from_number: "10086", code: "123456" };
    expect(messageMatchesQuery(message, "验证码")).toBe(true);
    expect(messageMatchesQuery(message, "CODE")).toBe(false);
    expect(messageMatchesQuery(message, "10086")).toBe(true);
    expect(messageMatchesQuery(message, "123456")).toBe(true);
    expect(messageMatchesQuery(message, "100%")).toBe(false);
    expect(messageMatchesQuery(message, "  ")).toBe(true);
  });
});
