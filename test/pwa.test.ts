import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MESSAGES } from "../public/i18n.js";

const PAGES = [
  "public/index.html",
  "public/devices.html",
  "public/notify.html",
  "public/api-mcp.html",
  "public/users.html",
  "public/login.html",
  "public/404.html",
];

function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("PWA shell", () => {
  it("serves a manifest with the required fields and both icon sizes", () => {
    const manifest = JSON.parse(readFileSync("public/manifest.json", "utf8"));
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { description: string };
    const tokens = readFileSync("public/css/tokens.css", "utf8");
    const base = readFileSync("public/css/base.css", "utf8");

    expect(manifest.name).toBe("SMSinBox");
    expect(manifest.short_name).toBe("SMSinBox");
    expect(manifest.description).toBe(pkg.description);
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    // Page background is var(--bg). The unscoped token, which base.css paints
    // before a dark theme or a dark color scheme applies, is #f7f7f8.
    expect(tokens).toMatch(/--bg:\s*#f7f7f8/);
    expect(base).toContain("background: var(--bg)");
    expect(manifest.background_color).toBe("#f7f7f8");
    expect(manifest.theme_color).toBe("#f7f7f8");

    const icons = manifest.icons as Array<{ src: string; sizes: string; type?: string; purpose?: string }>;
    const icon192 = icons.find((icon) => icon.sizes === "192x192");
    const icon512 = icons.find((icon) => icon.sizes === "512x512");
    expect(icon192).toMatchObject({ src: "/icon-192.png", sizes: "192x192", type: "image/png" });
    expect(icon512).toMatchObject({
      src: "/icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any maskable",
    });
    expect(pngSize(readFileSync("public/icon-192.png"))).toEqual({ width: 192, height: 192 });
    expect(pngSize(readFileSync("public/icon-512.png"))).toEqual({ width: 512, height: 512 });
  });

  it("keeps /api/ off the service worker cache", () => {
    const sw = readFileSync("public/sw.js", "utf8");
    expect(sw).toContain('const CACHE = "smsinbox-shell-v1"');
    expect(sw).toContain("skipWaiting");
    expect(sw).toContain("clients.claim");
    expect(sw).toContain('request.method !== "GET"');
    // Pass-through: an /api/ GET returns before respondWith, so it is never cached.
    const fetchHandler = sw.slice(sw.indexOf('addEventListener("fetch"'));
    const apiGate = fetchHandler.indexOf('url.pathname.startsWith("/api/")');
    const respond = fetchHandler.indexOf("event.respondWith");
    expect(apiGate).toBeGreaterThan(-1);
    expect(respond).toBeGreaterThan(apiGate);
    expect(fetchHandler.slice(apiGate, respond)).toContain("return");

    const shellJs = readdirSync("public").filter((name) => name.endsWith(".js") && name !== "sw.js");
    for (const file of shellJs) expect(sw, file).toContain(`"/${file}"`);
    expect(sw).toContain('"/vendor/qrcode.mjs"');
    for (const file of ["style.css", "css/base.css", "css/components.css", "css/pages.css", "css/shell.css", "css/tokens.css"]) {
      expect(sw).toContain(`"/${file}"`);
    }
    for (const file of ["logo.png", "icon-192.png", "icon-512.png", "icons.svg", "manifest.json"]) {
      expect(sw).toContain(`"/${file}"`);
    }
    const precache = sw.slice(sw.indexOf("const PRECACHE"), sw.indexOf("];"));
    expect(precache).not.toContain("sw.js");
  });

  it("links the manifest, theme color, and apple touch icon on every page", () => {
    for (const file of PAGES) {
      const html = readFileSync(file, "utf8");
      expect(html, file).toContain('<link rel="manifest" href="/manifest.json" />');
      expect(html, file).toContain('<meta name="theme-color" content="#f7f7f8" />');
      expect(html, file).toContain('<link rel="apple-touch-icon" href="/logo.png" />');
      expect(html, file).toContain('<script src="/pwa.js"></script>');
      const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
      expect(head.indexOf('src="/pwa.js"'), file).toBeGreaterThan(-1);
      expect(head.indexOf('src="/pwa.js"'), file).toBeLessThan(head.indexOf('src="/theme-boot.js"'));
    }
  });

  it("places the Create PWA control inside the features card, before the version card", () => {
    const html = readFileSync("public/users.html", "utf8");
    const buttonAt = html.indexOf('id="create-pwa"');
    const cardAt = html.indexOf('id="system-panel"');
    expect(buttonAt).toBeGreaterThan(-1);
    expect(cardAt).toBeGreaterThan(buttonAt);
    expect(html.indexOf('id="features-panel"')).toBeLessThan(buttonAt);
    expect(html).toContain('id="pwa-setting"');
    expect(html).not.toContain('id="pwa-panel"');
    const card = html.slice(cardAt);
    expect(card).toContain('data-i18n="users.version"');
    expect(card).not.toContain('id="create-pwa"');
    expect(html).toContain('data-i18n="users.createPwa"');
    expect(html).toContain("创建 PWA");
    expect(html).toContain('class="settings-section panel stack"');

    const js = readFileSync("public/users.js", "utf8");
    expect(js).toContain('querySelector("#create-pwa")');
    expect(js).toContain("window.__pwaInstall");
    expect(js).toContain("promptInstall");
    expect(js).toContain("users.pwaManualHint");
    expect(js).toContain("users.pwaIosHint");
  });

  it("adds the install copy in both locales without a trailing period", () => {
    const keys = ["users.createPwa", "users.pwaHint", "users.pwaInstalled", "users.pwaIosHint", "users.pwaManualHint"];
    expect(MESSAGES["zh-CN"]["users.createPwa"]).toBe("创建 PWA");
    expect(MESSAGES.en["users.createPwa"]).toBe("Create PWA");
    expect(MESSAGES["zh-CN"]["users.pwaInstalled"]).toBe("已安装");
    expect(MESSAGES.en["users.pwaInstalled"]).toBe("Installed");
    for (const key of keys) {
      expect(MESSAGES["zh-CN"][key].length, key).toBeGreaterThan(0);
      expect(MESSAGES.en[key].length, key).toBeGreaterThan(0);
      expect(MESSAGES["zh-CN"][key].endsWith("。"), key).toBe(false);
      expect(MESSAGES.en[key].endsWith("."), key).toBe(false);
    }
    expect(MESSAGES["zh-CN"]["users.pwaIosHint"]).toContain("分享");
    expect(MESSAGES.en["users.pwaIosHint"]).toContain("Share");
  });
});
