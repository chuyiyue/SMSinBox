import {
  CodeChip,
  absoluteTime,
  api,
  closeDrawer,
  flashLabel,
  formatTime,
  initShell,
  isUnauthorized,
  loadNav,
  logout,
  openDrawer,
  openMenu,
  openModal,
  showNotice,
  toast,
} from "./common.js";
import { deviceStateOf, ensureDevices, getDevices, noteDeviceSeen, refreshDevices } from "./device-store.js";
import { registerView } from "./shell.js";
import { credentialBoxes, describeDevice, pushConfirm } from "./device-panel.js";

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
let addBody;
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
  devices = document.querySelector("#devices");
  errorBox = document.querySelector("#device-error");
  statusBox = document.querySelector("#device-status");
  addBody = buildAddBody();
  initShell({
    onLogout: () => logout().catch(() => setError("退出失败")),
    onRefresh: () => loadDevices({ refresh: true }).catch((error) => {
      if (isUnauthorized(error)) return;
      setError("加载设备失败");
    }),
  });
  document.querySelector("#add-device").addEventListener("click", openCreate);
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
    closeDrawer();
  };
}

function cloneTemplate(id) {
  const template = document.querySelector(id);
  return template?.content.firstElementChild?.cloneNode(true) || null;
}

function buildAddBody() {
  const section = cloneTemplate("#add-device-template");
  form = section.querySelector("#device-form");
  tokenBox = section.querySelector("#token-box");
  bearerWrap = section.querySelector("#bearer-wrap");
  tokenValue = section.querySelector("#token-value");
  pushWrap = section.querySelector("#push-wrap");
  pushUrlValue = section.querySelector("#push-url-value");
  savedBox = section.querySelector("#token-saved");
  doneButton = section.querySelector("#token-done");
  formError = section.querySelector(".field-error") || document.createElement("p");
  formError.className = "field-error";
  formError.hidden = true;
  form.after(formError);

  section.querySelector("#copy-token").addEventListener("click", async (event) => {
    const copied = await flashLabel(event.currentTarget, tokenValue.textContent || "", "复制 token");
    if (copied) toast("已复制");
  });
  section.querySelector("#copy-push-url").addEventListener("click", async (event) => {
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

  section.append(buildSetupFold());
  return section;
}

function buildApiConfig() {
  const node = cloneTemplate("#api-config-template");
  node.querySelector("#sms-url").textContent = webhookUrl;
  node.querySelector("#android-template").textContent = TEMPLATE;
  node.querySelector("#curl-sample").textContent = curlSample;
  bindCopy(node, "#copy-sms-url", webhookUrl, "复制地址");
  bindCopy(node, "#copy-auth", authHeader, "复制");
  bindCopy(node, "#copy-template", TEMPLATE, "复制模板");
  bindCopy(node, "#copy-curl", curlSample, "复制");
  return node;
}

function buildSetupFold() {
  const node = cloneTemplate("#setup-guide-template");
  bindTabs(node);
  return node;
}

function bindCopy(scope, selector, value, label) {
  const button = scope.querySelector(selector);
  if (!button) return;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    flashLabel(event.currentTarget, value, label);
  });
}

function bindTabs(scope) {
  const tabs = [...scope.querySelectorAll("[data-tab]")];
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      const name = tab.dataset.tab;
      for (const item of scope.querySelectorAll("[data-tab]")) {
        const on = item.dataset.tab === name;
        item.classList.toggle("is-active", on);
        item.setAttribute("aria-selected", on ? "true" : "false");
      }
      for (const panel of scope.querySelectorAll("[data-panel]")) {
        panel.hidden = panel.dataset.panel !== name;
      }
    });
  }
}

let deviceDetailState = null;

