import {
  absoluteTime,
  api,
  flashLabel,
  formatTime,
  initShell,
  isUnauthorized,
  loadNav,
  logout,
  openMenu,
  openModal,
  showNotice,
  toast,
} from "./common.js";
import { ensureDevices, getDevices, noteDeviceSeen, refreshDevices } from "./device-store.js";
import { registerView } from "./shell.js";
import { credentialBoxes, describeDevice, pushConfirm, shortcutStatusLines } from "./device-panel.js";

const TEMPLATE = '{"from":"{{FROM}}","content":"{{SMS}}","timestamp":"{{RECEIVE_TIME}}","device":"{{DEVICE_NAME}}","sim":"{{CARD_SLOT}}"}';
const WEEK = 7 * 24 * 60 * 60 * 1000;
let form;
let errorBox;
let statusBox;
let tokenBox;
let bearerWrap;
let tokenValue;
let pushWrap;
let pushUrlValue;
let devices;
let dialog;
let savedBox;
let doneButton;
let formError;
let viewToken = 0;
const webhookUrl = `${location.origin}/api/v1/sms`;
const curlSample = [
  `curl -X POST '${webhookUrl}' \\`,
  "  -H 'Authorization: Bearer <token>' \\",
  "  -H 'Content-Type: application/json' \\",
  `  -d '{"from":"10086","content":"验证码 123456","device":"Android"}'`,
].join("\n");
let shownDeviceId = "";
let generation = 0;

function startView() {
  viewToken += 1;
  const token = viewToken;
  form = document.querySelector("#device-form");
  errorBox = document.querySelector("#device-error");
  statusBox = document.querySelector("#device-status");
  tokenBox = document.querySelector("#token-box");
  bearerWrap = document.querySelector("#bearer-wrap");
  tokenValue = document.querySelector("#token-value");
  pushWrap = document.querySelector("#push-wrap");
  pushUrlValue = document.querySelector("#push-url-value");
  devices = document.querySelector("#devices");
  dialog = document.querySelector("#device-dialog");
  savedBox = document.querySelector("#token-saved");
  doneButton = document.querySelector("#token-done");
  formError = form.querySelector(".field-error") || document.createElement("p");
  formError.className = "field-error";
  formError.hidden = true;
  form.querySelector(".modal-actions")?.before(formError);
  document.querySelector("#sms-url").textContent = webhookUrl;
  document.querySelector("#android-template").textContent = TEMPLATE;
  document.querySelector("#curl-sample").textContent = curlSample;
  fillShortcutStatus();
  bindTabs();
  initShell({
    onLogout: () => logout().catch(() => setError("退出失败")),
    onRefresh: () => loadDevices({ refresh: true }).catch((error) => {
      if (isUnauthorized(error)) return;
      setError("加载设备失败");
    }),
  });
  document.querySelector("#add-device").addEventListener("click", openCreate);
  document.querySelector("#copy-sms-url").addEventListener("click", (event) => {
    flashLabel(event.currentTarget, webhookUrl, "复制");
  });
  document.querySelector("#copy-template").addEventListener("click", (event) => {
    flashLabel(event.currentTarget, TEMPLATE, "复制模板");
  });
  document.querySelector("#copy-curl").addEventListener("click", (event) => {
    flashLabel(event.currentTarget, curlSample, "复制");
  });
  document.querySelector("#copy-token").addEventListener("click", async (event) => {
    const copied = await flashLabel(event.currentTarget, tokenValue.textContent || "", "复制 token");
    if (copied) toast("已复制");
  });
  document.querySelector("#copy-push-url").addEventListener("click", async (event) => {
    const copied = await flashLabel(event.currentTarget, pushUrlValue.textContent || "", "复制推送链接");
    if (copied) toast("已复制");
  });
  tokenValue.addEventListener("click", () => selectContents(tokenValue));
  pushUrlValue.addEventListener("click", () => selectContents(pushUrlValue));
  savedBox.addEventListener("change", () => {
    doneButton.disabled = !savedBox.checked;
  });
  doneButton.addEventListener("click", () => {
    if (!savedBox.checked) return;
    dialog.close();
  });
  document.querySelector("#device-cancel").addEventListener("click", () => {
    if (!tokenBox.hidden) return;
    dialog.close();
  });
  dialog.addEventListener("cancel", (event) => {
    if (!tokenBox.hidden) event.preventDefault();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    if (!tokenBox.hidden) return;
    dialog.close();
  });
  dialog.addEventListener("close", () => {
    document.body.classList.remove("modal-open");
    clearSecrets();
  });
  form.addEventListener("submit", submitDevice);
  loadDevices().catch((error) => {
    if (token !== viewToken || isUnauthorized(error)) return;
    setError("加载设备失败");
  });
  loadNav().catch((error) => {
    if (isUnauthorized(error)) return;
  });
  return () => {
    if (viewToken === token) viewToken += 1;
    generation += 1;
    if (dialog?.open) dialog.close();
  };
}

