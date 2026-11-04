import {
  CodeChip,
  absoluteTime,
  api,
  closeDrawer,
  errorState,
  flashLabel,
  formatTime,
  initShell,
  isUnauthorized,
  loadNav,
  loadingState,
  logout,
  mountSelect,
  openDrawer,
  openMenu,
  openModal,
  selectContents,
  showNotice,
  toast,
} from "./common.js";
import { deviceStateOf, ensureDevices, getDevices, noteDeviceSeen, refreshDevices } from "./device-store.js";
import { registerView } from "./shell.js";
import { addFact, credentialBoxes, describeDevice, isStale, presenceDot, presenceLabel, pushConfirm } from "./device-panel.js";
import { closeDeviceDetail, openDeviceDetail, removeDevice, runPush } from "./device-detail.js";

const TEMPLATE = '{"from":"{{FROM}}","content":"{{SMS}}","timestamp":"{{RECEIVE_TIME}}","device":"{{DEVICE_NAME}}","sim":"{{CARD_SLOT}}"}';
let form;
let platformField;
let deviceGroups = [];
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
let hashHandled = false;
let hashListener = null;

// The shared detail drawer (device-detail.js) mutates devices from any
// page; when it does so while THIS page is showing, refresh the list.
function onSharedDevicesChanged() {
  loadDevices({ refresh: true }).catch(() => {});
}

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
  document.addEventListener("smsinbox:devices-changed", onSharedDevicesChanged);
  document.querySelector("#add-device").addEventListener("click", openCreate);
  document.querySelector("#add-group")?.addEventListener("click", () => void editGroup(null));
  buildPageGuide();
  wirePageTabs();
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
    document.removeEventListener("smsinbox:devices-changed", onSharedDevicesChanged);
    closeDeviceDetail();
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
  // The drawer is only for naming the device and preselecting its type;
  // the setup guide lives in the devices page's guide tab, not here (it
  // made this drawer overflow the screen).
  platformField = mountSelect({
    name: "platform",
    value: "other",
    ariaLabel: "设备类型",
    options: [
      { value: "other", label: "设备类型：其他" },
      { value: "phone", label: "手机" },
      { value: "computer", label: "电脑" },
      { value: "ios", label: "iOS" },
      { value: "android", label: "安卓" },
      { value: "router", label: "路由器" },
    ],
  });
  section.querySelector("#device-platform-mount").replaceWith(platformField.root);
  return section;
}

// The access guide is generic (same for every device), so it lives once at
// page level in its own tab instead of being cloned into every device card.
function buildPageGuide() {
  const guide = document.querySelector("#device-guide");
  if (!guide || guide.childElementCount > 0) return;
  guide.append(buildApiConfig(), buildSetupFold());
}

