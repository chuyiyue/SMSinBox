import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canRevealPushSecret,
  credentialBoxes,
  describeDevice,
  latestByDevice,
  platformFromPreselect,
  platformFromReport,
  selectSidebarDevices,
  pushActions,
  pushConfirm,
  receiveTime,
  shortcutStatusLines,
} from "../public/device-panel.js";

const DEVICE = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "我的 iPhone",
  created_at: 1,
  last_seen_at: null,
  push: "none" as const,
};

describe("device panel secrets", () => {
  it("reveals the stored push URL to the owner and keeps raw secrets out of the model", () => {
    expect(canRevealPushSecret()).toBe(true);
    const view = describeDevice(
      { ...DEVICE, push: "active", push_url: "https://sms.example/api/v1/ingest/psh_abc" },
      null,
    );
    expect(view.pushUrl).toBe("https://sms.example/api/v1/ingest/psh_abc");
    expect(view).not.toHaveProperty("token");
    expect(view).not.toHaveProperty("pushLabel");
    expect(view).not.toHaveProperty("shortcut");
  });

  it("shows the yellow-box credentials only when this response just returned them", () => {
    expect(credentialBoxes({ token: "", pushUrl: "" })).toEqual({
      showBearer: false,
      showPush: false,
      showBox: false,
    });
    expect(credentialBoxes({ token: "sms_once", pushUrl: "https://example/api/v1/ingest/psh_once" })).toEqual({
      showBearer: true,
      showPush: true,
      showBox: true,
    });
    expect(credentialBoxes({ token: "", pushUrl: "https://example/api/v1/ingest/psh_once" }).showBearer).toBe(false);
  });
});

