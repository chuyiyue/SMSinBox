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
import { addFact, credentialBoxes, describeDevice, DEVICE_TYPES, isStale, presenceDot, presenceLabel, pushConfirm } from "./device-panel.js";
import { closeDeviceDetail, openDeviceDetail, removeDevice, runPush } from "./device-detail.js";
import { applyI18n, t } from "./i18n.js";

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
let authHeader = "";
let shownDeviceId = "";
let generation = 0;
let hashHandled = false;
let hashListener = null;
let listReady = false;
let renderedRows = [];
let renderedLatest = new Map();
let listErrorKey = "";

function curlSampleText() {
  const content = t("guide.api.sampleContent");
  return [
    `curl -X POST '${webhookUrl}' \\`,
    "  -H 'Authorization: Bearer <token>' \\",
    "  -H 'Content-Type: application/json' \\",
    `  -d '{"from":"10086","content":"${content}","device":"Android"}'`,
  ].join("\n");
}

// The shared detail drawer (device-detail.js) mutates devices from any
// page; when it does so while THIS page is showing, refresh the list.
function onSharedDevicesChanged() {
  loadDevices({ refresh: true }).catch(() => {});
}

function onDevicesLocale() {
  refreshGuideLabels();
  if (addBody) applyI18n(addBody);
  const toggle = platformField?.root?.querySelector(".select-toggle");
  if (toggle) toggle.setAttribute("aria-label", t("devices.deviceType"));
  if (tokenBox && !tokenBox.hidden) {
    const warn = tokenBox.querySelector(".callout");
    if (warn) {
      warn.textContent = bearerWrap && !bearerWrap.hidden
        ? t("devices.credentialWarnBoth")
        : t("devices.credentialWarnPush");
    }
  }
  if (addBody?.isConnected) {
    const addTitle = document.querySelector(".ui-drawer:not(.device-detail-drawer) .ui-drawer-title");
    if (addTitle) addTitle.textContent = t("devices.addDevice");
    const addClose = document.querySelector(".ui-drawer:not(.device-detail-drawer) .ui-drawer-close");
    if (addClose) addClose.textContent = t("common.close");
  }
  if (listErrorKey) {
    showLoadError(t(listErrorKey), listErrorKey);
    return;
  }
  if (listReady && devices) renderDeviceList(renderedRows, renderedLatest);
}