function wirePageTabs() {
  const listTab = document.querySelector("#dtab-list");
  const guideTab = document.querySelector("#dtab-guide");
  const listPanel = document.querySelector("#dpanel-list");
  const guidePanel = document.querySelector("#dpanel-guide");
  if (!listTab || !guideTab || !listPanel || !guidePanel) return;
  const activate = (name) => {
    const guide = name === "guide";
    listTab.classList.toggle("is-active", !guide);
    listTab.setAttribute("aria-selected", guide ? "false" : "true");
    guideTab.classList.toggle("is-active", guide);
    guideTab.setAttribute("aria-selected", guide ? "true" : "false");
    listPanel.hidden = guide;
    guidePanel.hidden = !guide;
  };
  listTab.addEventListener("click", () => activate("list"));
  guideTab.addEventListener("click", () => activate("guide"));
  if (location.hash === "#guide") activate("guide");
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
  const body = { name, platform: String(payload.get("platform") || "other") };
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
    form.reset();
    // form.reset() cannot reset the custom picker (its value lives in a
    // hidden input), so return it to the default explicitly.
    if (platformField) platformField.value = "other";
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
      ? "Bearer token 只显示这一次，关闭后无法再次查看。推送链接已保存，可随时查看。"
      : "推送链接已保存，可随时在「推送配置」里查看和复制。";
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
    await loadGroups();
    if (ticket !== generation || token !== viewToken) return;
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

async function loadGroups() {
  try {
    const result = await api("/api/v1/device-groups");
    if (result.response.ok && Array.isArray(result.data.groups)) {
      deviceGroups = result.data.groups;
    }
  } catch {
    // Groups are an organizational extra; the flat list still renders.
  }
}

function renderDeviceList(rows, latest) {
  devices.replaceChildren();
  if (rows.length === 0) {
    devices.append(emptyDevices());
    applyLocationHash();
    return;
  }
  if (!deviceGroups.length) {
    for (const device of rows) devices.append(renderDevice(device, latest.get(device.id) || null));
    applyLocationHash();
    return;
  }
  // With groups defined, the list is filed under group headers; devices
  // whose group is gone (or never set) land in 未分组 at the end.
  for (const group of deviceGroups) {
    const members = rows.filter((device) => device.group_id === group.id);
    devices.append(groupHeader(group, members.length));
    for (const device of members) devices.append(renderDevice(device, latest.get(device.id) || null));
  }
  const ungrouped = rows.filter((device) => !deviceGroups.some((group) => group.id === device.group_id));
  if (ungrouped.length) {
    devices.append(groupHeader(null, ungrouped.length));
    for (const device of ungrouped) devices.append(renderDevice(device, latest.get(device.id) || null));
  }
  applyLocationHash();
}

function groupHeader(group, count) {
  const head = document.createElement("div");
  head.className = "device-group-head";
  const name = document.createElement("span");
  name.className = "device-group-name";
  name.textContent = group ? group.name : "未分组";
  const meta = document.createElement("span");
  meta.className = "device-group-count";
  meta.textContent = `${count} 台`;
  head.append(name, meta);
  if (group) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "ghost icon-btn device-group-more";
    more.setAttribute("aria-label", `管理分组 ${group.name}`);
    more.textContent = "⋯";
    more.addEventListener("click", () => {
      openMenu(more, [
        { label: "重命名分组", onSelect: () => void editGroup(group) },
        { label: "删除分组", danger: true, onSelect: () => void removeGroup(group) },
      ]);
    });
    head.append(more);
  }
  return head;
}

async function editGroup(group) {
  const input = document.createElement("input");
  input.maxLength = 32;
  input.value = group?.name || "";
  input.placeholder = "分组名称";
  input.setAttribute("aria-label", "分组名称");
  const confirmed = await openModal({
    title: group ? "重命名分组" : "新建分组",
    body: input,
    confirmLabel: group ? "保存" : "创建",
  });
  if (!confirmed) return;
  const name = input.value.trim();
  if (!name || name.length > 32) {
    toast("分组名称需要 1 到 32 个字符", { tone: "danger" });
    return;
  }
  const result = group
    ? await api(`/api/v1/device-groups/${encodeURIComponent(group.id)}`, { method: "PATCH", body: JSON.stringify({ name }) })
    : await api("/api/v1/device-groups", { method: "POST", body: JSON.stringify({ name }) });
  if (!result.response.ok) {
    toast(result.data?.error || "保存分组失败", { tone: "danger" });
    return;
  }
  toast(group ? "分组已重命名" : "分组已创建");
  await loadGroups();
  await loadDevices({ refresh: true });
}

async function removeGroup(group) {
  const confirmed = await openModal({
    title: "删除分组",
    body: `确定要删除分组「${group.name}」吗？组内设备不会被删除，只会变为未分组。`,
    confirmLabel: "删除",
    danger: true,
  });
  if (!confirmed) return;
  const result = await api(`/api/v1/device-groups/${encodeURIComponent(group.id)}`, { method: "DELETE" });
  if (!result.response.ok) {
    toast(result.data?.error || "删除分组失败", { tone: "danger" });
    return;
  }
  toast("分组已删除");
  await loadGroups();
  await loadDevices({ refresh: true });
}

