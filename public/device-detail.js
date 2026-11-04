// Shared device detail drawer. Lives outside devices.js so ANY page can
// open it: the sidebar device list pops this drawer in place instead of
// navigating to the devices page first (the sidebar is the quick path).
// Mutations refresh the shared device store and dispatch
// "smsinbox:devices-changed" so the hosting page can re-render its list.
import {
  api,
  flashLabel,
  isUnauthorized,
  openModal,
  selectContents,
  toast,
} from "./common.js";
import { deviceStateOf, getDevices, noteDeviceSeen, refreshDevices } from "./device-store.js";
import { addFact, describeDevice, presenceDot, presenceLabel, pushConfirm } from "./device-panel.js";

const WEEK = 7 * 24 * 60 * 60 * 1000;

function emitDevicesChanged() {
  document.dispatchEvent(new CustomEvent("smsinbox:devices-changed"));
}

let deviceDetailState = null;

export function openDeviceDetail(device, entry = null) {
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

export function closeDeviceDetail() {
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
  // Leaving the detail view clears a #dev- deep link so later list
  // refreshes cannot resurrect the drawer (Roye hit this: sending a test
  // message re-opened the drawer because the hash was still in the URL).
  if ((location.hash || "").startsWith("#dev-")) {
    history.replaceState(null, "", `${location.pathname}${location.search}`);
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
  if (total !== null) addFact(factList, "短信数量", `${total} 条`);
  addFact(factList, "设备 ID", null, { wide: true, node: idLine(device.id) });
  status.append(factList);
  summary.append(status);

  const tabs = document.createElement("div");
  tabs.className = "tabs device-detail-tabs";
  const labels = [
    ["overview", "概览"],
    ["messages", "短信记录"],

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

  panels.append(overview, messages, push, advanced);
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
  actions.append(detailTestButton(device));
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
        chipWrap.append(CodeChip(message.code));
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
  summary.append(title, actions);
  panel.append(summary);
  if (view.pushUrl) {
    const wrap = document.createElement("div");
    wrap.className = "stack";
    const label = document.createElement("strong");
    label.textContent = "推送链接";
    const code = document.createElement("code");
    code.className = "code-block";
    code.textContent = view.pushUrl;
    code.addEventListener("click", () => selectContents(code));
    const copyRow = document.createElement("div");
    copyRow.className = "actions";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "secondary";
    copy.textContent = "复制推送链接";
    copy.addEventListener("click", async (event) => {
      const copied = await flashLabel(event.currentTarget, view.pushUrl, "复制推送链接");
      if (copied) toast("已复制");
    });
    copyRow.append(copy);
    wrap.append(label, code, copyRow);
    panel.append(wrap);
  } else if (device?.push === "active") {
    const note = document.createElement("p");
    note.className = "subtle";
    note.textContent = "这条链接是旧版生成的，没有保存明文。点「轮换接口」换一条新链接后，就能随时在这里查看和复制。";
    panel.append(note);
  }
  return panel;
}

function buildAdvancedPanel(device) {
  const panel = document.createElement("div");
  panel.className = "stack device-detail-stack";

  const renameSection = document.createElement("section");
  renameSection.className = "stack";
  const renameTitle = document.createElement("h3");
  renameTitle.textContent = "设备名称";
  const renameForm = document.createElement("form");
  renameForm.className = "stack";
  renameForm.id = "device-rename-form";
  renameForm.noValidate = true;
  const nameLabel = document.createElement("label");
  nameLabel.textContent = "显示名称";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.maxLength = 64;
  nameInput.required = true;
  nameInput.autocomplete = "off";
  nameInput.value = String(device?.name || "");
  nameLabel.append(nameInput);
  const renameError = document.createElement("p");
  renameError.className = "field-error";
  renameError.hidden = true;
  renameForm.append(nameLabel, renameError);
  renameForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitDeviceRename(device, nameInput, save, renameError);
  });
  renameSection.append(renameTitle, renameForm);

  // Save and delete share one row, half width each (Roye); the save button
  // stays bound to the rename form via its form attribute.
  const actions = document.createElement("div");
  actions.className = "device-advanced-actions";
  const save = document.createElement("button");
  save.type = "submit";
  save.setAttribute("form", "device-rename-form");
  save.textContent = "保存名称";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger";
  remove.textContent = "删除设备";
  remove.addEventListener("click", () => removeDevice(device));
  actions.append(save, remove);
  panel.append(renameSection, actions);
  return panel;
}

async function submitDeviceRename(device, input, save, errorBox) {
  const name = input.value.trim();
  errorBox.hidden = true;
  if (!name || name.length > 64) {
    errorBox.textContent = "设备名称需要 1 到 64 个字符";
    errorBox.hidden = false;
    return;
  }
  if (name === String(device?.name || "")) {
    toast("设备名称未改变");
    return;
  }
  save.disabled = true;
  try {
    const result = await api(`/api/v1/devices/${encodeURIComponent(device.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
    if (!result.response.ok) {
      errorBox.textContent = result.data.error || "保存名称失败";
      errorBox.hidden = false;
      return;
    }
    device.name = name;
    input.value = name;
    const title = document.querySelector(".ui-drawer .ui-drawer-title");
    if (title) title.textContent = name;
    // Refresh the store so the list cards and the sidebar follow the rename.
    await refreshDevices().catch(() => {});
    emitDevicesChanged();
    toast("设备名称已更新");
  } catch (error) {
    if (isUnauthorized(error)) return;
    errorBox.textContent = "保存名称失败";
    errorBox.hidden = false;
  } finally {
    save.disabled = false;
  }
}

function findDeviceRow(id) {
  const box = document.querySelector("#devices");
  return [...(box?.querySelectorAll("[data-device-id]") || [])].find(
    (node) => (node.getAttribute("data-device-id") || "") === String(id || ""),
  );
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

function isStale(received) {
  if (!received?.at) return false;
  return Date.now() - received.at > WEEK;
}

function detailTestButton(device) {
  const test = document.createElement("button");
  test.type = "button";
  test.className = "secondary";
  test.textContent = "发送测试消息";
  test.addEventListener("click", async (event) => {
    event.stopPropagation();
    test.disabled = true;
    const previous = test.textContent;
    test.textContent = "发送中…";
    try {
      const sent = await api(`/api/v1/devices/${device.id}/test`, { method: "POST", body: "{}" });
      if (!sent.response.ok) {
        toast(sent.data.error || "测试失败", { tone: "danger" });
        return;
      }
      const code = sent.data.code || "";
      toast(code ? `测试短信已写入收件箱（验证码 ${code}）` : "测试短信已写入收件箱", {
        href: "/",
        linkLabel: "去收件箱查看",
      });
      noteDeviceSeen(device.id, Date.now());
      await refreshDevices().catch(() => {});
      emitDevicesChanged();
    } catch (error) {
      if (isUnauthorized(error)) return;
      toast("测试失败", { tone: "danger" });
    } finally {
      test.disabled = false;
      test.textContent = previous;
    }
  });
  return test;
}

// Rebuild the open drawer for a device after a mutation, keeping the tab
// the user was on (a rotate is usually triggered from the push tab).
function reopenDeviceDetail(device) {
  const activeTab =
    deviceDetailState?.root?.querySelector("[data-device-tab].is-active")?.dataset.deviceTab || "";
  openDeviceDetail(device);
  if (activeTab && activeTab !== "overview") {
    document.querySelector(`.ui-drawer [data-device-tab="${activeTab}"]`)?.click();
  }
}

export async function runPush(device, action) {
  const message = pushConfirm(action, device.name);
  if (!message) return;
  const titles = { issue: "生成推送链接", rotate: "轮换接口", revoke: "撤销推送链接" };
  const confirmed = await openModal({
    title: titles[action] || "确认操作",
    text: message,
    confirmLabel: "确定",
    danger: action === "revoke",
  });
  if (!confirmed) return;
  try {
    const result = await api(`/api/v1/devices/${device.id}/push`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    if (!result.response.ok) {
      toast(result.data.error || "操作失败", { tone: "danger" });
      return;
    }
    // The push URL is stored server-side now, so the refreshed drawer and
    // cards simply show the new link; no one-time credential box needed.
    await refreshDevices().catch(() => {});
    const fresh = getDevices().find((item) => item.id === device.id) || device;
    toast(action === "revoke" ? "推送链接已撤销" : "新的推送链接已生效");
    if (deviceDetailState?.id === device.id) reopenDeviceDetail(fresh);
    emitDevicesChanged();
  } catch (error) {
    if (isUnauthorized(error)) return;
    toast("操作失败", { tone: "danger" });
  }
}

export async function removeDevice(device) {
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
  try {
    const deleted = await api(`/api/v1/devices/${device.id}`, { method: "DELETE" });
    if (!deleted.response.ok) {
      toast(deleted.data.error || "删除失败", { tone: "danger" });
      return;
    }
    if (deviceDetailState?.id === device.id) closeDeviceDetail();
    const row = findDeviceRow(device.id);
    if (row) {
      row.classList.add("is-leaving");
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      await new Promise((resolve) => window.setTimeout(resolve, reduce ? 0 : 180));
    }
    await refreshDevices().catch(() => {});
    toast(`已删除「${name}」`);
    emitDevicesChanged();
  } catch (error) {
    if (isUnauthorized(error)) return;
    toast("删除失败", { tone: "danger" });
  }
}
