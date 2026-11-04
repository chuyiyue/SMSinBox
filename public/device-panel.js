// Presentation rules for the device page. Secrets stay out of this module:
// the database stores only hashes, and nothing here can ask for plaintext again.

export function canRevealPushSecret() {
  // The push secret is stored server-side (0012), so the owner can view
  // the URL at any time; only legacy links predate the stored copy.
  return true;
}

export function pushActions(push) {
  if (push === "active") {
    return [
      { action: "rotate", label: "轮换接口" },
      { action: "revoke", label: "撤销接口" },
    ];
  }
  if (push === "revoked") {
    return [
      { action: "issue", label: "生成推送链接" },
      { action: "rotate", label: "轮换接口" },
    ];
  }
  return [{ action: "issue", label: "生成推送链接" }];
}

export function pushConfirm(action, name) {
  const safe = String(name || "").trim() || "该设备";
  if (action === "issue") {
    return `为「${safe}」生成推送链接？生成后可在「推送配置」里随时查看和复制。`;
  }
  if (action === "rotate") {
    return `轮换「${safe}」的推送链接？手机上的旧链接会立刻失效，新链接可在「推送配置」里随时查看。`;
  }
  if (action === "revoke") {
    return `撤销「${safe}」的推送链接？短信仍会保留。旧链接不会再显示。`;
  }
  return null;
}

export function platformFromReport(value) {
  const text = String(value ?? "").trim();
  if (!text) return { key: "unknown", label: "尚未上报" };
  if (/^ios$/i.test(text)) return { key: "ios", label: "iOS" };
  if (/^android$/i.test(text)) return { key: "android", label: "Android" };
  return { key: "reported", label: text };
}

export function platformBadge(platform) {
  if (platform?.key === "ios") return "iOS";
  if (platform?.key === "android") return "Android";
  if (platform?.key === "reported") return "其他";
  return "尚未上报";
}

export function platformDetail(platform) {
  if (platform?.key === "ios") return "iOS";
  if (platform?.key === "android") return "Android";
  if (platform?.key === "reported") return platform.label;
  return "尚未上报";
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
  const platform = platformFromReport(latest?.reported_device);
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

export function shortcutStatusLines() {
  return [
    "推荐：打开 iCloud 分享链接安装 SMSinBox Next（已签名）。导入后只填写推送链接。",
    "备用：设备页可下载未签名的 SMSinBox-iOS.shortcut；iOS 15 及更高版本可能拒绝导入。",
    "iCloud：https://www.icloud.com/shortcuts/cdfde24d823a43318ee651bb4d2c9494 。不要使用来路不明的其它分享链接。",
    "配置状态：本页看不到手机上的自动化开关。自动化里 content 必须用「信息 › 内容」，不要用「快捷指令输入」。收到 device 为 iOS 的短信后，设备卡片会写成「已收到 iOS 短信」。发送测试消息不会写成 iOS。",
  ];
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
  if (presence.key === "recent") return "在线";
  if (presence.key === "stale") return "离线";
  return "尚未上报";
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
