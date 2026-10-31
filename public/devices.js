import {
  api,
  emptyParagraph,
  flashLabel,
  formatTime,
  initShell,
  isUnauthorized,
  loadNav,
  logout,
  renderSidebarDevices,
  showNotice,
} from "./common.js";
import { credentialBoxes, describeDevice, pushConfirm, shortcutStatusLines } from "./device-panel.js";

const TEMPLATE = '{"from":"{{FROM}}","content":"{{SMS}}","timestamp":"{{RECEIVE_TIME}}","device":"{{DEVICE_NAME}}","sim":"{{CARD_SLOT}}"}';
const form = document.querySelector("#device-form");
const errorBox = document.querySelector("#device-error");
const statusBox = document.querySelector("#device-status");
const tokenBox = document.querySelector("#token-box");
const bearerWrap = document.querySelector("#bearer-wrap");
const tokenValue = document.querySelector("#token-value");
const pushWrap = document.querySelector("#push-wrap");
const pushUrlValue = document.querySelector("#push-url-value");
const devices = document.querySelector("#devices");
const webhookUrl = `${location.origin}/api/v1/sms`;
let shownDeviceId = "";

document.querySelector("#sms-url").textContent = webhookUrl;
document.querySelector("#android-template").textContent = TEMPLATE;
fillShortcutStatus();
initShell({
  onLogout: () => logout().catch(() => setError("退出失败")),
  onRefresh: () => loadDevices().catch(() => setError("加载设备失败")),
});
document.querySelector("#copy-template").addEventListener("click", async (event) => {
  await flashLabel(event.currentTarget, TEMPLATE, "复制模板");
});
document.querySelector("#copy-token").addEventListener("click", async (event) => {
  await flashLabel(event.currentTarget, tokenValue.textContent || "", "复制 token");
});
document.querySelector("#copy-push-url").addEventListener("click", async (event) => {
  await flashLabel(event.currentTarget, pushUrlValue.textContent || "", "复制推送链接");
});
tokenValue.addEventListener("click", () => selectContents(tokenValue));
pushUrlValue.addEventListener("click", () => selectContents(pushUrlValue));

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setError("");
  const payload = new FormData(form);
  const secret = String(payload.get("secret") || "").trim();
  const body = { name: String(payload.get("name") || "").trim() };
  if (secret) body.secret = secret;
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    const result = await api("/api/v1/devices", { method: "POST", body: JSON.stringify(body) });
    if (!result.response.ok) {
      setError(result.data.error || "创建失败");
      return;
    }
    showCredentials({
      deviceId: result.data.device?.id || "",
      token: result.data.token || "",
      pushUrl: result.data.push_url || "",
    });
    setStatus("请立刻复制黄框里的内容。刷新后不能再查看。");
    form.reset();
    await loadDevices();
  } catch (error) {
    if (isUnauthorized(error)) return;
    setError("创建失败");
  } finally {
    button.disabled = false;
  }
});

loadDevices().catch((error) => {
  if (isUnauthorized(error)) return;
  setError("加载设备失败");
});
loadNav().catch((error) => {
  if (isUnauthorized(error)) return;
});

function fillShortcutStatus() {
  const list = document.querySelector("#shortcut-status");
  if (!list) return;
  list.replaceChildren();
  for (const line of shortcutStatusLines()) {
    const item = document.createElement("li");
    item.textContent = line;
    list.append(item);
  }
}

function showCredentials({ deviceId, token, pushUrl }) {
  shownDeviceId = deviceId || "";
  tokenValue.textContent = token || "";
  pushUrlValue.textContent = pushUrl || "";
  const boxes = credentialBoxes({ token, pushUrl });
  bearerWrap.hidden = !boxes.showBearer;
  pushWrap.hidden = !boxes.showPush;
  tokenBox.hidden = !boxes.showBox;
  if (boxes.showBox) tokenBox.scrollIntoView({ block: "nearest" });
}

async function loadDevices() {
  const sidebar = document.querySelector("#sidebar-devices");
  if (sidebar) sidebar.dataset.loaded = "1";
  const result = await api("/api/v1/devices");
  if (!result.response.ok) {
    setError(result.data.error || "加载设备失败");
    return;
  }
  setError("");
  const rows = result.data.devices || [];
  renderSidebarDevices(rows);
  const latest = await loadLatest(rows);
  renderDeviceList(rows, latest);
}

async function loadLatest(rows) {
  const found = new Map();
  await mapLimit(rows, 4, async (device) => {
    const result = await api(`/api/v1/messages?device_id=${encodeURIComponent(device.id)}&page_size=1`);
    if (!result.response.ok) return;
    const message = result.data.messages?.[0];
    if (message) found.set(device.id, message);
  });
  return found;
}

function renderDeviceList(rows, latest) {
  devices.replaceChildren();
  if (rows.length === 0) {
    devices.append(emptyParagraph("还没有设备。"));
    return;
  }
  for (const device of rows) {
    devices.append(renderDevice(device, latest.get(device.id) || null));
  }
}

