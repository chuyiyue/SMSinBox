import { describe, expect, it } from "vitest";
import { dedupBucket, dedupHash, normalizeContent } from "../src/dedup";

const BASE = {
  deviceId: "device-1",
  from: "10086",
  content: "验证码 123456",
  receivedAt: 1_700_000_040_000,
};

describe("dedup", () => {
  it("normalizes whitespace before hashing", () => {
    expect(normalizeContent("  验证码\u3000 123456 \n")).toBe("验证码 123456");
    expect(normalizeContent("a\tb\n\nc")).toBe("a b c");
  });

  it("is stable for the same device, sender, content, and minute", async () => {
    const first = await dedupHash(BASE);
    const spaced = await dedupHash({ ...BASE, content: "  验证码\t123456\n" });
    const laterInMinute = await dedupHash({ ...BASE, receivedAt: BASE.receivedAt + 59_999 });
    expect(spaced).toBe(first);
    expect(laterInMinute).toBe(first);
    expect(dedupBucket(BASE.receivedAt)).toBe(dedupBucket(BASE.receivedAt + 59_999));
  });

  it("changes when the device, sender, content, or minute changes", async () => {
    const first = await dedupHash(BASE);
    expect(await dedupHash({ ...BASE, deviceId: "device-2" })).not.toBe(first);
    expect(await dedupHash({ ...BASE, from: "10010" })).not.toBe(first);
    expect(await dedupHash({ ...BASE, content: "验证码 654321" })).not.toBe(first);
    expect(await dedupHash({ ...BASE, receivedAt: BASE.receivedAt + 60_000 })).not.toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });
});
