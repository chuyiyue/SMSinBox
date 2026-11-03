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
import { deviceStateOf, ensureDevices, getDevices, noteDeviceSeen, refreshDevices } from "./device-store.js";
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
let savedBox;
let doneButton;
let formError;
let viewToken = 0;
const webhookUrl = `${location.origin}/api/v1/sms`;
const authHeader = "Authorization: Bearer <设备 token>";
const curlSample = [
  `curl -X POST '${webhookUrl}' \\`,
  "  -H 'Authorization: Bearer <token>' \\",
  "  -H 'Content-Type: application/json' \\",
  `  -d '{"from":"10086","content":"验证码 123456","device":"Android"}'`,
].join("\n");
let shownDeviceId = "";
let generation = 0;
// Expanded cards are kept per device id, so refreshing one card never closes
// another card and a deep link survives the first cached render.
const expandedIds = new Set();
let hashHandled = false;
let hashListener = null;

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
  savedBox = document.querySelector("#token-saved");
  doneButton = document.querySelector("#token-done");
  formError = form.querySelector(".field-error") || document.createElement("p");
  formError.className = "field-error";
  formError.hidden = true;
  form.after(formError);
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
    event.stopPropagation();
    flashLabel(event.currentTarget, webhookUrl, "复制地址");
  });
  document.querySelector("#copy-auth").addEventListener("click", (event) => {
    flashLabel(event.currentTarget, authHeader, "复制");
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
    clearSecrets();
  });
  form.addEventListener("submit", submitDevice);
  hashListener = () => {
    hashHandled = false;
    applyLocationHash();
  };
  window.addEventListener("hashchange", hashListener);
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
    if (hashListener) window.removeEventListener("hashchange", hashListener);
    hashListener = null;
  };
}

async function submitDevice(event) {
  event.preventDefault();
  const token = viewToken;
  setError("");
  showFormError("");
  const payload = new FormData(form);
  const name = String(payload.get("name") || "").trim();
  if (!name || name.length > 64) {
    showFormError("设备名称需要 1 到 64 个字符");
    return;
  }
  const body = { name };
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
  showFormError("");
  document.querySelector("#add")?.scrollIntoView({ block: "start", behavior: "smooth" });
  const input = form.querySelector("input[name=name]");
  input?.focus({ preventScroll: true });
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
      ? "这些凭证只显示这一次，关闭后无法再次查看。"
      : "这条推送链接只显示这一次，关闭后无法再次查看。";
  }
  if (!boxes.showBox) return;
  form.hidden = true;
  document.querySelector("#add")?.scrollIntoView({ block: "start", behavior: "smooth" });
  (boxes.showBearer ? document.querySelector("#copy-token") : document.querySelector("#copy-push-url"))?.focus({
    preventScroll: true,
  });
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

// page_size=1 keeps the request small; the same response also carries the
// reliable total used for the SMS count shown in the expanded card.
async function loadLatest(rows) {
  const found = new Map();
  await mapLimit(rows, 4, async (device) => {
    const result = await api(`/api/v1/messages?device_id=${encodeURIComponent(device.id)}&page_size=1`);
    if (!result.response.ok) return;
    const message = result.data.messages?.[0] || null;
    const total = Number(result.data.total);
    found.set(device.id, { message, total: Number.isFinite(total) ? total : null });
  });
  return found;
}

