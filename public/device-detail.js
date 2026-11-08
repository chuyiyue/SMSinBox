// Shared device detail drawer. Lives outside devices.js so ANY page can
// open it: the sidebar device list pops this drawer in place instead of
// navigating to the devices page first (the sidebar is the quick path).
// Mutations refresh the shared device store and dispatch
// "smsinbox:devices-changed" so the hosting page can re-render its list.
import {
  api,
  CodeChip,
  flashLabel,
  formatTime,
  isUnauthorized,
  mountSelect,
  openModal,
  selectContents,
  toast,
} from "./common.js";
import { deviceStateOf, getDevices, noteDeviceSeen, refreshDevices } from "./device-store.js";
import { addFact, describeDevice, DEVICE_TYPES, deviceTypeOf, isStale, presenceDot, presenceLabel, pushConfirm, pushIdOf } from "./device-panel.js";
import { t } from "./i18n.js";

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
  overlay.setAttribute("aria-label", t("devices.closeDetail"));
  overlay.addEventListener("click", closeDeviceDetail);

  const panel = document.createElement("div");
  panel.className = "ui-drawer-panel device-detail-panel";

  const head = document.createElement("header");
  head.className = "device-detail-header";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "secondary device-detail-back";
  back.textContent = t("common.back");
  back.addEventListener("click", closeDeviceDetail);
  const text = document.createElement("div");
  text.className = "device-detail-heading";
  const titleRow = document.createElement("div");
  titleRow.className = "device-detail-title-row";
  const view = describeDevice(device, entry?.message || null);
  const typeIcon = document.createElement("span");
  typeIcon.setAttribute("aria-hidden", "true");
  typeIcon.innerHTML = `<svg class="device-type-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#${view.platform.icon}"/></svg>`;
  const title = document.createElement("h2");
  title.className = "ui-drawer-title";
  title.textContent = String(device?.name || t("common.unnamedDevice"));
  titleRow.append(typeIcon.firstChild, title);
  const meta = document.createElement("p");
  meta.className = "device-detail-meta-line";
  const presence = deviceStateOf(device);
  meta.textContent = `${presenceLabel(presence)} · ${view.platformBadge}`;
  text.append(titleRow, meta);
  head.append(text, back);

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
  const onLocale = () => {
    rerenderDeviceDetail();
  };
  document.addEventListener("smsinbox:locale", onLocale);
  root.dataset.deviceId = id;
  deviceDetailState = { root, onKey, id, onLocale, device, entry };
  const firstTab = panel.querySelector("[data-device-tab]");
  firstTab?.click();
  const initialFocus = panel.querySelector("button, input, select, textarea, a[href]") || back;
  initialFocus?.focus({ preventScroll: true });
}

export function closeDeviceDetail() {
  if (!deviceDetailState) return;
  const { root, onKey, id, onLocale } = deviceDetailState;
  document.removeEventListener("keydown", onKey, true);
  document.removeEventListener("smsinbox:locale", onLocale);
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
  addFact(factList, t("devices.platform"), view.platformDetail, { wide: true });
  if (total !== null) addFact(factList, t("devices.messageCountLabel"), t("devices.messageCount", { count: total }));
  addFact(factList, t("devices.deviceId"), null, { wide: true, node: idLine(device.id) });
  status.append(factList);
  summary.append(status);

  const tabs = document.createElement("div");
  tabs.className = "tabs device-detail-tabs";
  const labels = [
    ["overview", t("devices.tabOverview")],
    ["messages", t("devices.tabMessages")],
    ["push", t("devices.tabPush")],
    ["advanced", t("devices.tabAdvanced")],
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
  heading.textContent = t("devices.statusOverview");
  const meta = document.createElement("dl");
  meta.className = "device-facts";
  addFact(meta, t("devices.deviceName"), device.name || t("common.unnamedDevice"), { wide: true });
  addFact(meta, t("devices.recentStatus"), presenceLabel(deviceStateOf(device)), { wide: true });
  addFact(meta, t("devices.platform"), view.platformBadge, { wide: true });
  if (total !== null) addFact(meta, t("devices.smsCount"), t("devices.messageCount", { count: total }), { wide: true });
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
      message.textContent = result.data.error || t("devices.messagesUnavailable");
      wrapper.append(message);
      return;
    }
    const messages = Array.isArray(result.data.messages) ? result.data.messages : [];
    wrapper.replaceChildren();
    if (messages.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty subtle";
      empty.textContent = t("devices.messagesEmpty");
      wrapper.append(empty);
      return;
    }
    for (const message of messages) {
      const item = document.createElement("article");
      item.className = "device-message-item";
      const sender = document.createElement("div");
      sender.className = "device-message-head";
      const who = document.createElement("strong");
      who.textContent = message.from_number || t("devices.unknownNumber");
      const time = document.createElement("span");
      time.className = "subtle";
      time.textContent = message.received_at ? formatTime(Number(message.received_at)) : t("time.justNow");
      sender.append(who, time);
      const content = document.createElement("p");
      content.className = "device-message-body";
      content.textContent = message.content || t("devices.emptyContent");
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
    empty.textContent = t("devices.messagesLoadFailed");
    wrapper.append(empty);
  }
}