async function submitDevice(event) {
  event.preventDefault();
  const token = viewToken;
  setError("");
  showFormError("");
  const payload = new FormData(form);
  const name = String(payload.get("name") || "").trim();
  const secret = String(payload.get("secret") || "").trim();
  if (!name || name.length > 64) {
    showFormError("设备名称需要 1 到 64 个字符");
    return;
  }
  if (secret && (secret.length < 8 || secret.length > 256)) {
    showFormError("签名密钥需要 8 到 256 个字符");
    return;
  }
  const body = { name };
  if (secret) body.secret = secret;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  const previous = button.textContent;
  button.textContent = "添加中…";
  try {
    const result = await api("/api/v1/devices", { method: "POST", body: JSON.stringify(body) });
    if (token !== viewToken) return;
    if (!result.response.ok) {
      const message = result.data.error || "创建失败";
      showFormError(message);
      toast(message, { tone: "danger" });
      return;
    }
    showCredentials({
      deviceId: result.data.device?.id || "",
      token: result.data.token || "",
      pushUrl: result.data.push_url || "",
    });
    setStatus("请立刻复制黄框里的内容。刷新后不能再查看。");
    form.reset();
    await loadDevices({ refresh: true });
  } catch (error) {
    if (token !== viewToken || isUnauthorized(error)) return;
    showFormError("创建失败");
    toast("创建失败", { tone: "danger" });
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = previous;
    }
  }
}

function openCreate() {
  clearSecrets();
  form.hidden = false;
  showFormError("");
  document.querySelector("#device-dialog-title").textContent = "添加设备";
  if (!dialog.open) dialog.showModal();
  document.body.classList.add("modal-open");
  form.querySelector("input[name=name]")?.focus();
}

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

function bindTabs() {
  const tabs = [...document.querySelectorAll("[data-tab]")];
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      const name = tab.dataset.tab;
      for (const item of tabs) {
        const on = item.dataset.tab === name;
        item.classList.toggle("is-active", on);
        item.setAttribute("aria-selected", on ? "true" : "false");
      }
      for (const panel of document.querySelectorAll("[data-panel]")) {
        panel.hidden = panel.dataset.panel !== name;
      }
    });
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
  savedBox.checked = false;
  doneButton.disabled = true;
  const warn = tokenBox.querySelector(".callout");
  if (warn) {
    warn.textContent = boxes.showBearer
      ? "这个 token 只显示这一次，关闭后无法再次查看。"
      : "这条推送链接只显示这一次，关闭后无法再次查看。";
  }
  if (!boxes.showBox) return;
  form.hidden = true;
  document.querySelector("#device-dialog-title").textContent = "请保存这些密钥";
  if (!dialog.open) dialog.showModal();
  document.body.classList.add("modal-open");
  (boxes.showBearer ? document.querySelector("#copy-token") : document.querySelector("#copy-push-url"))?.focus();
}

function clearSecrets() {
  tokenValue.textContent = "";
  pushUrlValue.textContent = "";
  bearerWrap.hidden = true;
  pushWrap.hidden = true;
  tokenBox.hidden = true;
  form.hidden = false;
  savedBox.checked = false;
  doneButton.disabled = true;
}

