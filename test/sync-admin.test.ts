import { describe, expect, it } from "vitest";
import { hashPassword as scriptHash, verifyPassword as scriptVerify } from "../scripts/sync-admin.mjs";
import { hashPassword, verifyPassword } from "../src/auth";

describe("sync-admin password hash", () => {
  it("matches src/auth.ts in both directions and rejects a wrong password", async () => {
    const fromScript = await scriptHash("correct-horse");
    expect(fromScript.startsWith("pbkdf2-sha256$100000$")).toBe(true);
    expect(await verifyPassword("correct-horse", fromScript)).toBe(true);
    expect(await verifyPassword("wrong-horse", fromScript)).toBe(false);

    const fromWorker = await hashPassword("correct-horse");
    expect(await scriptVerify("correct-horse", fromWorker)).toBe(true);
    expect(await scriptVerify("wrong-horse", fromWorker)).toBe(false);
  });
});