function openDeviceDetail(device, entry = null) {
  const id = String(device?.id || "");
  const row = findDeviceRow(id);
  if (row) row.classList.add("is-highlighted");
  closeDeviceDetail();
  const root = document.createElement("div");
  root.className = "ui-drawer device-detail-drawer";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  const overlay = document.createElement("button");
  overlay.type = "button";
  overlay.className = "ui-drawer-overlay";
  overlay.setAttribute("aria-label", "关闭设备详情");
  overlay.addEventListener("click", closeDeviceDetail);

  const panel = document.createElement("div");
  panel.className = "ui-drawer-panel device-detail-panel";

  const head = document.createElement("header");
  head.className = "device-detail-header";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "secondary device-detail-back";
  back.textContent = "返回列表";
  back.addEventListener("click", closeDeviceDetail);
  const text = document.createElement("div");
  text.className = "device-detail-heading";
  const title = document.createElement("h2");
  title.className = "ui-drawer-title";
  title.textContent = String(device?.name || "未命名设备");
  const meta = document.createElement("p");
  meta.className = "device-detail-meta-line";
  const presence = deviceStateOf(device);
  meta.textContent = `${presenceLabel(presence)} · ${describeDevice(device, entry?.message || null).platformBadge}`;
  text.append(title, meta);
  head.append(back, text);

  const body = document.createElement("div");
  body.className = "ui-drawer-body device-detail-body";
  body.append(buildDeviceDetailShell(device, entry));

  panel.append(head, body);
  root.append(overlay, panel);
  document.body.append(root);
  document.body.classList.add("drawer-open");

  const onKey = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDeviceDetail();
    }
  };
  document.addEventListener("keydown", onKey, true);
  deviceDetailState = { root, onKey, id };
  const firstTab = panel.querySelector("[data-device-tab]");
  firstTab?.click();
  const initialFocus = panel.querySelector("button, input, select, textarea, a[href]") || back;
  initialFocus?.focus({ preventScroll: true });
}

function closeDeviceDetail() {
  if (!deviceDetailState) return;
  const { root, onKey, id } = deviceDetailState;
  document.removeEventListener("keydown", onKey, true);
  root.remove();
  document.body.classList.remove("drawer-open");
  deviceDetailState = null;
  if (id) {
    const active = findDeviceRow(id);
    active?.classList.remove("is-highlighted");
  }
}