function startView() {
  viewToken += 1;
  const token = viewToken;
  devices = document.querySelector("#devices");
  errorBox = document.querySelector("#device-error");
  statusBox = document.querySelector("#device-status");
  addBody = buildAddBody();
  initShell({
    onLogout: () => logout().catch(() => setError(t("devices.logoutFailed"))),
    onRefresh: () => loadDevices({ refresh: true }).catch((error) => {
      if (isUnauthorized(error)) return;
      setError(t("devices.loadFailed"));
    }),
  });
  document.addEventListener("smsinbox:devices-changed", onSharedDevicesChanged);
  document.addEventListener("smsinbox:locale", onDevicesLocale);
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
    setError(t("devices.loadFailed"));
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
    document.removeEventListener("smsinbox:locale", onDevicesLocale);
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
    const copied = await flashLabel(event.currentTarget, tokenValue.textContent || "", t("devices.copyToken"));
    if (copied) toast(t("devices.copied"));
  });
  section.querySelector("#copy-push-url").addEventListener("click", async (event) => {
    const copied = await flashLabel(event.currentTarget, pushUrlValue.textContent || "", t("devices.copyPushUrl"));
    if (copied) toast(t("devices.copied"));
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
    ariaLabel: t("devices.deviceType"),
    options: DEVICE_TYPES.map((type) => ({ value: type.value, label: type.label, icon: type.icon })),
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
  const actions = document.querySelector(".devices-actions");
  if (!listTab || !guideTab || !listPanel || !guidePanel) return;
  const activate = (name) => {
    const guide = name === "guide";
    listTab.classList.toggle("is-active", !guide);
    listTab.setAttribute("aria-selected", guide ? "false" : "true");
    guideTab.classList.toggle("is-active", guide);
    guideTab.setAttribute("aria-selected", guide ? "true" : "false");
    listPanel.hidden = guide;
    guidePanel.hidden = !guide;
    // Adding devices and groups belongs to the list tab only.
    if (actions) actions.hidden = guide;
  };
  listTab.addEventListener("click", () => activate("list"));
  guideTab.addEventListener("click", () => activate("guide"));
  if (location.hash === "#guide") activate("guide");
}

function buildApiConfig() {
  const node = cloneTemplate("#api-config-template");
  node.querySelector("#sms-url").textContent = webhookUrl;
  node.querySelector("#android-template").textContent = TEMPLATE;
  node.querySelector("#curl-sample").textContent = curlSampleText();
  bindCopy(node, "#copy-sms-url", webhookUrl, () => t("devices.copyAddress"));
  bindCopy(node, "#copy-auth", () => authHeader, () => t("common.copy"));
  bindCopy(node, "#copy-template", TEMPLATE, () => t("devices.copyTemplate"));
  bindCopy(node, "#copy-curl", () => curlSampleText(), () => t("common.copy"));
  return node;
}

function refreshGuideLabels() {
  authHeader = t("guide.api.authHeader");
  const curl = document.querySelector("#curl-sample");
  if (curl) curl.textContent = curlSampleText();
  for (const chip of document.querySelectorAll("#device-guide .guide-auth")) {
    chip.textContent = authHeader;
    chip.dataset.copy = authHeader;
  }
}

function buildSetupFold() {
  const node = cloneTemplate("#setup-guide-template");
  // Dynamic values are filled from the same constants the API config
  // block uses, so the guide can never drift from the real endpoints.
  for (const chip of node.querySelectorAll(".guide-sms-url")) {
    chip.textContent = webhookUrl;
    chip.dataset.copy = webhookUrl;
  }
  authHeader = t("guide.api.authHeader");
  for (const chip of node.querySelectorAll(".guide-auth")) {
    chip.textContent = authHeader;
    chip.dataset.copy = authHeader;
  }
  // Key values copy on click: the value itself is the button.
  for (const chip of node.querySelectorAll(".copy-value")) {
    chip.addEventListener("click", (event) => {
      event.stopPropagation();
      const value = chip.dataset.copy || chip.textContent.trim();
      flashLabel(chip, value, value);
    });
  }
  bindTabs(node);
  return node;
}

function bindCopy(scope, selector, value, label) {
  const button = scope.querySelector(selector);
  if (!button) return;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const text = typeof value === "function" ? value() : value;
    const name = typeof label === "function" ? label() : label;
    flashLabel(event.currentTarget, text, name);
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
    showFormError(t("devices.nameLength"));
    return;
  }
  const body = { name, platform: String(payload.get("platform") || "other") };
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  const previous = button.textContent;
  button.textContent = t("devices.adding");
  try {
    const result = await api("/api/v1/devices", { method: "POST", body: JSON.stringify(body) });
    if (token !== viewToken) return;
    if (!result.response.ok) {
      const message = result.data.error || t("devices.createFailed");
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
    showFormError(t("devices.createFailed"));
    toast(t("devices.createFailed"), { tone: "danger" });
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
  openDrawer({ title: t("devices.addDevice"), bodyHTML: addBody });
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
      ? t("devices.credentialWarnBoth")
      : t("devices.credentialWarnPush");
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
      showLoadError(listResult.error || t("devices.loadFailed"), listResult.error ? "" : "devices.loadFailed");
      return;
    }
    if (!listResult.ok) setError(listResult.error || t("devices.loadFailed"));
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
    showLoadError(t("devices.loadFailed"), "devices.loadFailed");
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
  listReady = true;
  listErrorKey = "";
  renderedRows = rows;
  renderedLatest = latest;
  devices.replaceChildren();
  devices.classList.remove("is-grouped");
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
  // With groups defined, each group is one panel holding its cards (the
  // token-management shape); devices whose group is gone (or never set)
  // land in the ungrouped panel at the end.
  devices.classList.add("is-grouped");
  deviceGroups.forEach((group, index) => {
    const members = rows.filter((device) => device.group_id === group.id);
    devices.append(groupPanel(group, members, latest, index));
  });
  const ungrouped = rows.filter((device) => !deviceGroups.some((group) => group.id === device.group_id));
  if (ungrouped.length) {
    devices.append(groupPanel(null, ungrouped, latest, -1));
  }
  applyLocationHash();
}

function groupPanel(group, members, latest, index) {
  const panel = document.createElement("section");
  panel.className = "device-group-panel";
  panel.append(groupHeader(group, members.length, index));
  if (!members.length) {
    const empty = document.createElement("p");
    empty.className = "device-group-empty";
    empty.textContent = t("devices.groupEmpty");
    panel.append(empty);
    return panel;
  }
  const grid = document.createElement("div");
  grid.className = "device-group-grid";
  for (const device of members) grid.append(renderDevice(device, latest.get(device.id) || null));
  panel.append(grid);
  return panel;
}

function groupHeader(group, count, index) {
  const head = document.createElement("div");
  head.className = "device-group-head";
  const name = document.createElement("span");
  name.className = "device-group-name";
  name.textContent = group ? group.name : t("devices.ungrouped");
  const meta = document.createElement("span");
  meta.className = "device-group-count";
  meta.textContent = t("devices.deviceCount", { count });
  head.append(name, meta);
  if (group) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "ghost icon-btn device-group-more";
    more.setAttribute("aria-label", t("devices.manageGroup", { name: group.name }));
    more.textContent = "⋯";
    more.addEventListener("click", () => {
      openMenu(more, [
        { label: t("devices.renameGroup"), onSelect: () => void editGroup(group) },
        {
          label: t("devices.moveUp"),
          disabled: index <= 0,
          reason: index <= 0 ? t("devices.alreadyFirst") : "",
          onSelect: () => void moveGroup(group, "up"),
        },
        {
          label: t("devices.moveDown"),
          disabled: index >= deviceGroups.length - 1,
          reason: index >= deviceGroups.length - 1 ? t("devices.alreadyLast") : "",
          onSelect: () => void moveGroup(group, "down"),
        },
        { label: t("devices.deleteGroup"), danger: true, onSelect: () => void removeGroup(group) },
      ]);
    });
    head.append(more);
  }
  return head;
}

