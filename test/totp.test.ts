import { describe, expect, it } from "vitest";
import { bytesToBase64Url } from "../src/auth";
import { resolveContentKey } from "../src/crypto";
import {
  base32Decode,
  base32Encode,
  formatRecoveryCode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  hotp,
  matchTotp,
  normalizeRecoveryCode,
  normalizeTotpCode,
  openTotpSecret,
  sealTotpSecret,
  totpCounter,
  totpUri,
  TOTP_DIGITS,
} from "../src/totp";

// RFC 6238 Appendix B uses this ASCII secret for the SHA-1 vectors.
const RFC_SECRET = "12345678901234567890";

describe("base32", () => {
  it("round-trips and tolerates spacing, dashes, and lower case", () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x42]);
    const encoded = base32Encode(bytes);
    expect(new Uint8Array(base32Decode(encoded) ?? [])).toEqual(bytes);
    expect(base32Encode(new TextEncoder().encode(RFC_SECRET))).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode("gezd gnbv-gy3t qojq")).toEqual(base32Decode("GEZDGNBVGY3TQOJQ"));
    expect(base32Decode("GEZD1NBV")).toBeNull();
    expect(base32Decode("")).toBeNull();
  });

  it("generates a 20-byte secret with the expected alphabet", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).not.toBeNull();
    expect(base32Decode(secret)?.byteLength).toBe(20);
    expect(generateTotpSecret()).not.toBe(secret);
  });
});

describe("TOTP", () => {
  const secret = base32Encode(new TextEncoder().encode(RFC_SECRET));

  it("matches the RFC 6238 SHA-1 vectors", async () => {
    const vectors: Array<[number, string]> = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ];
    for (const [seconds, expected] of vectors) {
      expect(await hotp(base32Decode(secret) ?? new Uint8Array(), Math.floor(seconds / 30), 8)).toBe(expected);
    }
  });

  it("produces six digits and accepts one step of clock skew", async () => {
    const bytes = base32Decode(secret) ?? new Uint8Array();
    const current = await hotp(bytes, 1);
    expect(current).toMatch(/^\d{6}$/);
    expect(current).toBe("287082");
    expect(await matchTotp({ secret, code: current, nowMs: 59_000 })).toBe(1);
    expect(await matchTotp({ secret, code: await hotp(bytes, 0), nowMs: 59_000 })).toBe(0);
    expect(await matchTotp({ secret, code: await hotp(bytes, 2), nowMs: 59_000 })).toBe(2);
    expect(await matchTotp({ secret, code: await hotp(bytes, 3), nowMs: 59_000 })).toBeNull();
    expect(await matchTotp({ secret, code: "12345", nowMs: 59_000 })).toBeNull();
    expect(await matchTotp({ secret, code: "abcdef", nowMs: 59_000 })).toBeNull();
    expect(totpCounter(59_999)).toBe(1);
    expect(totpCounter(60_000)).toBe(2);
  });

  it("rejects a replayed step when lastCounter is set", async () => {
    const bytes = base32Decode(secret) ?? new Uint8Array();
    const code = await hotp(bytes, 1);
    expect(await matchTotp({ secret, code, nowMs: 59_000, lastCounter: 1 })).toBeNull();
    expect(await matchTotp({ secret, code, nowMs: 59_000, lastCounter: 0 })).toBe(1);
    expect(await matchTotp({ secret, code: await hotp(bytes, 0), nowMs: 59_000, lastCounter: 1 })).toBeNull();
  });

  it("builds an otpauth URI that authenticator apps understand", () => {
    const uri = totpUri(secret, "admin");
    expect(uri.startsWith("otpauth://totp/SMSinBox%3Aadmin?")).toBe(true);
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain("issuer=SMSinBox");
    expect(uri).toContain(`digits=${TOTP_DIGITS}`);
    expect(uri).toContain("period=30");
    expect(uri).toContain("algorithm=SHA1");
    expect(normalizeTotpCode(" 123 456 ")).toBe("123456");
  });
});

describe("recovery codes", () => {
  it("formats, normalizes, and hashes one-time codes deterministically", async () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
      const raw = normalizeRecoveryCode(code);
      expect(raw).not.toBeNull();
      expect(formatRecoveryCode(raw ?? "")).toBe(code);
      expect(normalizeRecoveryCode(code.toLowerCase().replaceAll("-", " "))).toBe(raw);
      expect(await hashRecoveryCode(code)).toBe(await hashRecoveryCode(raw ?? ""));
    }
    expect(normalizeRecoveryCode("too-short")).toBeNull();
    expect(await hashRecoveryCode(codes[0] ?? "")).not.toBe(await hashRecoveryCode(codes[1] ?? ""));
  });
});

describe("sealed TOTP secret", () => {
  it("keeps plaintext only when CONTENT_KEY is off", async () => {
    const off = resolveContentKey(undefined);
    const secret = generateTotpSecret();
    const stored = await sealTotpSecret(off, secret);
    expect(stored).toBe(`plain:${secret}`);
    expect(await openTotpSecret(off, stored ?? "")).toBe(secret);

    const invalid = resolveContentKey("not-a-32-byte-key");
    expect(await sealTotpSecret(invalid, secret)).toBeNull();
    expect(await openTotpSecret(invalid, stored ?? "")).toBe(secret);
  });

  it("encrypts with AES-GCM when CONTENT_KEY is configured", async () => {
    const key = resolveContentKey(bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32))));
    const secret = generateTotpSecret();
    const sealed = await sealTotpSecret(key, secret);
    expect(sealed?.startsWith("enc1:")).toBe(true);
    expect(sealed).not.toContain(secret);
    expect(await openTotpSecret(key, sealed ?? "")).toBe(secret);
    expect(await openTotpSecret(resolveContentKey(undefined), sealed ?? "")).toBeNull();

    const rotated = resolveContentKey(bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32))));
    expect(await openTotpSecret(rotated, sealed ?? "")).toBeNull();
  });
});