async function setDeviceGroupId(device, groupId) {
  const result = await api(`/api/v1/devices/${encodeURIComponent(device.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ group_id: groupId }),
  });
  if (!result.response.ok) {
    toast(result.data?.error || "设置分组失败", { tone: "danger" });
    return;
  }
  toast("已更新分组");
  await loadDevices({ refresh: true });
}

async function togglePin(device) {
  const pinning = device.pinned_at == null;
  const result = await api(`/api/v1/devices/${encodeURIComponent(device.id)}/${pinning ? "pin" : "unpin"}`, {
    method: "POST",
  });
  if (!result.response.ok) {
    toast(result.data?.error || "操作失败", { tone: "danger" });
    return;
  }
  toast(pinning ? "已置顶到侧边栏" : "已取消置顶");
  await loadDevices({ refresh: true });
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
  const row = document.createElement("article");
  row.className = "device";
  if (view.id) row.id = `dev-${view.id}`;
  if (view.id) row.dataset.deviceId = view.id;
  if (view.id && view.id === shownDeviceId) row.classList.add("is-highlighted");

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
  head.append(titleWrap);
  const pinned = device.pinned_at != null;
  const pin = document.createElement("button");
  pin.type = "button";
  pin.className = `ghost icon-btn device-pin${pinned ? " is-pinned" : ""}`;
  pin.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#icon-pin"/></svg>';
  pin.title = pinned ? "取消置顶" : "置顶到侧边栏";
  pin.setAttribute("aria-label", pin.title);
  pin.setAttribute("aria-pressed", pinned ? "true" : "false");
  pin.addEventListener("click", (event) => {
    event.stopPropagation();
    void togglePin(device);
  });
  head.append(pin);
  head.addEventListener("click", (event) => {
    if (event.target.closest("button, a, input, select, textarea, summary")) return;
    openDeviceDetail(device, entry);
  });

  const body = document.createElement("div");
  body.className = "device-body";

  const facts = document.createElement("dl");
  facts.className = "device-facts";
  addFact(facts, "平台", view.platformDetail, { wide: true });
  if (total !== null) addFact(facts, "短信数量", `${total} 条`);
  addFact(facts, "推送链接", null, { wide: true, node: pushLine(device, view) });

  const actions = document.createElement("div");
  actions.className = "actions device-actions";
  actions.append(testButton(device));

  const more = document.createElement("button");
  more.type = "button";
  more.className = "secondary device-more";
  more.setAttribute("aria-label", "管理设备");
  more.textContent = "管理设备";
  more.addEventListener("click", (event) => {
    event.stopPropagation();
    // Menu order is fixed: rename, group, push actions (rotate/revoke), delete.
    const items = [
      {
        label: "更改名称",
        onSelect: () => {
          openDeviceDetail(device, entry);
          document
            .querySelector('.ui-drawer [data-device-tab="advanced"]')
            ?.click();
        },
      },
      {
        label: "设置分组",
        onSelect: () => {
          openMenu(more, [
            {
              label: "未分组",
              selected: !device.group_id,
              onSelect: () => void setDeviceGroupId(device, null),
            },
            ...deviceGroups.map((group) => ({
              label: group.name,
              selected: device.group_id === group.id,
              onSelect: () => void setDeviceGroupId(device, group.id),
            })),
          ]);
        },
      },
      ...view.actions.map((item) => ({
        label: item.label,
        danger: item.action === "revoke",
        onSelect: () => runPush(device, item.action),
      })),
      { label: "删除设备", danger: true, onSelect: () => removeDevice(device) },
    ];
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

function pushLine(device, view) {
  const line = document.createElement("div");
  line.className = "device-id";
  if (view.pushUrl) {
    const code = document.createElement("code");
    code.textContent = view.pushUrl;
    code.title = view.pushUrl;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = "复制链接";
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      flashLabel(event.currentTarget, view.pushUrl, "复制链接");
    });
    line.append(code, button);
  } else {
    const span = document.createElement("span");
    span.className = "subtle";
    span.textContent =
      device?.push === "active"
        ? "旧链接未保存明文，轮换后显示"
        : device?.push === "revoked"
          ? "推送链接已撤销"
          : "尚未生成推送链接";
    line.append(span);
  }
  return line;
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

function showSkeletons() {
  devices.replaceChildren(loadingState({ count: 3, className: "device skeleton", ariaHidden: true }));
}

function showLoadError(message) {
  const keep = Boolean(devices.querySelector(".device:not(.skeleton)"));
  setError(keep ? message : "");
  if (keep) return;
  devices.replaceChildren(
    errorState({
      message,
      onRetry: () => {
        loadDevices().catch((error) => {
          if (isUnauthorized(error)) return;
          setError("加载设备失败");
        });
      },
    }),
  );
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
  // Once per hash: list re-renders (e.g. after sending a test message)
  // must not keep re-opening the drawer.
  if (hashHandled) return;
  hashHandled = true;
  const row = [...devices.querySelectorAll("[data-device-id]")].find(
    (node) => node.dataset.deviceId === id,
  );
  const device = getDevices().find((item) => item.id === id);
  if (device) {
    openDeviceDetail(device, { message: null, total: null });
  }
  if (!row) return;
  row.classList.add("is-highlighted");
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