async function moveGroup(group, direction) {
  const result = await api(`/api/v1/device-groups/${encodeURIComponent(group.id)}/move`, {
    method: "POST",
    body: JSON.stringify({ direction }),
  });
  if (!result.response.ok) {
    toast(result.data?.error || t("devices.reorderFailed"), { tone: "danger" });
    return;
  }
  await loadGroups();
  await loadDevices({ refresh: true });
}

async function editGroup(group) {
  const input = document.createElement("input");
  input.maxLength = 32;
  input.value = group?.name || "";
  input.placeholder = t("devices.groupName");
  input.setAttribute("aria-label", t("devices.groupName"));
  const confirmed = await openModal({
    title: group ? t("devices.renameGroup") : t("devices.newGroup"),
    body: input,
    confirmLabel: group ? t("common.save") : t("devices.create"),
  });
  if (!confirmed) return;
  const name = input.value.trim();
  if (!name || name.length > 32) {
    toast(t("devices.groupNameLength"), { tone: "danger" });
    return;
  }
  const result = group
    ? await api(`/api/v1/device-groups/${encodeURIComponent(group.id)}`, { method: "PATCH", body: JSON.stringify({ name }) })
    : await api("/api/v1/device-groups", { method: "POST", body: JSON.stringify({ name }) });
  if (!result.response.ok) {
    toast(result.data?.error || t("devices.saveGroupFailed"), { tone: "danger" });
    return;
  }
  toast(group ? t("devices.groupRenamed") : t("devices.groupCreated"));
  await loadGroups();
  await loadDevices({ refresh: true });
}

