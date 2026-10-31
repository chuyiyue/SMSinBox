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
  has_secret: false,
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
    expect(waiting.hmac).toBe("未启用 HMAC");
    expect(waiting.shortcut).toContain("要在 iPhone 上确认");
    expect(waiting.id).toBe(DEVICE.id);

    const ios = describeDevice(
      { ...DEVICE, push: "active", has_secret: true, last_seen_at: 10 },
      { device_id: DEVICE.id, reported_device: "iOS", received_at: 20 },
    );
    expect(ios.platform.label).toBe("iOS");
    expect(ios.hmac).toBe("已启用 HMAC");
    expect(ios.received).toEqual({ kind: "message", at: 20 });
    expect(ios.shortcut).toContain("已收到 iOS 短信");
    expect(ios.shortcut).toContain("不能证明自动化仍然开着");

    const tested = describeDevice(DEVICE, {
      device_id: DEVICE.id,
      reported_device: DEVICE.name,
      received_at: 30,
    });
    expect(tested.shortcut).toContain("测试短信会写成设备名称");
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
  it("states the unsigned unified template and that iCloud is not published", () => {
    const lines = shortcutStatusLines();
    expect(lines).toHaveLength(4);
    expect(lines.join("\n")).toContain("SMSinBox-iOS.shortcut");
    expect(lines.join("\n")).toContain("只填写推送链接");
    expect(lines.join("\n")).toContain("未签名");
    expect(lines.join("\n")).toContain("尚未发布");
    expect(lines.join("\n")).not.toMatch(/icloud\.com/i);
    expect(lines.join("\n")).toContain("已收到 iOS 短信");
  });
});
