import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { copyBytes } from "../src/auth";
import { errorText } from "../src/log";

const pages = ["public/index.html", "public/devices.html", "public/notify.html", "public/api-mcp.html", "public/users.html"];

function navHrefs(html: string): string[] {
  const nav = html.match(/<nav class="sidebar-nav"[\s\S]*?<\/nav>/)?.[0] ?? "";
  return [...nav.matchAll(/href="([^"]+)"/g)].map((match) => match[1] ?? "");
}

function registryHrefs(registry: string): string[] {
  return [...registry.matchAll(/href: "([^"]+)"/g)].map((match) => match[1] ?? "");
}

describe("site consistency", () => {
  it("uses the same navigation and shell on every app page", () => {
    // The HTML shells carry no nav links: the boot renders them from the registry.
    const expected = ["/", "/devices.html", "/notify.html", "/api-mcp.html", "/users.html"];
    expect(registryHrefs(readFileSync("public/registry.js", "utf8"))).toEqual(expected);
    for (const file of pages) {
      const html = readFileSync(file, "utf8");
      expect(navHrefs(html)).toEqual([]);
      expect(html).toContain('class="app-layout"');
      expect(html).toContain('class="sidebar"');
      expect(html).toContain('id="sidebar-devices"');
      expect(html).toContain('src="/registry.js"');
      expect(html).toContain('src="/sidebar-boot.js"');
      expect(html).toContain('class="topbar"');
      expect(html).toContain('placeholder="搜索正文、号码或验证码"');
      expect(html).toContain('src="/logo.png"');
      expect(html).toContain("SMSinBox");
    }
  });

  it("styles the signed-out pages the same way", () => {
    for (const file of ["public/login.html", "public/404.html"]) {
      const html = readFileSync(file, "utf8");
      expect(html).toContain('class="auth-body"');
      expect(html).toContain('class="auth-card"');
      expect(html).toContain('class="brand"');
      expect(html).toContain('src="/logo.png"');
    }
  });

  it("keeps tab and segment hovers off the black accent button hover", () => {
    // .tab/.segment bases are transparent (specificity 0,1,0) and lose to the
    // generic button:hover accent (0,1,1) unless they declare their own
    // hover background — that is what turned tabs black on hover.
    const components = readFileSync("public/css/components.css", "utf8");
    expect(components).toContain(".tab:hover { background: var(--surface-hover); color: var(--text); }");
    expect(components).toContain(".segment:hover { background: var(--surface-hover); color: var(--text); }");
  });

  it("keeps shared colors on tokens and failed loads out of the empty state", () => {
    const css = readFileSync("public/style.css", "utf8");
    // Status banner colors live in the theme tokens: light literals in the
    // light block, soft-token derivations in the dark blocks. style.css only
    // consumes them and must not redefine them.
    const tokens = readFileSync("public/css/tokens.css", "utf8");
    expect(tokens).toContain("--danger-bg: #fde8e4");
    expect(tokens).toContain("--ok-bg: #e7f5ef");
    expect(tokens).toContain("--warn-bg: #fff7e8");
    expect(tokens).toContain("--danger-bg: var(--danger-soft)");
    expect(tokens).toContain("--ok-bg: var(--success-soft)");
    expect(tokens).toContain("--warn-bg: var(--warning-soft)");
    expect(css).not.toContain("--danger-bg:");
    expect(css).not.toContain("--ok-bg:");
    expect(css).not.toContain("--warn-bg:");
    expect(css).toContain("background: var(--danger-bg)");
    expect(css).toContain("background: var(--warn-bg)");
    expect(css).toContain(".device, .record");
    const devices = readFileSync("public/devices.js", "utf8");
    const notify = readFileSync("public/notify.js", "utf8");
    const users = readFileSync("public/users.js", "utf8");
    const apimcp = readFileSync("public/api-mcp.js", "utf8");
    expect(devices).toContain("if (!result.response.ok)");
    expect(notify).toContain("if (!result.response.ok)");
    expect(users).toContain("if (!result.response.ok)");
    expect(apimcp).toContain("if (!result.response.ok)");
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

  it("keeps the inbox filter bar, code chips and empty state on shared components", () => {
    const html = readFileSync("public/index.html", "utf8");
    const inbox = readFileSync("public/inbox.js", "utf8");
    const common = readFileSync("public/common.js", "utf8");
    const css = readFileSync("public/css/pages.css", "utf8");

    // The device and number controls live in one filter form; the search box
    // sits in the FilterBar beside the icon-only filter toggle and stays
    // bound to that form, so it remains visible when the form is sheeted.
    expect(html).toContain('class="filterbar"');
    expect(html).toMatch(/<form id="filters" class="filters"[\s\S]*name="device_id"[\s\S]*name="from"[\s\S]*<\/form>/);
    expect(html).toMatch(/id="open-filters"[^>]*aria-label="筛选"[\s\S]*?icons\.svg#icon-filter[\s\S]*?name="q" form="filters"/);

    // First-run and filtered-empty views use the shared EmptyState helper.
    expect(inbox).toContain("emptyState({");
    expect(inbox).not.toContain("function emptyState(");

    // Rows and the drawer share CodeChip's monospace value; the recognition
    // source is never labelled on a message.
    expect(inbox).toContain("CodeChip(message.code");
    expect(inbox).not.toContain("ui-codechip-source");
    expect(inbox).not.toContain('"正则识别"');
    expect(inbox).not.toContain('"AI 识别"');
    expect(common).not.toContain("ui-codechip-source");
    expect(common).not.toContain("codeSourceLabel");
    expect(css).toContain(".message-codechip");

    // Live arrivals may update the list but must not rebuild an open drawer.
    const live = inbox.match(/function onLiveMessage\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(live).toContain("prependMessage");
    expect(live).not.toContain("closeDrawer");
  });

  it("shows inbox item and detail times in absolute device-receive format", () => {
    const common = readFileSync("public/common.js", "utf8");
    const inbox = readFileSync("public/inbox.js", "utf8");
    expect(common).toContain("export function formatDateTime(ms)");
    expect(common).toContain("export function formatTime(ms)");
    expect(common).toMatch(/export function receivedStamp\(ms\)[\s\S]*?formatDateTime\(ms\)/);

    const timeNode = inbox.match(/function timeNode\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(timeNode).toContain("Number(message.received_at)");
    expect(timeNode).toContain("time.textContent = formatDateTime(at)");
    expect(timeNode).not.toContain("formatTime(");
    expect(timeNode).not.toContain("created_at");
    expect(inbox).toContain("receivedStamp(message.received_at)");
  });

  it("links sidebar devices to their device-page card and scrolls long device lists", () => {
    const common = readFileSync("public/common.js", "utf8");
    const css = readFileSync("public/css/pages.css", "utf8");
    const shellCss = readFileSync("public/css/shell.css", "utf8");
    expect(common).toContain('`/devices.html#dev-${encodeURIComponent(id)}`');
    expect(common).toContain('"/devices.html"');
    expect(common).toContain("还没有设备。");
    expect(common).not.toContain("sidebar-empty-add");
    expect(common).not.toContain('key: "all"');
    expect(shellCss).not.toContain(".sidebar-add-row");
    expect(readFileSync("public/sidebar-boot.js", "utf8")).not.toContain("relocateAddDeviceLink");
    expect(css).toMatch(/\.sidebar \.device-list \{[\s\S]*?max-height:[^;]+;[\s\S]*?overflow-y: auto;/);
    expect(css).toMatch(/\.sidebar \.sidebar-devices \{[\s\S]*?border-top:/);
  });

  it("places the collapse control beside the brand and keeps the device header controls aligned", () => {
    const boot = readFileSync("public/sidebar-boot.js", "utf8");
    const css = readFileSync("public/css/shell.css", "utf8");
    expect(boot).toContain('row.className = "sidebar-brand-row"');
    expect(css).toMatch(/\.sidebar-label-row \{[\s\S]*?margin: 0 12px 6px;/);
    expect(css).toMatch(/\.sidebar-section-toggle \{[\s\S]*?flex: 1 1 auto;/);
    // No add-device shortcut in the sidebar: adding happens on the devices
    // page, and the section toggle spans the full row on its own.
    expect(css).not.toContain(".sidebar-add");
    for (const page of pages) {
      expect(readFileSync(page, "utf8"), page).not.toContain("sidebar-add");
    }
    // The account entry centers the avatar and name inside its container.
    expect(css).toMatch(/\.account-btn \{[\s\S]*?display: flex;[\s\S]*?justify-content: center;/);
    expect(css).toMatch(/\.account-name \{[\s\S]*?text-align: center;/);
    expect(css).toMatch(/\.sidebar \.device-link \{[\s\S]*?padding: 6px 12px;/);
    expect(boot).toContain('button.setAttribute("aria-expanded", collapsed ? "false" : "true")');
    expect(css).toContain(":root[data-sidebar=\"collapsed\"] .sidebar-brand-row");
    expect(css).toContain(".sidebar-collapse { display: none; }");
    // The collapse control uses the panel glyph (no arrows anywhere), and
    // in the rail the logo takes over as the expand control: its mark
    // swaps for the panel icon on hover, the separate button hides, and
    // the account footer sinks to the bottom.
    expect(boot).toContain("/icons.svg#icon-panel-left");
    expect(boot).not.toContain("icon-chevron-left");
    expect(boot).toContain("brand-expand");
    expect(css).toContain(":root[data-sidebar=\"collapsed\"] .sidebar-collapse { display: none; }");
    expect(css).toContain(":root[data-sidebar=\"collapsed\"] .brand:hover .brand-expand");
    expect(css).toMatch(/:root\[data-sidebar="collapsed"\] \.sidebar-footer \{ margin-top: auto;/);
    expect(readFileSync("public/icons.svg", "utf8")).toContain('id="icon-panel-left"');
  });

  it("shares one aligned top-right cluster and shows no count next to add buttons", () => {
    const shellCss = readFileSync("public/css/shell.css", "utf8");
    expect(shellCss).toMatch(/\.topbar-actions > \* \{ height: 38px; \}/);
    for (const page of pages) {
      const html = readFileSync(page, "utf8");
      expect(html, page).not.toContain("count-pill");
      expect(html, page).not.toContain("token-count");
      expect(html, page).not.toContain("channel-count");
    }
    expect(readFileSync("public/api-mcp.js", "utf8")).not.toContain("tokenCountEl");
    expect(readFileSync("public/notify.js", "utf8")).not.toContain("channel-count");
  });

  it("gives the devices page a guide tab and keeps the guide out of device cards", () => {
    const html = readFileSync("public/devices.html", "utf8");
    const js = readFileSync("public/devices.js", "utf8");
    expect(html).toContain('id="dtab-guide"');
    expect(html).toContain("接入指引");
    expect(html).toContain('id="dpanel-guide"');
    expect(html).toContain('id="device-guide"');
    expect(js).toContain("buildPageGuide()");
    expect(js).not.toContain('"access", "接入配置"');
    expect(js).not.toMatch(/access\.append\(buildApiConfig/);
    expect(js).toMatch(/panels\.append\(overview, messages, push, advanced\)/);
    // The expanded card body is facts + actions only, and the API config is
    // built exactly once (its definition plus the page-guide call).
    expect(js).toContain("body.append(facts, actions);");
    expect(js.split("buildApiConfig()").length - 1).toBe(2);
    // Expanding one card must not stretch its grid row-mates.
    const pagesCss = readFileSync("public/css/pages.css", "utf8");
    expect(pagesCss).toMatch(/\.devices \{[^}]*align-items: start;/);
  });

  it("labels the admin entry as system management on every page", () => {
    // The admin nav entry is defined once in the registry with this title.
    const registry = readFileSync("public/registry.js", "utf8");
    expect(registry).toContain('key: "users", title: "系统管理"');
    expect(registry).not.toContain('title: "用户"');
    for (const file of pages) {
      const html = readFileSync(file, "utf8");
      // The admin entry now lives in the shared sidebar footer, not a mobile sheet.
      expect(html).toContain('<a class="account-btn" href="/users.html"');
      expect(html).toContain('aria-label="系统管理"');
      expect(html).toContain('<span class="account-name btn-label" id="sidebar-account-name">管理员</span>');
    }
  });

  it("drives the sidebar avatar from the profile username's GitHub avatar", () => {
    const common = readFileSync("public/common.js", "utf8");
    expect(common).toContain("profile_username");
    expect(common).toContain("https://github.com/${encodeURIComponent(profileUsername)}.png?s=96");
    const css = readFileSync("public/css/shell.css", "utf8");
    expect(css).toContain(".account-avatar img");
    expect(css).toContain("object-fit: cover");
  });

  it("renders the primary nav from a single registry", () => {
    const registry = readFileSync("public/registry.js", "utf8");
    expect(registry).toContain("window.SMSINBOX_MODULES");
    for (const text of ['key: "inbox"', 'title: "收件箱"', 'title: "设备列表"', 'title: "推送渠道"', 'title: "API 与 MCP"', 'title: "系统管理"']) {
      expect(registry).toContain(text);
    }
    for (const icon of ["icon-inbox", "icon-smartphone", "icon-bell", "icon-terminal", "icon-settings"]) {
      expect(registry).toContain(icon);
    }
    for (const script of ['script: "/inbox.js"', 'script: "/devices.js"', 'script: "/notify.js"', 'script: "/api-mcp.js"', 'script: "/users.js"']) {
      expect(registry).toContain(script);
    }
    expect(registryHrefs(registry)).toEqual(["/", "/devices.html", "/notify.html", "/api-mcp.html", "/users.html"]);

    // All five modules stay registered for routing, but system management is
    // the one module kept out of the nav: it is entered via the account
    // button in the sidebar footer instead.
    expect(registry).toMatch(/key: "users"[^}]*nav: false/);
    expect(registry.match(/, nav: false \}/g)).toHaveLength(1);

    // The boot renders the nav from the registry instead of its own list.
    const boot = readFileSync("public/sidebar-boot.js", "utf8");
    expect(boot).toContain("window.SMSINBOX_MODULES");
    expect(boot).not.toContain("var NAV_ITEMS = [");
    expect(boot).not.toContain('key: "inbox"');
    expect(boot).toContain("window.SMSINBOX_NAV");
    expect(boot).toContain("renderNav");
    // The nav (and SMSINBOX_NAV) only takes modules shown in the nav.
    expect(boot).toContain("item.nav !== false");

    // The account button carries the current-page state on /users.html,
    // marked at boot and re-marked by the shell on in-app navigation.
    expect(boot).toContain("markAccountEntry");
    const shellCss = readFileSync("public/css/shell.css", "utf8");
    expect(shellCss).toContain(".account-btn.active");

    // The shell generates its route map from the registry, not a literal map.
    const shell = readFileSync("public/shell.js", "utf8");
    expect(shell).toContain("SMSINBOX_MODULES");
    expect(shell).not.toContain('"/devices.html": "/devices.js"');
    expect(shell).not.toContain('"/users.html": "/users.js"');
    // ...and re-marks the account button as the current entry on /users.html.
    expect(shell).toContain('document.querySelector(".account-btn")');
    expect(shell).toContain('path === "/users.html"');

    // No page hardcodes nav links or a noscript fallback any more.
    for (const file of pages) {
      const nav = readFileSync(file, "utf8").match(/<nav class="sidebar-nav"[\s\S]*?<\/nav>/)?.[0] ?? "";
      expect(nav).not.toContain("<noscript>");
      expect(nav).not.toContain("href=");
    }
  });

  it("defines every referenced icon symbol in the shared sprite", () => {
    const sprite = readFileSync("public/icons.svg", "utf8");
    const defined = new Set([...sprite.matchAll(/<symbol id="(icon-[a-z-]+)"/g)].map((m) => m[1]));
    const referenced = new Set();
    const sources = [...pages, "public/login.html", "public/registry.js", "public/sidebar-boot.js", "public/common.js", "public/inbox.js", "public/devices.js", "public/notify.js"];
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/icons\.svg#(icon-[a-z-]+)/g)) referenced.add(m[1]);
      for (const m of text.matchAll(/icon: "(icon-[a-z-]+)"/g)) referenced.add(m[1]);
    }
    // The sprite is the single icon source: no referenced id may be missing,
    // and pages/scripts must not carry inline hand-drawn icon geometry.
    expect([...referenced].sort()).toEqual([...defined].sort());
    for (const file of [...pages, "public/login.html"]) {
      const html = readFileSync(file, "utf8");
      expect(html).not.toMatch(/<svg[^>]*>\s*<(path|circle|rect|polyline|line)/);
    }
  });

  it("renders the four-zone system page and drops the multi-user UI", () => {
    const html = readFileSync("public/users.html", "utf8");
    const js = readFileSync("public/users.js", "utf8");
    for (const id of ["account-panel", "sessions-panel", "totp-panel", "system-panel"]) {
      expect(html).toContain(`id="${id}"`);
    }
    for (const heading of ["管理员账号", "会话管理", "两步验证", "系统信息"]) {
      expect(html).toContain(heading);
    }
    expect(html).toContain("<title>系统管理 · SMSinBox</title>");
    expect(html).toContain('<h1 class="topbar-title">系统管理</h1>');
    // The only username surface is the display-only profile nickname form;
    // there is still no form that changes a login username.
    expect(html).not.toContain('id="username-form"');
    expect(html).toContain('id="profile-form"');
    expect(html).toContain('id="profile-username"');
    expect(html).toContain("仅用于显示与 GitHub 头像，不用于登录");
    expect(html).toContain('id="password-form"');
    expect(html).toContain('name="current_password"');
    expect(html).toContain('id="session-list"');
    expect(html).toContain('id="revoke-others"');
    expect(html).toContain('id="fact-version"');
    expect(html).toContain('id="fact-devices"');

    for (const gone of ['id="add-user"', 'id="user-table"', 'id="user-dialog"', 'id="user-form"']) {
      expect(html).not.toContain(gone);
    }
    expect(js).not.toContain("/api/v1/users");
    expect(js).not.toContain("/api/v1/auth/username");
    expect(js).toContain("/api/v1/auth/profile");
    expect(js).toContain("/api/v1/auth/password");
    expect(js).toContain("current_password");
    expect(js).toContain("/api/v1/auth/sessions");
    expect(js).toContain("/api/v1/auth/sessions/revoke-others");
    expect(js).toContain("initTotpSettings");
    expect(js).toContain("if (!result.response.ok)");

    // Mobile shows all four sections expanded in one scroll: there is no
    // list-to-detail folding, no back header, and no section is CSS-hidden.
    expect(html).not.toContain("settings-mobile-header");
    expect(html).not.toContain('id="settings-back"');
    expect(js).not.toContain("initMobileSettingsNav");
    expect(js).not.toContain("mobileSection");
    const css = readFileSync("public/css/pages.css", "utf8");
    // The in-page settings menu is gone entirely: sections stack in one
    // column with no anchor nav in the markup, styles, or script.
    expect(css).not.toContain(".settings-nav");
    expect(html).not.toContain("settings-nav");
    expect(js).not.toContain("initSettingsNav");
    expect(css).not.toContain(".settings-section.is-visible");
    expect(css).not.toMatch(/\.settings-section\s*\{[^}]*display:\s*none/);
  });

  it("loads the displayed version from package.json instead of hardcoding it", () => {
    const html = readFileSync("public/users.html", "utf8");
    const js = readFileSync("public/users.js", "utf8");
    const version = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
    expect(html).not.toContain(`>${version}<`);
    expect(html).toContain('<dd id="fact-version">读取中…</dd>');
    expect(html).not.toContain("静态信息");
    expect(html).not.toContain("package.json");
    expect(js).toContain('/api/v1/system/info');
    expect(js).toContain('querySelector("#fact-version")');
    expect(js).toContain("loadSystemInfo");
    expect(js).toContain("factVersion.textContent");
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

  it("routes /mcp to the worker before static assets", () => {
    const config = readFileSync("wrangler.jsonc", "utf8");
    const workerFirst = config.match(/"run_worker_first":\s*\[([^\]]*)\]/)?.[1] ?? "";
    expect(workerFirst).toContain('"/api/*"');
    expect(workerFirst).toContain('"/mcp"');
  });
});