function renderDevice(device, latest) {
  const view = describeDevice(device, latest);
  const row = document.createElement("article");
  row.className = "device";
  if (view.id) row.dataset.deviceId = view.id;
  if (view.id && view.id === shownDeviceId) row.classList.add("is-highlighted");

  const head = document.createElement("div");
  head.className = "device-head";
  const titleWrap = document.createElement("div");
  titleWrap.className = "device-title";
  const title = document.createElement("strong");
  title.className = "device-name";
  title.textContent = view.name || "未命名设备";
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.dataset.platform = view.platform.key;
  badge.textContent = view.platformBadge;
  titleWrap.append(title, badge);
  const pill = document.createElement("span");
  pill.className = "status-pill";
  pill.dataset.push = view.push;
  pill.textContent = view.pushLabel;
  head.append(titleWrap, pill);

  const facts = document.createElement("dl");
  facts.className = "device-facts";
  addFact(facts, "平台", view.platformDetail, { wide: true });
  addFact(facts, "设备 ID", null, { wide: true, node: idLine(view.id) });
  addFact(facts, "最近一次短信", receiveText(view.received), {
    title: view.received.at ? absoluteTime(view.received.at) : "",
  });
  addFact(facts, "签名", view.hmac);
  addFact(facts, "推送链接", view.pushHint, { wide: true });
  addFact(facts, "快捷指令", view.shortcut, { wide: true });

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(testButton(device));
  for (const item of view.actions) actions.append(pushButton(device, item.action, item.label));
  const guide = document.createElement("a");
  guide.className = "button secondary";
  guide.href = "#ios-setup";
  guide.textContent = "安装说明";
  actions.append(guide, deleteButton(device));

  row.append(head);
  if (view.id && view.id === shownDeviceId && !pushWrap.hidden) {
    const note = document.createElement("p");
    note.className = "subtle";
    note.textContent = "一次性推送链接在上方黄框里，请立刻复制。";
    row.append(note);
  }
  row.append(facts, actions);
  return row;
}

function addFact(list, label, value, options = {}) {
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

function idLine(id) {
  const line = document.createElement("div");
  line.className = "device-id";
  const code = document.createElement("code");
  code.textContent = id;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary";
  button.textContent = "复制 ID";
  button.addEventListener("click", (event) => {
    flashLabel(event.currentTarget, id, "复制 ID");
  });
  line.append(code, button);
  return line;
}

function receiveText(received) {
  if (received.kind === "message") return formatTime(received.at);
  if (received.kind === "seen-without-message") {
    return `收件箱里已经没有短信。最近上报 ${formatTime(received.at)}`;
  }
  return "还没有短信";
}

function absoluteTime(ms) {
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

function testButton(device) {
  const test = document.createElement("button");
  test.type = "button";
  test.className = "secondary";
  test.textContent = "发送测试消息";
  test.addEventListener("click", async () => {
    test.disabled = true;
    setError("");
    try {
      const sent = await api(`/api/v1/devices/${device.id}/test`, { method: "POST", body: "{}" });
      if (!sent.response.ok) {
        setStatus("");
        setError(sent.data.error || "测试失败");
        return;
      }
      setError("");
      setStatus(`已写入收件箱，验证码 ${sent.data.code || ""}`);
      try {
        await loadDevices();
      } catch (error) {
        if (isUnauthorized(error)) return;
        setError("加载设备失败");
      }
    } catch (error) {
      if (isUnauthorized(error)) return;
      setStatus("");
      setError("测试失败");
    } finally {
      test.disabled = false;
    }
  });
  return test;
}

function deleteButton(device) {
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger";
  remove.textContent = "删除";
  remove.addEventListener("click", async () => {
    if (!window.confirm(`删除「${device.name}」及其短信？`)) return;
    setError("");
    try {
      const deleted = await api(`/api/v1/devices/${device.id}`, { method: "DELETE" });
      if (!deleted.response.ok) {
        setError(deleted.data.error || "删除失败");
        return;
      }
      if (shownDeviceId === device.id) showCredentials({ deviceId: "", token: "", pushUrl: "" });
      await loadDevices();
    } catch (error) {
      if (isUnauthorized(error)) return;
      setError("删除失败");
    }
  });
  return remove;
}

function pushButton(device, action, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = action === "revoke" ? "danger" : "secondary";
  button.textContent = label;
  button.addEventListener("click", async () => {
    const message = pushConfirm(action, device.name);
    if (!message || !window.confirm(message)) return;
    button.disabled = true;
    setError("");
    try {
      const result = await api(`/api/v1/devices/${device.id}/push`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      if (!result.response.ok) {
        setError(result.data.error || "操作失败");
        return;
      }
      if (result.data.push_url) {
        showCredentials({ deviceId: device.id, token: "", pushUrl: result.data.push_url });
        setStatus("请立刻复制黄框里的推送链接。刷新后不能再查看。");
      } else {
        if (shownDeviceId === device.id) showCredentials({ deviceId: "", token: "", pushUrl: "" });
        if (action === "revoke") setStatus("推送链接已撤销。短信仍保留，旧链接不会再显示。");
      }
      await loadDevices();
    } catch (error) {
      if (isUnauthorized(error)) return;
      setError("操作失败");
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

async function mapLimit(items, limit, fn) {
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const current = cursor;
      cursor += 1;
      await fn(items[current], current);
    }
  }
  const count = Math.min(limit, items.length);
  if (count === 0) return;
  await Promise.all(Array.from({ length: count }, () => worker()));
}

function selectContents(node) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
}

function setError(message) {
  showNotice(errorBox, message);
}

function setStatus(message) {
  showNotice(statusBox, message);
}