async function loadDevices(options = {}) {
  const token = viewToken;
  const ticket = ++generation;
  if (!devices.querySelector(".device") && getDevices().length === 0) showSkeletons();
  try {
    const listResult = options.refresh ? await refreshDevices() : await ensureDevices();
    if (ticket !== generation || token !== viewToken || listResult.stale) return;
    const rows = getDevices();
    if (!listResult.ok && rows.length === 0) {
      showLoadError(listResult.error || "加载设备失败");
      return;
    }
    if (!listResult.ok) setError(listResult.error || "加载设备失败");
    else setError("");
    if (rows.length === 0) {
      renderDeviceList(rows, new Map());
      return;
    }
    if (!devices.querySelector(".device:not(.skeleton)")) renderDeviceList(rows, new Map());
    const latest = await loadLatest(rows);
    if (ticket !== generation || token !== viewToken) return;
    renderDeviceList(rows, latest);
  } catch (error) {
    if (ticket !== generation || token !== viewToken) return;
    if (isUnauthorized(error)) throw error;
    showLoadError("加载设备失败");
  }
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
    devices.append(emptyDevices());
    return;
  }
  for (const device of rows) devices.append(renderDevice(device, latest.get(device.id) || null));
}

function emptyDevices() {
  const wrap = document.createElement("div");
  wrap.className = "empty-state";
  const title = document.createElement("h2");
  title.className = "empty-title";
  title.textContent = "还没有设备";
  const text = document.createElement("p");
  text.textContent = "设备代表一部转发短信的手机。";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "添加第一台设备";
  button.addEventListener("click", openCreate);
  wrap.append(title, text, button);
  return wrap;
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
  if (view.hmac === "已启用 HMAC") {
    const lock = document.createElement("span");
    lock.className = "badge";
    lock.textContent = view.hmac;
    titleWrap.append(lock);
  }
  const pill = document.createElement("span");
  pill.className = "status-pill";
  pill.dataset.push = view.push;
  pill.textContent = view.pushLabel;
  const more = document.createElement("button");
  more.type = "button";
  more.className = "ghost icon-btn";
  more.setAttribute("aria-label", "更多操作");
  more.textContent = "⋯";
  more.addEventListener("click", () => {
    const items = view.actions.map((item) => ({
      label: item.label,
      danger: item.action === "revoke",
      onSelect: () => runPush(device, item.action),
    }));
    items.push({ label: "删除设备", danger: true, onSelect: () => removeDevice(device, row) });
    openMenu(more, items);
  });
  const trail = document.createElement("div");
  trail.className = "actions";
  trail.append(pill, more);
  head.append(titleWrap, trail);

  const facts = document.createElement("dl");
  facts.className = "device-facts";
  addFact(facts, "平台", view.platformDetail, { wide: true });
  addFact(facts, "设备 ID", null, { wide: true, node: idLine(view.id) });
  addFact(facts, "创建时间", formatTime(device.created_at), {
    title: device.created_at ? absoluteTime(device.created_at) : "",
  });
  addFact(facts, "最近一次短信", receiveText(view.received), {
    title: view.received.at ? absoluteTime(view.received.at) : "",
  });
  addFact(facts, "签名", view.hmac);
  addFact(facts, "推送链接", view.pushHint, { wide: true });
  addFact(facts, "快捷指令", view.shortcut, { wide: true });

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(testButton(device));
  const guide = document.createElement("a");
  guide.className = "button secondary";
  guide.href = "#ios-setup";
  guide.textContent = "安装说明";
  actions.append(guide);

  row.append(head);
  if (isStale(view.received)) {
    const note = document.createElement("p");
    note.className = "stale-note";
    note.textContent = "很久没有收到短信";
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
  if (received.kind === "seen-without-message") return `收件箱里已经没有短信。最近上报 ${formatTime(received.at)}`;
  return "还没有短信";
}

function isStale(received) {
  if (!received?.at) return false;
  return Date.now() - received.at > WEEK;
}

function testButton(device) {
  const test = document.createElement("button");
  test.type = "button";
  test.className = "secondary";
  test.textContent = "发送测试消息";
  test.addEventListener("click", async () => {
    test.disabled = true;
    const previous = test.textContent;
    test.textContent = "发送中…";
    setError("");
    try {
      const sent = await api(`/api/v1/devices/${device.id}/test`, { method: "POST", body: "{}" });
      if (!sent.response.ok) {
        const message = sent.data.error || "测试失败";
        setStatus("");
        setError(message);
        toast(message, { tone: "danger" });
        return;
      }
      const code = sent.data.code || "";
      const message = code ? `测试短信已写入收件箱（验证码 ${code}）` : "测试短信已写入收件箱";
      setError("");
      setStatus(message);
      toast(message, { href: "/", linkLabel: "去收件箱查看" });
      noteDeviceSeen(device.id, Date.now());
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
      toast("测试失败", { tone: "danger" });
    } finally {
      test.disabled = false;
      test.textContent = previous;
    }
  });
  return test;
}

async function removeDevice(device, row) {
  const name = String(device.name || "");
  const confirmed = await openModal({
    title: `删除设备「${name}」？`,
    text: "该设备已接收的所有短信也会被一并删除，无法恢复。",
    confirmLabel: "删除",
    danger: true,
    dismissible: false,
    requireText: name,
  });
  if (!confirmed) return;
  setError("");
  try {
    const deleted = await api(`/api/v1/devices/${device.id}`, { method: "DELETE" });
    if (!deleted.response.ok) {
      const message = deleted.data.error || "删除失败";
      setError(message);
      toast(message, { tone: "danger" });
      return;
    }
    if (shownDeviceId === device.id) shownDeviceId = "";
    row.classList.add("is-leaving");
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    await new Promise((resolve) => window.setTimeout(resolve, reduce ? 0 : 180));
    toast(`已删除「${name}」`);
    await loadDevices({ refresh: true });
  } catch (error) {
    if (isUnauthorized(error)) return;
    setError("删除失败");
    toast("删除失败", { tone: "danger" });
  }
}

async function runPush(device, action) {
  const message = pushConfirm(action, device.name);
  if (!message || !window.confirm(message)) return;
  setError("");
  try {
    const result = await api(`/api/v1/devices/${device.id}/push`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    if (!result.response.ok) {
      const text = result.data.error || "操作失败";
      setError(text);
      toast(text, { tone: "danger" });
      return;
    }
    if (result.data.push_url) {
      showCredentials({ deviceId: device.id, token: "", pushUrl: result.data.push_url });
      setStatus("请立刻复制黄框里的推送链接。刷新后不能再查看。");
    } else {
      if (shownDeviceId === device.id) shownDeviceId = "";
      if (action === "revoke") setStatus("推送链接已撤销。短信仍保留，旧链接不会再显示。");
    }
    await loadDevices({ refresh: true });
  } catch (error) {
    if (isUnauthorized(error)) return;
    setError("操作失败");
    toast("操作失败", { tone: "danger" });
  }
}

function showSkeletons() {
  devices.replaceChildren();
  for (let index = 0; index < 3; index += 1) {
    const card = document.createElement("div");
    card.className = "device skeleton";
    card.setAttribute("aria-hidden", "true");
    devices.append(card);
  }
}

function showLoadError(message) {
  const keep = Boolean(devices.querySelector(".device:not(.skeleton)"));
  setError(keep ? message : "");
  if (keep) return;
  devices.replaceChildren();
  const wrap = document.createElement("div");
  wrap.className = "empty-state";
  const text = document.createElement("p");
  text.textContent = message;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary";
  button.textContent = "重试";
  button.addEventListener("click", () => {
    loadDevices().catch((error) => {
      if (isUnauthorized(error)) return;
      setError("加载设备失败");
    });
  });
  wrap.append(text, button);
  devices.append(wrap);
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

function showFormError(message) {
  formError.hidden = !message;
  formError.textContent = message || "";
}

function setError(message) {
  showNotice(errorBox, message);
}

function setStatus(message) {
  showNotice(statusBox, message);
}

registerView("/devices.html", startView);
