import { describe, expect, it } from "vitest";
import {
  hashPassword,
  randomToken,
  readBearer,
  secretsEqual,
  sessionCookieHeader,
  sha256Hex,
  verifyPassword,
} from "../src/auth";

describe("password hashing", () => {
  it("verifies the original password and rejects others", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(stored.startsWith("pbkdf2-sha256$10000$")).toBe(true);
    expect(stored).not.toContain("correct horse");
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("wrong password", stored)).toBe(false);
    expect(await verifyPassword("correct horse battery", "nope")).toBe(false);
    const parts = stored.split("$");
    const digest = parts[3] ?? "";
    const flipped = digest.startsWith("A") ? "B" : "A";
    const broken = `${parts.slice(0, 3).join("$")}$${flipped}${digest.slice(1)}`;
    expect(await verifyPassword("correct horse battery", broken)).toBe(false);
  });
});

describe("device tokens and cookies", () => {
  it("hashes tokens with SHA-256 and builds an HttpOnly session cookie", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const token = randomToken();
    expect(token.startsWith("sms_")).toBe(true);
    expect(token).toMatch(/^sms_[A-Za-z0-9_-]+$/);
    expect(await sha256Hex(token)).not.toBe(await sha256Hex(`${token}x`));

    const secure = sessionCookieHeader("sms_abc", true, 3600);
    expect(secure).toContain("HttpOnly");
    expect(secure).toContain("Secure");
    expect(secure).toContain("SameSite=Lax");
    expect(secure).toContain("Max-Age=3600");
    const local = sessionCookieHeader("sms_abc", false, 0);
    expect(local).not.toContain("Secure");
    expect(local).toContain("Max-Age=0");
  });

  it("reads bearer tokens", () => {
    expect(readBearer("Bearer sms_1234567890abcdef")).toBe("sms_1234567890abcdef");
    expect(readBearer("bearer sms_1234567890abcdef")).toBe("sms_1234567890abcdef");
    expect(readBearer("Basic abcdefghijklmnop")).toBeNull();
    expect(readBearer("Bearer short")).toBeNull();
    expect(readBearer(null)).toBeNull();
  });

  it("compares secrets without requiring equal length", async () => {
    expect(await secretsEqual("admin-password", "admin-password")).toBe(true);
    expect(await secretsEqual("admin-password", "admin-passworD")).toBe(false);
    expect(await secretsEqual("short", "much-longer-secret")).toBe(false);
  });
});
