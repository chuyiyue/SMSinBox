// Presentation rules for the device page. Secrets stay out of this module:
// the database stores only hashes, and nothing here can ask for plaintext again.
import { t } from "./i18n.js";

export function canRevealPushSecret() {
  // The push secret is stored server-side (0012), so the owner can view
  // the URL at any time; only legacy links predate the stored copy.
  return true;
}

export function pushActions(push) {
  if (push === "active") {
    return [
      { action: "rotate", label: t("devices.rotateEndpoint") },
      { action: "revoke", label: t("devices.revokeEndpoint") },
    ];
  }
  if (push === "revoked") {
    return [
      { action: "issue", label: t("devices.issuePushLink") },
      { action: "rotate", label: t("devices.rotateEndpoint") },
    ];
  }
  return [{ action: "issue", label: t("devices.issuePushLink") }];
}

export function pushConfirm(action, name) {
  const safe = String(name || "").trim() || t("devices.thisDevice");
  if (action === "issue") {
    return t("devices.pushConfirmIssue", { name: safe });
  }
  if (action === "rotate") {
    return t("devices.pushConfirmRotate", { name: safe });
  }
  if (action === "revoke") {
    return t("devices.pushConfirmRevoke", { name: safe });
  }
  return null;
}

// Device types are operating systems (Roye: classify by OS, labels all in
// English), each with its own small icon in the sprite. The stored
// platform value is one of these keys; older values (phone / computer /
// router presets and OS aliases) fold into the same list.
export const DEVICE_TYPES = [
  { value: "android", label: "Android", icon: "icon-type-android" },
  { value: "ios", label: "iOS", icon: "icon-type-ios" },
  { value: "macos", label: "macOS", icon: "icon-type-macos" },
  { value: "windows", label: "Windows", icon: "icon-type-windows" },
  { value: "linux", label: "Linux", icon: "icon-type-linux" },
  { value: "openwrt", label: "OpenWrt", icon: "icon-type-openwrt" },
  { value: "other", label: "Other", icon: "icon-type-other" },
];

const TYPE_BY_VALUE = new Map(DEVICE_TYPES.map((type) => [type.value, type]));
const TYPE_ALIASES = {
  iphone: "ios",
  ipad: "ios",
  apple: "ios",
  mac: "macos",
  osx: "macos",
  darwin: "macos",
  win: "windows",
  router: "openwrt",
  phone: "other",
  computer: "other",
};

export function deviceTypeOf(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return null;
  return TYPE_BY_VALUE.get(TYPE_ALIASES[text] ?? text) ?? null;
}

export function platformFromReport(value) {
  const text = String(value ?? "").trim();
  if (!text) return { key: "unknown", label: t("devices.notReported"), icon: "icon-type-other" };
  const type = deviceTypeOf(text);
  if (type) return { key: type.value, label: type.label, icon: type.icon };
  return { key: "reported", label: text, icon: "icon-type-other" };
}

export function platformBadge(platform) {
  if (!platform || platform.key === "unknown") return t("devices.notReported");
  if (platform.key === "reported") return "Other";
  return platform.label;
}

export function platformDetail(platform) {
  if (!platform || platform.key === "unknown") return t("devices.notReported");
  return platform.label;
}

// The type chosen for the device (at creation, or later in the detail
// drawer's advanced settings). A specific choice is authoritative
// everywhere; reports only fill in for unset/Other (see describeDevice).
export function platformFromPreselect(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const type = deviceTypeOf(text);
  if (type) return { key: type.value, label: type.label, icon: type.icon };
  return { key: "reported", label: text, icon: "icon-type-other" };
}

// The sidebar only knows the stored platform (no message data), so its
// per-device icon comes from the preselected type alone.
export function sidebarDeviceIcon(device) {
  return deviceTypeOf(device?.platform)?.icon ?? "icon-type-other";
}

// The sidebar device list is a plain capped list: the owner's pinned
// devices when any exist, otherwise the first devices in list order.
// There is no "view all" row under it (Roye): the pin area is the list.
export const SIDEBAR_DEVICE_LIMIT = 5;

export function selectSidebarDevices(devices, limit = SIDEBAR_DEVICE_LIMIT) {
  const all = (devices || []).filter((device) => device && device.id);
  const pinned = all.filter((device) => device.pinned_at != null);
  const shown = (pinned.length ? pinned : all).slice(0, Math.max(0, limit));
  return { shown };
}

export function receiveTime(device, latest) {
  const at = Number(latest?.received_at);
  if (Number.isFinite(at) && at > 0) return { kind: "message", at };
  const seen = Number(device?.last_seen_at);
  if (Number.isFinite(seen) && seen > 0) return { kind: "seen-without-message", at: seen };
  return { kind: "none", at: null };
}

export function credentialBoxes(input) {
  const token = String(input?.token || "");
  const pushUrl = String(input?.pushUrl || "");
  return {
    showBearer: token.length > 0,
    showPush: pushUrl.length > 0,
    showBox: token.length > 0 || pushUrl.length > 0,
  };
}

export function latestByDevice(messages) {
  const map = new Map();
  for (const message of messages || []) {
    const id = message?.device_id;
    if (!id) continue;
    const at = Number(message.received_at) || 0;
    const prev = map.get(id);
    if (!prev || at >= (Number(prev.received_at) || 0)) map.set(id, message);
  }
  return map;
}

export function describeDevice(device, latest) {
  const push = device?.push === "active" || device?.push === "revoked" ? device.push : "none";
  // The type the owner chose wins (Roye): list, detail and sidebar must
  // all show the selected type. A reported type only supplies the answer
  // when nothing specific was chosen (unset, or Other).
  const reported = platformFromReport(latest?.reported_device);
  const chosen = platformFromPreselect(device?.platform);
  const platform = chosen && chosen.key !== "other"
    ? chosen
    : reported.key !== "unknown"
      ? reported
      : (chosen ?? reported);
  const received = receiveTime(device, latest);
  return {
    name: String(device?.name || ""),
    id: String(device?.id || ""),
    platform,
    platformBadge: platformBadge(platform),
    platformDetail: platformDetail(platform),
    received,
    actions: pushActions(push),
    pushUrl: push === "active" ? String(device?.push_url || "") : "",
  };
}

export function presenceDot(presence) {
  const status = presence.key === "recent" ? "ok" : presence.key === "stale" ? "warn" : "idle";
  const dot = document.createElement("span");
  dot.className = "ui-status";
  const point = document.createElement("span");
  point.className = "ui-status-dot";
  point.dataset.status = status;
  const label = document.createElement("span");
  label.textContent = presenceLabel(presence);
  dot.append(point, label);
  dot.title = presence.text;
  return dot;
}

export function presenceLabel(presence) {
  if (presence.key === "recent") return t("devices.online");
  if (presence.key === "stale") return t("devices.offline");
  return t("devices.notReported");
}

export function addFact(list, label, value, options = {}) {
  const wrap = document.createElement("div");
  if (options.wide) wrap.className = "span-2";
  const term = document.createElement("dt");
  term.textContent = label;
  const detail = document.createElement("dd");
  if (options.node) detail.append(options.node);
  else detail.textContent = value || "";
  if (options.title) detail.title = options.title;
  wrap.append(term, detail);
  list.append(wrap);
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// A last message older than a week makes the card/drawer show a stale note.
export function isStale(received) {
  if (!received?.at) return false;
  return Date.now() - received.at > WEEK_MS;
}
