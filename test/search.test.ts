import { describe, expect, it } from "vitest";
import { retentionDays } from "../src/db";
import { compileLikeQuery } from "../src/search";

describe("compileLikeQuery", () => {
  it("wraps a keyword and escapes LIKE wildcards", () => {
    expect(compileLikeQuery(null)).toEqual({ ok: true, pattern: null });
    expect(compileLikeQuery("  ")).toEqual({ ok: true, pattern: null });
    expect(compileLikeQuery("验证码")).toEqual({ ok: true, pattern: "%验证码%" });
    expect(compileLikeQuery("100%_a")).toEqual({ ok: true, pattern: "%100\\%\\_a%" });
  });

  it("rejects patterns longer than the D1 50-byte limit", () => {
    const tooLong = "验".repeat(17);
    const result = compileLikeQuery(tooLong);
    expect(result.ok).toBe(false);
    expect(new TextEncoder().encode(`%${"验".repeat(16)}%`).byteLength).toBe(50);
    expect(compileLikeQuery("验".repeat(16)).ok).toBe(true);
  });
});

describe("retentionDays", () => {
  it("defaults to 90 days for missing or invalid values", () => {
    expect(retentionDays("90")).toBe(90);
    expect(retentionDays("30")).toBe(30);
    expect(retentionDays(undefined)).toBe(90);
    expect(retentionDays("0")).toBe(90);
    expect(retentionDays("forever")).toBe(90);
  });
});