async function removeGroup(group) {
  const confirmed = await openModal({
    title: t("devices.deleteGroup"),
    body: t("devices.deleteGroupConfirm", { name: group.name }),
    confirmLabel: t("common.delete"),
    danger: true,
  });
  if (!confirmed) return;
  const result = await api(`/api/v1/device-groups/${encodeURIComponent(group.id)}`, { method: "DELETE" });
  if (!result.response.ok) {
    toast(result.data?.error || t("devices.deleteGroupFailed"), { tone: "danger" });
    return;
  }
  toast(t("devices.groupDeleted"));
  await loadGroups();
  await loadDevices({ refresh: true });
}

async function setDeviceGroupId(device, groupId) {
  const result = await api(`/api/v1/devices/${encodeURIComponent(device.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ group_id: groupId }),
  });
  if (!result.response.ok) {
    toast(result.data?.error || t("devices.setGroupFailed"), { tone: "danger" });
    return;
  }
  toast(t("devices.groupUpdated"));
  await loadDevices({ refresh: true });
}

async function togglePin(device) {
  const pinning = device.pinned_at == null;
  const result = await api(`/api/v1/devices/${encodeURIComponent(device.id)}/${pinning ? "pin" : "unpin"}`, {
    method: "POST",
  });
  if (!result.response.ok) {
    toast(result.data?.error || t("devices.actionFailed"), { tone: "danger" });
    return;
  }
  toast(pinning ? t("devices.pinned") : t("devices.unpinned"));
  await loadDevices({ refresh: true });
}

function emptyDevices() {
  const wrap = document.createElement("div");
  wrap.className = "empty-state";
  const title = document.createElement("h2");
  title.className = "empty-title";
  title.textContent = t("devices.emptyTitle");
  const text = document.createElement("p");
  text.textContent = t("devices.emptyText");
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = t("devices.addFirst");
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
  const openId = document.querySelector(".device-detail-drawer")?.getAttribute("data-device-id") || "";
  if (view.id && (view.id === shownDeviceId || view.id === openId)) row.classList.add("is-highlighted");

  const presence = deviceStateOf(device);
  const head = document.createElement("div");
  head.className = "device-head";
  const titleWrap = document.createElement("div");
  titleWrap.className = "device-title";
  const typeIcon = document.createElement("span");
  typeIcon.setAttribute("aria-hidden", "true");
  typeIcon.innerHTML = `<svg class="device-type-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#${view.platform.icon}"/></svg>`;
  const title = document.createElement("strong");
  title.className = "device-name";
  title.textContent = view.name || t("common.unnamedDevice");
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.dataset.platform = view.platform.key;
  badge.textContent = view.platformBadge;
  titleWrap.append(typeIcon.firstChild, title, badge, presenceDot(presence));
  head.append(titleWrap);
  const pinned = device.pinned_at != null;
  const pin = document.createElement("button");
  pin.type = "button";
  pin.className = `ghost icon-btn device-pin${pinned ? " is-pinned" : ""}`;
  pin.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#icon-pin"/></svg>';
  pin.title = pinned ? t("devices.unpin") : t("devices.pin");
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
  addFact(facts, t("devices.platform"), view.platformDetail);
  if (total !== null) addFact(facts, t("devices.messageCountLabel"), t("devices.messageCount", { count: total }));
  addFact(facts, t("devices.pushId"), null, { wide: true, node: pushLine(device, view) });

  const actions = document.createElement("div");
  actions.className = "actions device-actions";
  actions.append(testButton(device));

  const more = document.createElement("button");
  more.type = "button";
  more.className = "secondary device-more";
  more.setAttribute("aria-label", t("devices.manageDevice"));
  more.textContent = t("devices.manageDevice");
  more.addEventListener("click", (event) => {
    event.stopPropagation();
    // Menu order is fixed: rename, group, push actions (rotate/revoke), delete.
    const items = [
      {
        label: t("devices.rename"),
        onSelect: () => {
          openDeviceDetail(device, entry);
          document
            .querySelector('.ui-drawer [data-device-tab="advanced"]')
            ?.click();
        },
      },
      {
        label: t("devices.setGroup"),
        onSelect: () => {
          openMenu(more, [
            {
              label: t("devices.ungrouped"),
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
      { label: t("devices.deleteDevice"), danger: true, onSelect: () => removeDevice(device) },
    ];
    openMenu(more, items);
  });
  actions.append(more);

  if (view.pushUrl) {
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = t("devices.copyLink");
    copy.addEventListener("click", (event) => {
      event.stopPropagation();
      flashLabel(event.currentTarget, view.pushUrl, t("devices.copyLink"));
    });
    actions.append(copy);
  }

  if (isStale(view.received)) {
    const note = document.createElement("p");
    note.className = "stale-note";
    note.textContent = t("devices.staleNote");
    body.append(note);
  }
  body.append(facts, actions);
  row.append(head, body);
  return row;
}

// The card shows only the push ID (the credential segment of the push
// URL); the full link stays in the device detail's push settings and is
// what the copy button in the actions row copies.
function pushIdOf(pushUrl) {
  const match = /\/ingest\/([^/?#]+)/.exec(pushUrl);
  if (match) return match[1];
  const segments = String(pushUrl).split("/").filter(Boolean);
  return segments.length ? segments[segments.length - 1] : String(pushUrl);
}

function pushLine(device, view) {
  const line = document.createElement("div");
  line.className = "device-id";
  if (view.pushUrl) {
    const code = document.createElement("code");
    const pushId = pushIdOf(view.pushUrl);
    code.textContent = pushId;
    code.title = pushId;
    line.append(code);
  } else {
    const span = document.createElement("span");
    span.className = "subtle";
    span.textContent =
      device?.push === "active"
        ? t("devices.legacyPushHidden")
        : device?.push === "revoked"
          ? t("devices.pushRevoked")
          : t("devices.pushNotIssued");
    line.append(span);
  }
  return line;
}

function testButton(device) {
  const test = document.createElement("button");
  test.type = "button";
  test.className = "secondary";
  test.textContent = t("devices.sendTest");
  test.addEventListener("click", async (event) => {
    event.stopPropagation();
    test.disabled = true;
    const previous = test.textContent;
    test.textContent = t("devices.sending");
    setError("");
    try {
      const sent = await api(`/api/v1/devices/${device.id}/test`, { method: "POST", body: "{}" });
      if (!sent.response.ok) {
        const message = sent.data.error || t("devices.testFailed");
        setStatus("");
        setError(message);
        toast(message, { tone: "danger" });
        return;
      }
      const code = sent.data.code || "";
      const message = code ? t("devices.testSentWithCode", { code }) : t("devices.testSent");
      setError("");
      setStatus(message);
      toast(message, { href: "/", linkLabel: t("devices.viewInbox") });
      noteDeviceSeen(device.id, Date.now());
      try {
        await loadDevices();
      } catch (error) {
        if (isUnauthorized(error)) return;
        setError(t("devices.loadFailed"));
      }
    } catch (error) {
      if (isUnauthorized(error)) return;
      setStatus("");
      setError(t("devices.testFailed"));
      toast(t("devices.testFailed"), { tone: "danger" });
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

function showLoadError(message, key = "") {
  const keep = Boolean(devices.querySelector(".device:not(.skeleton)"));
  setError(keep ? message : "");
  if (keep) return;
  listReady = false;
  listErrorKey = key;
  devices.replaceChildren(
    errorState({
      message,
      onRetry: () => {
        loadDevices().catch((error) => {
          if (isUnauthorized(error)) return;
          setError(t("devices.loadFailed"));
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
