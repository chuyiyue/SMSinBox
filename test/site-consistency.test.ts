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
      expect(html).toContain('id="sidebar-devices"');
      expect(html).toContain('src="/sidebar-boot.js"');
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
    const shell = readFileSync("public/shell.js", "utf8");
    const store = readFileSync("public/device-store.js", "utf8");
    const common = readFileSync("public/common.js", "utf8");
    expect(shell).toContain("history.pushState");
    expect(shell).toContain('.app-layout > .main');
    expect(shell).not.toContain('querySelector("#sidebar")?.replaceWith');
    expect(shell).toContain("registerView");
    expect(store).toContain("noteDeviceSeen");
    expect(store).toContain("generation");
    expect(store).toContain("smsinbox.shell");
    expect(common).toContain("data-key");
    expect(common).toContain("insertBefore");
    expect(common).not.toContain("box.replaceChildren");
    expect(readFileSync("public/sidebar-boot.js", "utf8")).toContain("smsinbox.shell");
    expect(readFileSync("public/inbox.js", "utf8")).toContain("noteDeviceSeen");
    expect(readFileSync("public/devices.js", "utf8")).toContain("refreshDevices");
  });

  it("wires the login second step and the two-factor panel", () => {
    const login = readFileSync("public/login.html", "utf8");
    const loginJs = readFileSync("public/login.js", "utf8");
    expect(login).toContain('id="totp-form"');
    expect(login).toContain('autocomplete="one-time-code"');
    expect(loginJs).toContain("/api/v1/auth/totp/verify");
    expect(loginJs).toContain("totp_required");

    const users = readFileSync("public/users.html", "utf8");
    expect(users).toContain('id="totp-panel"');
    expect(readFileSync("public/users.js", "utf8")).toContain("initTotpSettings");

    const settings = readFileSync("public/totp-settings.js", "utf8");
    expect(settings).toContain("/api/v1/auth/totp/setup");
    expect(settings).toContain("/api/v1/auth/totp/disable");
    expect(settings).toContain("/api/v1/auth/totp/recovery");
    expect(settings).toContain("recovery_codes");
    expect(settings).not.toContain("console.log");
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
