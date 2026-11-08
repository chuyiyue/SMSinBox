import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MESSAGES } from "../public/i18n.js";
import {
  canRevealPushSecret,
  credentialBoxes,
  describeDevice,
  latestByDevice,
  platformFromPreselect,
  selectSidebarDevices,
  sidebarDeviceIcon,
  pushActions,
  pushConfirm,
  pushIdOf,
  receiveTime,
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

  it("shows the type saved on the device", () => {
    // Device types are operating systems with English labels; the retired
    // phone/computer presets fold into Other, routers into OpenWrt.
    expect(platformFromPreselect("phone")).toEqual({ key: "other", label: "Other", icon: "icon-type-other" });
    expect(platformFromPreselect("computer")).toEqual({ key: "other", label: "Other", icon: "icon-type-other" });
    expect(platformFromPreselect("router")).toEqual({ key: "openwrt", label: "OpenWrt", icon: "icon-type-openwrt" });
    expect(platformFromPreselect("ios")).toEqual({ key: "ios", label: "iOS", icon: "icon-type-ios" });
    expect(platformFromPreselect("android")).toEqual({ key: "android", label: "Android", icon: "icon-type-android" });
    expect(platformFromPreselect("macos")).toEqual({ key: "macos", label: "macOS", icon: "icon-type-macos" });
    expect(platformFromPreselect("linux")).toEqual({ key: "linux", label: "Linux", icon: "icon-type-linux" });
    expect(platformFromPreselect("other")).toEqual({ key: "other", label: "Other", icon: "icon-type-other" });
    expect(platformFromPreselect("")).toBeNull();
    expect(platformFromPreselect(undefined)).toBeNull();

    const preset = describeDevice({ ...DEVICE, platform: "macos" }, null);
    expect(preset.platform).toEqual({ key: "macos", label: "macOS", icon: "icon-type-macos" });
    expect(preset.platformBadge).toBe("macOS");
    expect(preset.platformDetail).toBe("macOS");

    const chosen = describeDevice(
      { ...DEVICE, platform: "android" },
      { device_id: DEVICE.id, received_at: 20 },
    );
    expect(chosen.platform.key).toBe("android");
    expect(chosen.platformBadge).toBe("Android");
    expect(chosen.platformDetail).toBe("Android");
    const folded = describeDevice(
      { ...DEVICE, platform: "router" },
      { device_id: DEVICE.id, received_at: 20 },
    );
    expect(folded.platform).toEqual({ key: "openwrt", label: "OpenWrt", icon: "icon-type-openwrt" });

    expect(sidebarDeviceIcon({ platform: "linux" })).toBe("icon-type-linux");
    expect(sidebarDeviceIcon({ platform: "router" })).toBe("icon-type-openwrt");
    expect(sidebarDeviceIcon({ platform: "" })).toBe("icon-type-other");
    expect(sidebarDeviceIcon(null)).toBe("icon-type-other");
  });

  it("ignores a reported device type on the latest message", () => {
    const latest = {
      device_id: DEVICE.id,
      reported_device: "iOS",
      received_at: 20,
    };
    const unset = describeDevice(DEVICE, latest);
    expect(unset.platform).toEqual({ key: "unknown", label: "尚未上报", icon: "icon-type-other" });
    expect(unset.platformBadge).toBe("尚未上报");
    expect(unset.platformDetail).toBe("尚未上报");
    expect(unset.platformDetail).not.toContain("iOS");
    // latest is still the source of the most recent receive time.
    expect(unset.received).toEqual({ kind: "message", at: 20 });

    const other = describeDevice({ ...DEVICE, platform: "other" }, latest);
    expect(other.platform).toEqual({ key: "other", label: "Other", icon: "icon-type-other" });
    expect(other.platformBadge).toBe("Other");
    expect(other.platformDetail).toBe("Other");

    const pixel = { ...latest, reported_device: "Pixel 8" };
    const phone = describeDevice({ ...DEVICE, platform: "phone" }, pixel);
    expect(phone.platform.key).toBe("other");
    expect(phone.platformDetail).toBe("Other");
    expect(phone.platformDetail).not.toContain("Pixel");

    const android = describeDevice({ ...DEVICE, platform: "android" }, latest);
    const quiet = describeDevice({ ...DEVICE, platform: "android" }, { device_id: DEVICE.id, received_at: 20 });
    expect(android.platform).toEqual(quiet.platform);
    expect(android.platformBadge).toBe("Android");
    expect(android.platformDetail).toBe("Android");
    expect(android.platformDetail).not.toContain("iOS");
  });

  it("caps the sidebar list at five and prefers pinned devices", () => {
    const mk = (id: string, pinned_at: number | null = null) => ({ id, pinned_at });
    const seven = ["a", "b", "c", "d", "e", "f", "g"].map((id) => mk(id));
    const plain = selectSidebarDevices(seven);
    expect(plain.shown.map((d) => d.id)).toEqual(["a", "b", "c", "d", "e"]);

    const five = selectSidebarDevices(seven.slice(0, 5));
    expect(five.shown).toHaveLength(5);

    const pinned = selectSidebarDevices([mk("a"), mk("b", 3), mk("c"), mk("d", 1), mk("e"), mk("f"), mk("g")]);
    expect(pinned.shown.map((d) => d.id)).toEqual(["b", "d"]);

    expect(selectSidebarDevices([])).toEqual({ shown: [] });
    expect(selectSidebarDevices(null)).toEqual({ shown: [] });
  });

  it("shows concise device status values", () => {
    const waiting = describeDevice(DEVICE, null);
    expect(waiting.platform).toEqual({ key: "unknown", label: "尚未上报", icon: "icon-type-other" });
    expect(waiting.platformBadge).toBe("尚未上报");
    expect(waiting.platformDetail).toBe("尚未上报");
    expect(waiting.received).toEqual({ kind: "none", at: null });
    expect(waiting.id).toBe(DEVICE.id);

    const ios = describeDevice(
      { ...DEVICE, platform: "ios", push: "active", last_seen_at: 10 },
      { device_id: DEVICE.id, received_at: 20 },
    );
    expect(ios.platform.label).toBe("iOS");
    expect(ios.platformBadge).toBe("iOS");
    expect(ios.platformDetail).toBe("iOS");
    expect(ios.received).toEqual({ kind: "message", at: 20 });

    const named = {
      device_id: DEVICE.id,
      reported_device: DEVICE.name,
      received_at: 30,
    };
    const tested = describeDevice({ ...DEVICE, platform: "other" }, named);
    expect(tested.platformBadge).toBe("Other");
    expect(tested.platformDetail).toBe("Other");
    expect(tested.platformDetail).not.toContain("我的 iPhone");
    expect(tested.received).toEqual({ kind: "message", at: 30 });
  });

  it("uses the latest received message or last-seen time for stale detection", () => {
    expect(receiveTime({ last_seen_at: 50 }, { received_at: 80 })).toEqual({ kind: "message", at: 80 });
    expect(receiveTime({ last_seen_at: 50 }, null)).toEqual({ kind: "seen-without-message", at: 50 });
    expect(receiveTime({ last_seen_at: null }, null)).toEqual({ kind: "none", at: null });
  });

  it("keeps the newest message for each device", () => {
    const later = { device_id: "a", received_at: 5 };
    const map = latestByDevice([
      { device_id: "a", received_at: 1 },
      { device_id: "a", received_at: 5 },
      later,
      { device_id: "", received_at: 9 },
    ]);
    expect(map.get("a")).toBe(later);
    expect(map.size).toBe(1);
  });
});