describe("device panel status", () => {
  it("keeps the push actions that need confirmation", () => {
    expect(pushActions("none").map((item) => item.action)).toEqual(["issue"]);
    expect(pushActions("active").map((item) => item.action)).toEqual(["rotate", "revoke"]);
    expect(pushActions("revoked").map((item) => item.action)).toEqual(["issue", "rotate"]);
  });

  it("asks before generate, rotate, and revoke", () => {
    expect(pushConfirm("issue", "客厅")).toContain("客厅");
    expect(pushConfirm("issue", "客厅")).toContain("随时查看");
    expect(pushConfirm("rotate", "客厅")).toContain("旧链接会立刻失效");
    expect(pushConfirm("revoke", "客厅")).toContain("短信仍会保留");
    expect(pushConfirm("revoke", "  ")).toContain("该设备");
    expect(pushConfirm("delete", "客厅")).toBeNull();
  });

  it("reads platform from the latest reported device field", () => {
    expect(platformFromReport("")).toEqual({ key: "unknown", label: "尚未上报" });
    expect(platformFromReport("  iOS ")).toEqual({ key: "ios", label: "iOS" });
    expect(platformFromReport("android")).toEqual({ key: "android", label: "Android" });
    expect(platformFromReport("Pixel 8")).toEqual({ key: "reported", label: "Pixel 8" });
  });

  it("falls back to the creation-time preselected platform until a report arrives", () => {
    expect(platformFromPreselect("phone")).toEqual({ key: "preset", label: "手机" });
    expect(platformFromPreselect("computer")).toEqual({ key: "preset", label: "电脑" });
    expect(platformFromPreselect("router")).toEqual({ key: "preset", label: "路由器" });
    expect(platformFromPreselect("ios")).toEqual({ key: "ios", label: "iOS" });
    expect(platformFromPreselect("android")).toEqual({ key: "android", label: "Android" });
    expect(platformFromPreselect("other")).toBeNull();
    expect(platformFromPreselect("")).toBeNull();
    expect(platformFromPreselect(undefined)).toBeNull();

    const preset = describeDevice({ ...DEVICE, platform: "phone" }, null);
    expect(preset.platform).toEqual({ key: "preset", label: "手机" });
    expect(preset.platformBadge).toBe("手机");
    expect(preset.platformDetail).toBe("手机");

    // A report wins over the preselection; an empty report keeps it.
    const reported = describeDevice(
      { ...DEVICE, platform: "phone" },
      { device_id: DEVICE.id, reported_device: "iOS", received_at: 20 },
    );
    expect(reported.platform.key).toBe("ios");
    const silent = describeDevice(
      { ...DEVICE, platform: "router" },
      { device_id: DEVICE.id, reported_device: "", received_at: 20 },
    );
    expect(silent.platform).toEqual({ key: "preset", label: "路由器" });
  });

  it("caps the sidebar list at five and prefers pinned devices", () => {
    const mk = (id: string, pinned_at: number | null = null) => ({ id, pinned_at });
    const seven = ["a", "b", "c", "d", "e", "f", "g"].map((id) => mk(id));
    const plain = selectSidebarDevices(seven);
    expect(plain.shown.map((d) => d.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(plain.hasMore).toBe(true);

    const five = selectSidebarDevices(seven.slice(0, 5));
    expect(five.shown).toHaveLength(5);
    expect(five.hasMore).toBe(false);

    const pinned = selectSidebarDevices([mk("a"), mk("b", 3), mk("c"), mk("d", 1), mk("e"), mk("f"), mk("g")]);
    expect(pinned.shown.map((d) => d.id)).toEqual(["b", "d"]);
    expect(pinned.hasMore).toBe(true);

    expect(selectSidebarDevices([])).toEqual({ shown: [], hasMore: false });
    expect(selectSidebarDevices(null)).toEqual({ shown: [], hasMore: false });
  });

  it("shows concise device status values", () => {
    const waiting = describeDevice(DEVICE, null);
    expect(waiting.platform).toEqual({ key: "unknown", label: "尚未上报" });
    expect(waiting.platformBadge).toBe("尚未上报");
    expect(waiting.platformDetail).toBe("尚未上报");
    expect(waiting.received).toEqual({ kind: "none", at: null });
    expect(waiting.id).toBe(DEVICE.id);

    const ios = describeDevice(
      { ...DEVICE, push: "active", last_seen_at: 10 },
      { device_id: DEVICE.id, reported_device: "iOS", received_at: 20 },
    );
    expect(ios.platform.label).toBe("iOS");
    expect(ios.platformBadge).toBe("iOS");
    expect(ios.received).toEqual({ kind: "message", at: 20 });

    const tested = describeDevice(DEVICE, {
      device_id: DEVICE.id,
      reported_device: DEVICE.name,
      received_at: 30,
    });
    expect(tested.platformBadge).toBe("其他");
    expect(tested.platformDetail).toContain("我的 iPhone");
  });

  it("uses the latest received message or last-seen time for stale detection", () => {
    expect(receiveTime({ last_seen_at: 50 }, { received_at: 80 })).toEqual({ kind: "message", at: 80 });
    expect(receiveTime({ last_seen_at: 50 }, null)).toEqual({ kind: "seen-without-message", at: 50 });
    expect(receiveTime({ last_seen_at: null }, null)).toEqual({ kind: "none", at: null });
  });

  it("keeps the newest message for each device", () => {
    const map = latestByDevice([
      { device_id: "a", received_at: 1, reported_device: "old" },
      { device_id: "a", received_at: 5, reported_device: "iOS" },
      { device_id: "a", received_at: 5, reported_device: "iOS-later" },
      { device_id: "", received_at: 9, reported_device: "skip" },
    ]);
    expect(map.get("a")?.reported_device).toBe("iOS-later");
    expect(map.size).toBe(1);
  });
});

describe("shortcut version status", () => {
  it("recommends the published iCloud share and keeps an unsigned fallback", () => {
    const lines = shortcutStatusLines();
    expect(lines).toHaveLength(4);
    expect(lines.join("\n")).toContain("SMSinBox Next");
    expect(lines.join("\n")).toContain("只填写推送链接");
    expect(lines.join("\n")).toContain("未签名");
    expect(lines.join("\n")).toContain("icloud.com/shortcuts/cdfde24d823a43318ee651bb4d2c9494");
    expect(lines.join("\n")).toContain("信息 › 内容");
    expect(lines.join("\n")).not.toContain("尚未发布");
    expect(lines.join("\n")).toContain("已收到 iOS 短信");
  });
});

describe("devices page", () => {
  const html = readFileSync("public/devices.html", "utf8");
  // The detail drawer lives in device-detail.js (shared by every page);
  // the devices page's behavior spans both files.
  const js =
    readFileSync("public/devices.js", "utf8") + "\n" + readFileSync("public/device-detail.js", "utf8");
  const css = readFileSync("public/style.css", "utf8");
  const pagesCss = readFileSync("public/css/pages.css", "utf8");

  it("keeps the Cloud Mail shell, yellow box, and shortcut status", () => {
    expect(html).toContain('class="app-layout"');
    expect(html).toContain('class="sidebar"');
    expect(html).toContain('class="topbar"');
    expect(html).toContain('id="token-box" class="token-box stack"');
    expect(html).toContain("只显示这一次");
    expect(html).toContain("可随时在设备详情「推送配置」里查看");
    expect(html).toContain("版本与配置状态");
    expect(html).toContain('id="shortcut-status"');
    expect(html).toContain('href="/api/v1/ios/shortcut?variant=all"');
    expect(html).not.toMatch(/href="[^"]*variant=code/);
    expect(html).not.toContain("再显示一次");
    for (const line of shortcutStatusLines()) expect(html).toContain(line);
  });

  it("confirms generate, rotate, and revoke, and does not read a secret back", () => {
    expect(js).toContain("describeDevice");
    expect(js).toContain("await openModal({");
    expect(js).not.toContain("window.confirm");
    expect(js).toContain('api("/api/v1/devices"');
    expect(js).toContain("/api/v1/devices/${device.id}/push");
    expect(js).toContain("/api/v1/devices/${device.id}/test");
    expect(js).toContain("/api/v1/messages?device_id=");
    expect(js).toContain("复制推送链接");
    expect(js).toContain("复制 ID");
    expect(js).toContain("发送测试消息");
    // The setup guide no longer lives inside device cards; it has its own
    // tab on the devices page.
    expect(js).not.toContain("安装说明");
    expect(js).not.toContain("device.push_url");
    expect(js).not.toContain("再显示一次");
    expect(js).not.toMatch(/\/reveal/);
  });

  it("omits low-value device facts and status rows from every detail view", () => {
    expect(js).not.toContain('"创建时间"');
    expect(js).not.toContain('"最近活动"');
    expect(js).not.toContain('"快捷指令状态"');
    expect(js).not.toContain('"快捷指令",');
    expect(js).not.toContain('"推送状态"');
    expect(js).not.toContain("view.pushLabel");
    expect(js).not.toContain("view.shortcut");
  });

  it("keeps the yellow credential box and the phone breakpoints", () => {
    expect(readFileSync("public/css/tokens.css", "utf8")).toContain("--warn-bg: #fff7e8");
    expect(css).toMatch(/\.token-box \{ background: var\(--warn-bg\);/);
    expect(css).toContain(".device-facts");
    expect(css).toContain(".device.is-highlighted");
    expect(pagesCss).toContain("@media (max-width: 640px)");
    expect(css).toContain("@media (max-width: 380px)");
    expect(css).toMatch(/\[hidden\] \{ display: none !important; \}/);
    expect(css).not.toContain("--paper: #f3ecdf");
  });
});