function buildPushPanel(device, view) {
  const panel = document.createElement("div");
  panel.className = "stack device-detail-stack";
  const summary = document.createElement("div");
  summary.className = "device-detail-card";
  const title = document.createElement("h3");
  title.textContent = t("devices.tabPush");
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
    label.textContent = t("devices.pushLink");
    const code = document.createElement("code");
    code.className = "code-block";
    code.textContent = pushIdOf(view.pushUrl);
    code.addEventListener("click", () => selectContents(code));
    const copyRow = document.createElement("div");
    copyRow.className = "actions";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "secondary";
    copy.textContent = t("devices.copyPushUrl");
    copy.addEventListener("click", async (event) => {
      const copied = await flashLabel(event.currentTarget, view.pushUrl, t("devices.copyPushUrl"));
      if (copied) toast(t("devices.copied"));
    });
    copyRow.append(copy);
    wrap.append(label, code, copyRow);
    panel.append(wrap);
  } else if (device?.push === "active") {
    const note = document.createElement("p");
    note.className = "subtle";
    note.textContent = t("devices.legacyPushNote");
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
  renameTitle.textContent = t("devices.deviceName");
  const renameForm = document.createElement("form");
  renameForm.className = "stack";
  renameForm.id = "device-rename-form";
  renameForm.noValidate = true;
  const nameLabel = document.createElement("label");
  nameLabel.textContent = t("devices.displayName");
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

  // Device type (OS): changing the picker applies immediately, like the
  // pin and group actions. A later report still wins over this choice.
  const typeSection = document.createElement("section");
  typeSection.className = "stack";
  const typeTitle = document.createElement("h3");
  typeTitle.textContent = t("devices.deviceType");
  const typeField = mountSelect({
    value: deviceTypeOf(device?.platform)?.value ?? "other",
    ariaLabel: t("devices.deviceType"),
    options: DEVICE_TYPES.map((type) => ({ value: type.value, label: type.label, icon: type.icon })),
    onChange: (next) => void submitDeviceType(device, next),
  });
  const typeNote = document.createElement("p");
  typeNote.className = "subtle";
  typeNote.textContent = t("devices.typeNote");
  typeSection.append(typeTitle, typeField.root, typeNote);

  // Save and delete stack vertically, one per row (Roye); the save button
  // stays bound to the rename form via its form attribute.
  const actions = document.createElement("div");
  actions.className = "device-advanced-actions";
  const save = document.createElement("button");
  save.type = "submit";
  save.setAttribute("form", "device-rename-form");
  save.textContent = t("devices.saveName");
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger";
  remove.textContent = t("devices.deleteDevice");
  remove.addEventListener("click", () => removeDevice(device));
  actions.append(save, remove);
  panel.append(renameSection, typeSection, actions);
  return panel;
}

