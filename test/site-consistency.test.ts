import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { copyBytes } from "../src/auth";
import { errorText } from "../src/log";

const pages = ["public/index.html", "public/devices.html", "public/notify.html", "public/users.html"];

function navHrefs(html: string): string[] {
  const nav = html.match(/<nav class="sidebar-nav"[\s\S]*?<\/nav>/)?.[0] ?? "";
  return [...nav.matchAll(/href="([^"]+)"/g)].map((match) => match[1] ?? "");
}

describe("site consistency", () => {
  it("uses the same navigation and shell on every app page", () => {
    const hrefs = pages.map((file) => navHrefs(readFileSync(file, "utf8")));
    expect(hrefs[0]).toEqual(["/", "/devices.html", "/notify.html", "/users.html"]);
    for (const file of pages) {
      const html = readFileSync(file, "utf8");
      expect(navHrefs(html)).toEqual(hrefs[0]);
      expect(html).toContain('class="app-layout"');
      expect(html).toContain('class="sidebar"');
      expect(html).toContain('class="topbar"');
      expect(html).toContain('placeholder="搜索正文、号码或验证码"');
      expect(html).toContain('src="/mark.svg"');
      expect(html).toContain("SMSinBox");
    }
  });

  it("styles the signed-out pages the same way", () => {
    for (const file of ["public/login.html", "public/404.html"]) {
      const html = readFileSync(file, "utf8");
      expect(html).toContain('class="auth-body"');
      expect(html).toContain('class="auth-card"');
      expect(html).toContain('class="brand"');
      expect(html).toContain('src="/mark.svg"');
    }
  });

  it("keeps shared colors on tokens and failed loads out of the empty state", () => {
    const css = readFileSync("public/style.css", "utf8");
    expect(css).toContain("--danger-bg: #fde8e4");
    expect(css).toContain("--ok-bg: #e7f5ef");
    expect(css).toContain("--warn-bg: #fff7e8");
    expect(css).toContain("background: var(--danger-bg)");
    expect(css).toContain("background: var(--warn-bg)");
    expect(css).toContain(".device, .record");
    const devices = readFileSync("public/devices.js", "utf8");
    const notify = readFileSync("public/notify.js", "utf8");
    const users = readFileSync("public/users.js", "utf8");
    expect(devices).toContain("if (!result.response.ok)");
    expect(notify).toContain("if (!result.response.ok)");
    expect(users).toContain("if (!result.response.ok)");
    expect(devices).toContain("flashLabel");
    expect(readFileSync("public/inbox.js", "utf8")).toContain("flashLabel");
    expect(readFileSync("public/common.js", "utf8")).toContain("还没有设备。");
  });

  it("shortens log errors the same way everywhere", () => {
    expect(errorText(new Error("x".repeat(200)))).toHaveLength(180);
    expect(errorText(new Error("短"))).toBe("短");
    expect(errorText("nope")).toBe("unknown");
    const bytes = new Uint8Array([1, 2, 3]);
    const copy = copyBytes(bytes);
    bytes[0] = 9;
    expect(new Uint8Array(copy)).toEqual(new Uint8Array([1, 2, 3]));
  });
});