describe("setup guide", () => {
  const html = readFileSync("public/devices.html", "utf8");
  const js = readFileSync("public/devices.js", "utf8");

  it("recommends the published iCloud share and keeps an unsigned fallback", () => {
    expect(html).toContain("导入快捷指令");
    expect(html).toContain("icloud.com/shortcuts/f7880f724c5443aebffc1ab5c5b7788f");
    expect(html).toContain("未签名版文件");
    expect(html).toContain("信息 › 内容");
    expect(html).not.toContain("尚未发布");
    expect(html).toContain("设备类型以这里的选择为准，短信上报不会改变它");
    expect(html).toContain("（设备类型）不用再填：填了也会忽略，类型以服务端保存的选择为准");
    expect(html).toContain("不用再填：填了也会忽略，类型以服务端保存的选择为准");
    expect(html).toContain("设备类型以服务端保存的选择为准，短信上报不会改变它");
    expect(html).not.toContain("按上报");
    expect(html).not.toContain("已收到 iOS 短信");
    expect(MESSAGES["zh-CN"]["devices.typeNote"]).toBe("设备类型以这里的选择为准，短信上报不会改变它");
    expect(MESSAGES.en["devices.typeNote"]).toBe("The type is whatever is chosen here; message reports do not change it");
    expect(MESSAGES["zh-CN"]["devices.typePreviewNote"]).toBe(MESSAGES["zh-CN"]["devices.typeNote"]);
    expect(MESSAGES.en["devices.typePreviewNote"]).toBe(MESSAGES.en["devices.typeNote"]);
    expect(MESSAGES["zh-CN"]["guide.ios.legacy3d"]).toBe("（设备类型）不用再填：填了也会忽略，类型以服务端保存的选择为准");
    expect(MESSAGES.en["guide.ios.legacy3d"]).toBe(
      "no longer needs to be sent: it is ignored when present, and the type saved on the server wins",
    );
  });

  it("makes the guide's key values copy on click", () => {
    // Static values carry their copy payload inline.
    expect(html).toContain('class="copy-value" data-copy="https://www.icloud.com/shortcuts/f7880f724c5443aebffc1ab5c5b7788f"');
    expect(html).toContain('href="https://www.icloud.com/shortcuts/f7880f724c5443aebffc1ab5c5b7788f"');
    // Header name and value copy separately: the Shortcuts app takes
    // them in two different fields.
    expect(html).toContain('data-copy="Content-Type"');
    expect(html).toContain('data-copy="application/json"');
    expect(html).not.toContain('data-copy="Content-Type: application/json"');
    // Dynamic values are filled from the same constants as the API
    // config block, and every .copy-value is click-bound in the builder.
    expect(html).toContain('class="copy-value guide-sms-url"');
    expect(html).toContain('class="copy-value guide-auth"');
    expect(js).toContain('chip.dataset.copy = webhookUrl');
    expect(js).toContain('chip.dataset.copy = authHeader');
    expect(js).toContain('querySelectorAll(".copy-value")');
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
    expect(html).toContain("界面只显示 ID，点复制得到完整链接");
    expect(html).toContain('href="/api/v1/ios/shortcut?variant=all"');
    expect(html).not.toMatch(/href="[^"]*variant=code/);
    expect(html).not.toContain("再显示一次");
  });

  it("confirms generate, rotate, and revoke, and does not read a secret back", () => {
    expect(js).toContain("describeDevice");
    expect(js).toContain("await openModal({");
    expect(js).not.toContain("window.confirm");
    expect(js).toContain('api("/api/v1/devices"');
    expect(js).toContain("/api/v1/devices/${device.id}/push");
    expect(js).toContain("/api/v1/devices/${device.id}/test");
    expect(js).toContain("/api/v1/messages?device_id=");
    expect(js).toContain('t("devices.copyPushUrl")');
    expect(MESSAGES["zh-CN"]["devices.copyPushUrl"]).toBe("复制完整链接");
    expect(js).toContain('t("devices.copyId")');
    expect(MESSAGES["zh-CN"]["devices.copyId"]).toBe("复制 ID");
    expect(js).toContain('t("devices.sendTest")');
    expect(MESSAGES["zh-CN"]["devices.sendTest"]).toBe("发送测试消息");
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

describe("push link display", () => {
  const ID = "psh_abc123";
  const FULL = `https://sms.example/api/v1/ingest/${ID}`;
  const html = readFileSync("public/devices.html", "utf8");
  const detailJs = readFileSync("public/device-detail.js", "utf8");
  const devicesJs = readFileSync("public/devices.js", "utf8");

  it("extracts the push ID from the full link", () => {
    expect(pushIdOf(FULL)).toBe(ID);
    expect(pushIdOf(FULL)).not.toContain("/api/v1/ingest/");
    expect(pushIdOf(`${FULL}/`)).toBe(ID);
    expect(pushIdOf(`${FULL}?x=1`)).toBe(ID);
    expect(pushIdOf("")).toBe("");
  });

  it("shows only the ID in the device detail drawer and still copies the full link", () => {
    const view = describeDevice({ ...DEVICE, push: "active", push_url: FULL }, null);
    // What the drawer renders: the ID, never the full URL.
    expect(pushIdOf(view.pushUrl)).toBe(ID);
    expect(pushIdOf(view.pushUrl)).not.toContain("/api/v1/ingest/");
    // What the copy button uses: the complete link, ending with that ID.
    expect(view.pushUrl).toMatch(/^https:\/\//);
    expect(view.pushUrl.endsWith(ID)).toBe(true);

    expect(detailJs).toContain("code.textContent = pushIdOf(view.pushUrl)");
    expect(detailJs).not.toContain("code.textContent = view.pushUrl");
    expect(detailJs).toContain('flashLabel(event.currentTarget, view.pushUrl, t("devices.copyPushUrl"))');
  });

  it("shows only the ID in the add-device success view and copies the stored full link", () => {
    expect(devicesJs).toContain('pushUrlValue.textContent = pushUrl ? pushIdOf(pushUrl) : ""');
    expect(pushIdOf(FULL)).not.toContain("/api/v1/ingest/");
    expect(devicesJs).toContain('pushUrlValue.dataset.fullUrl = pushUrl || ""');
    // The copy handler reads the stored full link, not the rendered text.
    expect(devicesJs).toContain('const fullUrl = pushUrlValue.dataset.fullUrl || ""');
    expect(devicesJs).not.toContain("flashLabel(event.currentTarget, pushUrlValue.textContent");
    const copied = devicesJs.match(/const fullUrl = [^;]+;/)?.[0] || "";
    expect(copied).toContain("fullUrl");
    expect(FULL).toMatch(/^https:\/\//);
    expect(FULL.endsWith(ID)).toBe(true);
  });

  it("describes the ID-only display and full-link copy in both languages", () => {
    for (const key of ["devices.pushLink", "devices.pushLinkHint", "devices.copyPushUrl", "devices.copyLink"]) {
      expect(MESSAGES["zh-CN"][key], key).toBeTruthy();
      expect(MESSAGES.en[key], key).toBeTruthy();
      expect(MESSAGES["zh-CN"][key], key).not.toMatch(/[。.]$/);
      expect(MESSAGES.en[key], key).not.toMatch(/[。.]$/);
    }
    expect(MESSAGES["zh-CN"]["devices.pushLinkHint"]).toContain("只显示 ID");
    expect(MESSAGES["zh-CN"]["devices.pushLinkHint"]).toContain("完整链接");
    expect(MESSAGES.en["devices.pushLinkHint"]).toContain("only the ID");
    expect(MESSAGES.en["devices.pushLinkHint"]).toContain("full link");
    expect(html).toContain('data-i18n="devices.copyPushUrl">复制完整链接');
  });
});

