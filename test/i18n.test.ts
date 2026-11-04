import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  MESSAGES,
  currentLocale,
  formatAbsoluteStamp,
  formatMinuteStamp,
  formatRelative,
  setLocale,
  t,
} from "../public/i18n.js";

afterEach(() => {
  setLocale("zh-CN");
});

describe("locale dictionary", () => {
  it("gives zh-CN and en the same keys", () => {
    const zh = Object.keys(MESSAGES["zh-CN"]).sort();
    const en = Object.keys(MESSAGES.en).sort();
    expect(zh.length).toBeGreaterThan(40);
    expect(en).toEqual(zh);
    for (const key of zh) {
      expect(MESSAGES["zh-CN"][key].length, key).toBeGreaterThan(0);
      expect(MESSAGES.en[key].length, key).toBeGreaterThan(0);
    }
  });

  it("translates, interpolates, and falls back to zh-CN then the key", () => {
    expect(currentLocale()).toBe("zh-CN");
    expect(t("nav.inbox")).toBe("收件箱");
    expect(t("time.minutesAgo", { n: 5 })).toBe("5 分钟前");
    expect(t("nav.accountTitle", { name: "Ada" })).toBe("Ada · 系统管理");
    expect(t("time.minutesAgo", {})).toBe("{n} 分钟前");
    expect(t("missing.key")).toBe("missing.key");

    expect(setLocale("en")).toBe(true);
    expect(t("nav.inbox")).toBe("Inbox");
    expect(t("nav.accountTitle", { name: "Ada" })).toBe("Ada · Settings");
    const saved = MESSAGES.en["common.save"];
    delete MESSAGES.en["common.save"];
    expect(t("common.save")).toBe("保存");
    MESSAGES.en["common.save"] = saved;
    expect(setLocale("nope")).toBe(false);
    expect(currentLocale()).toBe("en");
    setLocale("zh-CN");
  });

  it("keeps the existing Chinese time habit and uses en-US for English", () => {
    const now = new Date(2026, 5, 15, 12, 0, 0).getTime();
    expect(formatRelative(now - 30_000, now)).toBe("刚刚");
    expect(formatRelative(now - 5 * 60_000, now)).toBe("5 分钟前");
    expect(formatRelative(now - 60_000, now)).toBe("1 分钟前");
    expect(formatRelative(new Date(2026, 5, 14, 9, 5, 0).getTime(), now)).toBe("昨天 09:05");
    expect(formatRelative(new Date(2026, 0, 2, 8, 7, 0).getTime(), now)).toBe("01-02 08:07");
    expect(formatRelative(new Date(2025, 11, 31, 23, 4, 0).getTime(), now)).toBe("2025-12-31 23:04");
    expect(formatMinuteStamp(new Date(2026, 5, 15, 12, 4, 0).getTime())).toBe("2026-06-15 12:04");
    const absolute = formatAbsoluteStamp(new Date(2026, 5, 15, 12, 4, 6).getTime());
    expect(absolute.startsWith("2026")).toBe(true);
    expect(absolute).toContain("（");

    setLocale("en");
    expect(formatRelative(now - 5 * 60_000, now)).toBe("5 minutes ago");
    expect(formatRelative(now - 60_000, now)).toBe("1 minute ago");
    const yesterday = formatRelative(new Date(2026, 5, 14, 9, 5, 0).getTime(), now);
    expect(yesterday.startsWith("Yesterday")).toBe(true);
    expect(formatMinuteStamp(new Date(2026, 5, 15, 12, 4, 0).getTime())).not.toBe("2026-06-15 12:04");
    const absoluteEn = formatAbsoluteStamp(new Date(2026, 5, 15, 12, 4, 6).getTime());
    expect(absoluteEn).toContain("(");
    expect(absoluteEn).not.toContain("（");
  });

  it("resolves every static dictionary reference in the public UI", () => {
    const keys = new Set<string>();
    const keyName = /^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+$/;
    const add = (key: string) => {
      if (keyName.test(key)) keys.add(key);
    };
    for (const file of publicSources("public")) {
      const src = readFileSync(file, "utf8");
      for (const match of src.matchAll(/\bt\(\s*"([^"]+)"/g)) add(match[1]);
      for (const match of src.matchAll(/data-i18n="([^"]+)"/g)) add(match[1]);
      for (const match of src.matchAll(/data-i18n-attr="([^"]*)"/g)) {
        for (const part of match[1].split(";")) {
          const splitAt = part.indexOf(":");
          if (splitAt <= 0) continue;
          add(part.slice(splitAt + 1).trim());
        }
      }
      for (const match of src.matchAll(/setAttribute\(\s*"data-i18n"\s*,\s*"([^"]+)"/g)) add(match[1]);
      for (const match of src.matchAll(/setAttribute\(\s*"data-i18n-attr"\s*,\s*"([^"]+)"/g)) {
        for (const part of match[1].split(";")) {
          const splitAt = part.indexOf(":");
          if (splitAt <= 0) continue;
          add(part.slice(splitAt + 1).trim());
        }
      }
      // Key strings stored for a later t() call, including dynamic labels.
      for (const match of src.matchAll(/"((?:inbox|devices|guide|notify|api|auth|users|totp|notfound|lang|common|nav|shell|time)\.[A-Za-z0-9-]+)"/g)) {
        add(match[1]);
      }
    }
    const missing = [...keys].filter((key) => !(key in MESSAGES["zh-CN"])).sort();
    expect(missing).toEqual([]);
  });
});

function publicSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name.endsWith(".js") || name.endsWith(".html")) out.push(path);
  }
  return out;
}