function renderDeviceList(rows, latest) {
  devices.replaceChildren();
  if (rows.length === 0) {
    devices.append(emptyDevices());
    applyLocationHash();
    return;
  }
  for (const device of rows) devices.append(renderDevice(device, latest.get(device.id) || null));
  applyLocationHash();
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

function renderDevice(device, entry) {
  const latest = entry?.message || null;
  const total = Number.isFinite(entry?.total) ? entry.total : null;
  const view = describeDevice(device, latest);
  const expanded = Boolean(view.id && expandedIds.has(view.id));
  const row = document.createElement("article");
  row.className = `device ${expanded ? "is-expanded" : "is-collapsed"}`;
  if (view.id) row.id = `dev-${view.id}`;
  if (view.id) row.dataset.deviceId = view.id;
  if (view.id && view.id === shownDeviceId) row.classList.add("is-highlighted");

  const bodyId = view.id ? `device-body-${view.id}` : "";
  const presence = deviceStateOf(device);
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
  const presencePill = document.createElement("span");
  presencePill.className = "status-pill device-presence";
  presencePill.dataset.state = presence.key;
  presencePill.title = presence.text;
  presencePill.textContent = presenceLabel(presence);
  titleWrap.append(title, badge, presencePill);

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "device-toggle";
  toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  if (bodyId) toggle.setAttribute("aria-controls", bodyId);
  const toggleLabel = document.createElement("span");
  toggleLabel.className = "device-toggle-label";
  toggleLabel.textContent = expanded ? "收起" : "展开";
  const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  chevron.setAttribute("class", "icon");
  chevron.setAttribute("viewBox", "0 0 24 24");
  chevron.setAttribute("aria-hidden", "true");
  const chevronPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  chevronPath.setAttribute("d", "M6 9l6 6 6-6");
  chevron.append(chevronPath);
  toggle.append(toggleLabel, chevron);
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    setExpanded(row, !expandedIds.has(view.id), view.id);
  });

  const trail = document.createElement("div");
  trail.className = "actions device-head-actions";
  trail.append(toggle);
  head.append(titleWrap, trail);
  head.addEventListener("click", (event) => {
    if (event.target.closest("button, a, input, select, textarea, summary")) return;
    setExpanded(row, !expandedIds.has(view.id), view.id);
  });

  const body = document.createElement("div");
  body.className = "device-body";
  if (bodyId) body.id = bodyId;
  body.hidden = !expanded;

  const facts = document.createElement("dl");
  facts.className = "device-facts";
  addFact(facts, "平台", view.platformDetail, { wide: true });
  addFact(facts, "创建时间", formatTime(device.created_at), {
    title: device.created_at ? absoluteTime(device.created_at) : "",
  });
  addFact(facts, "最近活动", receiveText(view.received), {
    title: view.received.at ? absoluteTime(view.received.at) : "",
  });
  if (total !== null) addFact(facts, "短信数量", `${total} 条`);
  addFact(facts, "推送链接", view.pushHint, { wide: true });
  addFact(facts, "快捷指令", view.shortcut, { wide: true });
  addFact(facts, "设备 ID", null, { wide: true, node: idLine(view.id) });

  const actions = document.createElement("div");
  actions.className = "actions device-actions";
  actions.append(testButton(device));
  const guide = document.createElement("a");
  guide.className = "button secondary";
  guide.href = "#ios-setup";
  guide.textContent = "安装说明";
  guide.addEventListener("click", (event) => {
    event.stopPropagation();
    const details = document.querySelector("#setup-details");
    if (details) details.open = true;
  });
  actions.append(guide);

  const more = document.createElement("button");
  more.type = "button";
  more.className = "secondary device-more";
  more.setAttribute("aria-label", "更多操作");
  more.textContent = "管理 ⋯";
  more.addEventListener("click", (event) => {
    event.stopPropagation();
    const items = view.actions.map((item) => ({
      label: item.label,
      danger: item.action === "revoke",
      onSelect: () => runPush(device, item.action),
    }));
    items.push({ label: "删除设备", danger: true, onSelect: () => removeDevice(device, row) });
    openMenu(more, items);
  });
  actions.append(more);

  if (isStale(view.received)) {
    const note = document.createElement("p");
    note.className = "stale-note";
    note.textContent = "很久没有收到短信";
    body.append(note);
  }
  body.append(facts, actions);
  row.append(head, body);
  return row;
}

function presenceLabel(presence) {
  if (presence.key === "recent") return "在线";
  if (presence.key === "stale") return "离线";
  return "尚未上报";
}

function setExpanded(row, expanded, id) {
  if (id) {
    if (expanded) expandedIds.add(id);
    else expandedIds.delete(id);
  }
  row.classList.toggle("is-expanded", expanded);
  row.classList.toggle("is-collapsed", !expanded);
  const body = row.querySelector(".device-body");
  if (body) body.hidden = !expanded;
  const toggle = row.querySelector(".device-toggle");
  if (toggle) {
    toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    const label = toggle.querySelector(".device-toggle-label");
    if (label) label.textContent = expanded ? "收起" : "展开";
  }
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
    event.stopPropagation();
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
  test.addEventListener("click", async (event) => {
    event.stopPropagation();
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
    expandedIds.delete(device.id);
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

// The sidebar's device contract is /devices.html#dev-<id>.
function hashDeviceId() {
  const raw = location.hash || "";
  if (!raw.startsWith("#dev-")) return "";
  try {
    return decodeURIComponent(raw.slice("#dev-".length));
  } catch {
    return raw.slice("#dev-".length);
  }
}

function applyLocationHash() {
  const hash = location.hash || "";
  if (hash === "#add") {
    if (hashHandled) return;
    hashHandled = true;
    openCreate();
    return;
  }
  if (hash === "#ios-setup" || hash === "#setup-details") {
    const details = document.querySelector("#setup-details");
    if (details) details.open = true;
    if (!hashHandled) {
      hashHandled = true;
      document.querySelector("#ios-setup")?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
    return;
  }
  const id = hashDeviceId();
  if (!id) return;
  const row = [...devices.querySelectorAll("[data-device-id]")].find(
    (node) => node.dataset.deviceId === id,
  );
  if (!row) return;
  if (!expandedIds.has(id)) setExpanded(row, true, id);
  row.classList.add("is-highlighted");
  if (hashHandled) return;
  hashHandled = true;
  row.scrollIntoView({ block: "start", behavior: "smooth" });
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