async function submitDeviceType(device, platform) {
  try {
    const result = await api(`/api/v1/devices/${encodeURIComponent(device.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ platform }),
    });
    if (!result.response.ok) {
      toast(result.data?.error || t("devices.typeChangeFailed"), { tone: "danger" });
      return;
    }
    device.platform = platform;
    await refreshDevices().catch(() => {});
    emitDevicesChanged();
    toast(t("devices.typeUpdated"));
  } catch (error) {
    if (isUnauthorized(error)) return;
    toast(t("devices.typeChangeFailed"), { tone: "danger" });
  }
}

async function submitDeviceRename(device, input, save, errorBox) {
  const name = input.value.trim();
  errorBox.hidden = true;
  if (!name || name.length > 64) {
    errorBox.textContent = t("devices.nameLength");
    errorBox.hidden = false;
    return;
  }
  if (name === String(device?.name || "")) {
    // Unchanged is not worth a word (Roye): saving with only the type
    // changed, or with nothing changed, stays silent here.
    return;
  }
  save.disabled = true;
  try {
    const result = await api(`/api/v1/devices/${encodeURIComponent(device.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
    if (!result.response.ok) {
      errorBox.textContent = result.data.error || t("devices.saveNameFailed");
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
    toast(t("devices.nameUpdated"));
  } catch (error) {
    if (isUnauthorized(error)) return;
    errorBox.textContent = t("devices.saveNameFailed");
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
  button.textContent = t("devices.copyId");
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    flashLabel(event.currentTarget, id, t("devices.copyId"));
  });
  line.append(code, button);
  return line;
}


function detailTestButton(device) {
  const test = document.createElement("button");
  test.type = "button";
  test.className = "secondary";
  test.textContent = t("devices.sendTest");
  test.addEventListener("click", async (event) => {
    event.stopPropagation();
    test.disabled = true;
    const previous = test.textContent;
    test.textContent = t("devices.sending");
    try {
      const sent = await api(`/api/v1/devices/${device.id}/test`, { method: "POST", body: "{}" });
      if (!sent.response.ok) {
        toast(sent.data.error || t("devices.testFailed"), { tone: "danger" });
        return;
      }
      const code = sent.data.code || "";
      toast(code ? t("devices.testSentWithCode", { code }) : t("devices.testSent"), {
        href: "/",
        linkLabel: t("devices.viewInbox"),
      });
      noteDeviceSeen(device.id, Date.now());
      await refreshDevices().catch(() => {});
      emitDevicesChanged();
    } catch (error) {
      if (isUnauthorized(error)) return;
      toast(t("devices.testFailed"), { tone: "danger" });
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
  const titles = { issue: t("devices.issuePushLink"), rotate: t("devices.rotateEndpoint"), revoke: t("devices.revokePushLink") };
  const confirmed = await openModal({
    title: titles[action] || t("devices.confirmAction"),
    text: message,
    confirmLabel: t("common.confirm"),
    danger: action === "revoke",
  });
  if (!confirmed) return;
  try {
    const result = await api(`/api/v1/devices/${device.id}/push`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    if (!result.response.ok) {
      toast(result.data.error || t("devices.actionFailed"), { tone: "danger" });
      return;
    }
    // The push URL is stored server-side now, so the refreshed drawer and
    // cards simply show the new link; no one-time credential box needed.
    await refreshDevices().catch(() => {});
    const fresh = getDevices().find((item) => item.id === device.id) || device;
    toast(action === "revoke" ? t("devices.pushRevoked") : t("devices.pushReady"));
    if (deviceDetailState?.id === device.id) reopenDeviceDetail(fresh);
    emitDevicesChanged();
  } catch (error) {
    if (isUnauthorized(error)) return;
    toast(t("devices.actionFailed"), { tone: "danger" });
  }
}

export async function removeDevice(device) {
  const name = String(device.name || "");
  const confirmed = await openModal({
    title: t("devices.deleteDeviceTitle", { name }),
    text: t("devices.deleteDeviceText"),
    confirmLabel: t("common.delete"),
    danger: true,
    dismissible: false,
    requireText: name,
  });
  if (!confirmed) return;
  try {
    const deleted = await api(`/api/v1/devices/${device.id}`, { method: "DELETE" });
    if (!deleted.response.ok) {
      toast(deleted.data.error || t("devices.deleteFailed"), { tone: "danger" });
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
    toast(t("devices.deleted", { name }));
    emitDevicesChanged();
  } catch (error) {
    if (isUnauthorized(error)) return;
    toast(t("devices.deleteFailed"), { tone: "danger" });
  }
}

function rerenderDeviceDetail() {
  const state = deviceDetailState;
  if (!state) return;
  const { root, device, entry } = state;
  const activeTab = root.querySelector("[data-device-tab].is-active")?.dataset.deviceTab || "";
  const view = describeDevice(device, entry?.message || null);
  const title = root.querySelector(".ui-drawer-title");
  if (title) title.textContent = String(device?.name || t("common.unnamedDevice"));
  const meta = root.querySelector(".device-detail-meta-line");
  if (meta) meta.textContent = `${presenceLabel(deviceStateOf(device))} · ${view.platformBadge}`;
  const use = root.querySelector(".device-detail-title-row use");
  if (use) use.setAttribute("href", `/icons.svg#${view.platform.icon}`);
  const overlay = root.querySelector(".ui-drawer-overlay");
  if (overlay) overlay.setAttribute("aria-label", t("devices.closeDetail"));
  const back = root.querySelector(".device-detail-back");
  if (back) back.textContent = t("common.back");
  const body = root.querySelector(".device-detail-body");
  if (!body) return;
  body.replaceChildren(buildDeviceDetailShell(device, entry));
  if (activeTab && activeTab !== "overview") {
    body.querySelector(`[data-device-tab="${activeTab}"]`)?.click();
  }
}
