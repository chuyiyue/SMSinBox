import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canRevealPushSecret,
  credentialBoxes,
  describeDevice,
  latestByDevice,
  platformFromReport,
  pushActions,
  pushConfirm,
  pushLabel,
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
  it("never offers to reveal a stored push secret", () => {
    expect(canRevealPushSecret()).toBe(false);
    const view = describeDevice({ ...DEVICE, push: "active" }, null);
    expect(view).not.toHaveProperty("push_url");
    expect(view).not.toHaveProperty("token");
    expect(view.pushHint).toContain("不能再查看");
    expect(view.pushHint).toContain("轮换");
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
  it("labels push state and the actions that need confirmation", () => {
    expect(pushLabel("active")).toBe("推送链接有效");
    expect(pushLabel("revoked")).toBe("推送链接已撤销");
    expect(pushLabel("none")).toBe("未生成推送链接");
    expect(pushLabel(undefined)).toBe("未生成推送链接");
    expect(pushActions("none").map((item) => item.action)).toEqual(["issue"]);
    expect(pushActions("active").map((item) => item.action)).toEqual(["rotate", "revoke"]);
    expect(pushActions("revoked").map((item) => item.action)).toEqual(["issue", "rotate"]);
  });

  it("asks before generate, rotate, and revoke", () => {
    expect(pushConfirm("issue", "客厅")).toContain("客厅");
    expect(pushConfirm("issue", "客厅")).toContain("只显示一次");
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

  it("prefers the latest sms receive time over last_seen_at", () => {
    expect(receiveTime({ last_seen_at: 50 }, { received_at: 80 })).toEqual({ kind: "message", at: 80 });
    expect(receiveTime({ last_seen_at: 50 }, null)).toEqual({ kind: "seen-without-message", at: 50 });
    expect(receiveTime({ last_seen_at: null }, null)).toEqual({ kind: "none", at: null });
  });

  it("describes shortcut config without claiming the phone switch is visible", () => {
    const waiting = describeDevice(DEVICE, null);
    expect(waiting.platform).toEqual({ key: "unknown", label: "尚未上报" });
    expect(waiting.platformBadge).toBe("尚未上报");
    expect(waiting.platformDetail).toContain("会变成 iOS");
    expect(waiting.shortcut).toContain("要在 iPhone 上确认");
    expect(waiting.id).toBe(DEVICE.id);

    const ios = describeDevice(
      { ...DEVICE, push: "active", last_seen_at: 10 },
      { device_id: DEVICE.id, reported_device: "iOS", received_at: 20 },
    );
    expect(ios.platform.label).toBe("iOS");
    expect(ios.platformBadge).toBe("iOS");
    expect(ios.received).toEqual({ kind: "message", at: 20 });
    expect(ios.shortcut).toContain("已收到 iOS 短信");
    expect(ios.shortcut).toContain("不能证明自动化仍然开着");

    const tested = describeDevice(DEVICE, {
      device_id: DEVICE.id,
      reported_device: DEVICE.name,
      received_at: 30,
    });
    expect(tested.shortcut).toContain("测试短信会写成设备名称");
    expect(tested.platformBadge).toBe("其他");
    expect(tested.platformDetail).toContain("我的 iPhone");
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
  const js = readFileSync("public/devices.js", "utf8");
  const css = readFileSync("public/style.css", "utf8");
  const pagesCss = readFileSync("public/css/pages.css", "utf8");

  it("keeps the Cloud Mail shell, yellow box, and shortcut status", () => {
    expect(html).toContain('class="app-layout"');
    expect(html).toContain('class="sidebar"');
    expect(html).toContain('class="topbar"');
    expect(html).toContain('id="token-box" class="token-box"');
    expect(html).toContain("只显示这一次");
    expect(html).toContain("不能再显示明文");
    expect(html).toContain("版本与配置状态");
    expect(html).toContain('id="shortcut-status"');
    expect(html).toContain('href="/api/v1/ios/shortcut?variant=all"');
    expect(html).not.toMatch(/href="[^"]*variant=code/);
    expect(html).not.toContain("再显示一次");
    for (const line of shortcutStatusLines()) expect(html).toContain(line);
  });

  it("confirms generate, rotate, and revoke, and does not read a secret back", () => {
    expect(js).toContain("describeDevice");
    expect(js).toContain("if (!message || !window.confirm(message)) return;");
    expect(js).toContain('api("/api/v1/devices"');
    expect(js).toContain("/api/v1/devices/${device.id}/push");
    expect(js).toContain("/api/v1/devices/${device.id}/test");
    expect(js).toContain("/api/v1/messages?device_id=");
    expect(js).toContain("复制推送链接");
    expect(js).toContain("复制 ID");
    expect(js).toContain("发送测试消息");
    expect(js).toContain("安装说明");
    expect(js).not.toContain("device.push_url");
    expect(js).not.toContain("再显示一次");
    expect(js).not.toMatch(/\/reveal/);
  });

  it("keeps the yellow credential box and the phone breakpoints", () => {
    expect(css).toContain("--warn-bg: #fff7e8");
    expect(css).toMatch(/\.token-box \{ background: var\(--warn-bg\);/);
    expect(css).toContain(".device-facts");
    expect(css).toContain(".device.is-highlighted");
    expect(pagesCss).toContain("@media (max-width: 640px)");
    expect(css).toContain("@media (max-width: 380px)");
    expect(css).toMatch(/\[hidden\] \{ display: none !important; \}/);
    expect(css).not.toContain("--paper: #f3ecdf");
  });
});