function buildDeviceDetailShell(device, entry = null) {
  const detail = document.createElement("div");
  detail.className = "device-detail-shell";
  const latest = entry?.message || null;
  const total = Number.isFinite(entry?.total) ? entry.total : null;
  const view = describeDevice(device, latest);

  const summary = document.createElement("div");
  summary.className = "device-detail-summary";
  const status = document.createElement("div");
  status.className = "device-detail-status";
  status.append(presenceDot(deviceStateOf(device)));
  const factList = document.createElement("dl");
  factList.className = "device-facts";
  addFact(factList, "平台", view.platformDetail, { wide: true });
  addFact(factList, "创建时间", formatTime(device.created_at), {
    title: device.created_at ? absoluteTime(device.created_at) : "",
  });
  addFact(factList, "最近活动", receiveText(view.received), {
    title: view.received.at ? absoluteTime(view.received.at) : "",
  });
  if (total !== null) addFact(factList, "短信数量", `${total} 条`);
  addFact(factList, "设备 ID", null, { wide: true, node: idLine(device.id) });
  addFact(factList, "推送链接", view.pushHint, { wide: true });
  addFact(factList, "快捷指令状态", view.shortcut, { wide: true });
  status.append(factList);
  summary.append(status);

  const tabs = document.createElement("div");
  tabs.className = "tabs device-detail-tabs";
  const labels = [
    ["overview", "概览"],
    ["messages", "短信记录"],
    ["access", "接入配置"],
    ["push", "推送配置"],
    ["advanced", "高级设置"],
  ];
  for (const [key, label] of labels) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = `tab ${key === "overview" ? "is-active" : ""}`;
    tab.dataset.deviceTab = key;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", key === "overview" ? "true" : "false");
    tab.textContent = label;
    tabs.append(tab);
  }

  const panels = document.createElement("div");
  panels.className = "device-detail-panels";
  const overview = document.createElement("section");
  overview.className = "device-detail-panel";
  overview.dataset.devicePanel = "overview";
  overview.append(buildOverviewPanel(device, view, total));
  const messages = document.createElement("section");
  messages.className = "device-detail-panel";
  messages.dataset.devicePanel = "messages";
  messages.hidden = true;
  void loadDeviceMessagePanel(messages, device.id);
  const access = document.createElement("section");
  access.className = "device-detail-panel";
  access.dataset.devicePanel = "access";
  access.hidden = true;
  access.append(buildApiConfig(), buildSetupFold());
  const push = document.createElement("section");
  push.className = "device-detail-panel";
  push.dataset.devicePanel = "push";
  push.hidden = true;
  push.append(buildPushPanel(device, view));
  const advanced = document.createElement("section");
  advanced.className = "device-detail-panel";
  advanced.dataset.devicePanel = "advanced";
  advanced.hidden = true;
  advanced.append(buildAdvancedPanel(device));

  panels.append(overview, messages, access, push, advanced);
  detail.append(summary, tabs, panels);
  for (const tab of tabs.querySelectorAll("[data-device-tab]")) {
    tab.addEventListener("click", () => {
      const name = tab.dataset.deviceTab;
      for (const item of tabs.querySelectorAll("[data-device-tab]")) {
        const active = item.dataset.deviceTab === name;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-selected", active ? "true" : "false");
      }
      for (const panel of panels.querySelectorAll("[data-device-panel]")) {
        panel.hidden = panel.dataset.devicePanel !== name;
      }
    });
  }
  return detail;
}

function buildOverviewPanel(device, view, total) {
  const panel = document.createElement("div");
  panel.className = "stack device-detail-stack";
  const actions = document.createElement("div");
  actions.className = "actions device-detail-actions";
  actions.append(testButton(device));
  for (const action of view.actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = action.action === "revoke" ? "danger" : "secondary";
    button.textContent = action.label;
    button.addEventListener("click", () => runPush(device, action.action));
    actions.append(button);
  }
  panel.append(actions);

  const summary = document.createElement("div");
  summary.className = "device-detail-card";
  const heading = document.createElement("h3");
  heading.textContent = "状态概览";
  const meta = document.createElement("dl");
  meta.className = "device-facts";
  addFact(meta, "设备名称", device.name || "未命名设备", { wide: true });
  addFact(meta, "最近状态", presenceLabel(deviceStateOf(device)), { wide: true });
  addFact(meta, "平台", view.platformBadge, { wide: true });
  if (total !== null) addFact(meta, "短信数", `${total} 条`, { wide: true });
  addFact(meta, "推送状态", view.pushLabel, { wide: true });
  summary.append(heading, meta);
  panel.append(summary);
  return panel;
}

async function loadDeviceMessagePanel(panel, deviceId) {
  const wrapper = document.createElement("div");
  wrapper.className = "device-message-list";
  panel.append(wrapper);
  try {
    const result = await api(`/api/v1/messages?device_id=${encodeURIComponent(deviceId)}&page_size=20&page=1`);
    if (!result.response.ok) {
      wrapper.replaceChildren();
      const message = document.createElement("p");
      message.className = "empty subtle";
      message.textContent = result.data.error || "无法加载短信记录";
      wrapper.append(message);
      return;
    }
    const messages = Array.isArray(result.data.messages) ? result.data.messages : [];
    wrapper.replaceChildren();
    if (messages.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty subtle";
      empty.textContent = "暂无短信记录";
      wrapper.append(empty);
      return;
    }
    for (const message of messages) {
      const item = document.createElement("article");
      item.className = "device-message-item";
      const sender = document.createElement("div");
      sender.className = "device-message-head";
      const who = document.createElement("strong");
      who.textContent = message.from_number || "未知号码";
      const time = document.createElement("span");
      time.className = "subtle";
      time.textContent = message.received_at ? formatTime(Number(message.received_at)) : "刚刚";
      sender.append(who, time);
      const content = document.createElement("p");
      content.className = "device-message-body";
      content.textContent = message.content || "（空白内容）";
      item.append(sender, content);
      if (message.code) {
        const chipWrap = document.createElement("div");
        chipWrap.className = "device-message-code";
        chipWrap.append(CodeChip(message.code, message.code_source));
        item.append(chipWrap);
      }
      wrapper.append(item);
    }
  } catch {
    wrapper.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "empty subtle";
    empty.textContent = "加载短信记录失败";
    wrapper.append(empty);
  }
}

function buildPushPanel(device, view) {
  const panel = document.createElement("div");
  panel.className = "stack device-detail-stack";
  const summary = document.createElement("div");
  summary.className = "device-detail-card";
  const title = document.createElement("h3");
  title.textContent = "推送配置";
  const strong = document.createElement("p");
  strong.className = "device-detail-value";
  strong.textContent = view.pushLabel;
  const actions = document.createElement("div");
  actions.className = "actions device-detail-actions";
  for (const action of view.actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = action.action === "revoke" ? "danger" : "secondary";
    button.textContent = action.label;
    button.addEventListener("click", () => runPush(device, action.action));
    actions.append(button);
  }
  summary.append(title, strong, actions);
  panel.append(summary);
  return panel;
}

function buildAdvancedPanel(device) {
  const panel = document.createElement("div");
  panel.className = "stack device-detail-stack";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger";
  remove.textContent = "删除设备";
  remove.addEventListener("click", () => removeDevice(device, findDeviceRow(device.id)));
  panel.append(remove);
  return panel;
}

function findDeviceRow(id) {
  const box = document.querySelector("#devices");
  return [...(box?.querySelectorAll("[data-device-id]") || [])].find(
    (node) => (node.getAttribute("data-device-id") || "") === String(id || ""),
  );
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
  openDrawer({ title: "添加设备", bodyHTML: addBody });
  const input = addBody.querySelector("input[name=name]");
  input?.focus({ preventScroll: true });
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
  (boxes.showBearer ? tokenBox.querySelector("#copy-token") : tokenBox.querySelector("#copy-push-url"))?.focus({
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
  titleWrap.append(title, badge, presenceDot(presence));

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
    openDeviceDetail(device, entry);
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
  addFact(facts, "推送链接", view.pushLabel, { wide: true });
  addFact(facts, "快捷指令", view.shortcut, { wide: true });
  addFact(facts, "设备 ID", null, { wide: true, node: idLine(view.id) });

  const actions = document.createElement("div");
  actions.className = "actions device-actions";
  actions.append(testButton(device));

  const setupFold = buildSetupFold();
  const guide = document.createElement("button");
  guide.type = "button";
  guide.className = "secondary";
  guide.textContent = "安装说明";
  guide.addEventListener("click", (event) => {
    event.stopPropagation();
    setupFold.open = true;
    setupFold.scrollIntoView({ block: "nearest", behavior: "smooth" });
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
  body.append(facts, actions, buildApiConfig(), setupFold);
  row.append(head, body);
  return row;
}

function presenceDot(presence) {
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
    const details = document.querySelector(".device .setup-details");
    if (details) details.open = true;
    if (!hashHandled) {
      hashHandled = true;
      details?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
    return;
  }
  const id = hashDeviceId();
  if (!id) return;
  const row = [...devices.querySelectorAll("[data-device-id]")].find(
    (node) => node.dataset.deviceId === id,
  );
  const device = getDevices().find((item) => item.id === id);
  if (device) {
    openDeviceDetail(device, { message: null, total: null });
  }
  if (!row) return;
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
