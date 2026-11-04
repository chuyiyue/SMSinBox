import {
  clearShellCache,
  deviceStateOf,
  ensureMe,
  getActiveId,
  getDevices,
  getMe,
  setActiveId,
} from "./device-store.js";
import { api } from "./api-client.js";
import {
  applyTheme,
  closeMenu,
  currentTheme,
  cycleTheme,
  isTyping,
  openHelp,
  takeFlash,
  toast,
} from "./ui.js";
import { selectSidebarDevices, sidebarDeviceIcon } from "./device-panel.js";
import { applyI18n, currentLocale, formatAbsoluteStamp, formatMinuteStamp, formatRelative, setLocale, t } from "./i18n.js";

export { api, isUnauthorized, openEventStream } from "./api-client.js";
export { applyI18n, currentLocale, setLocale, t };
export { mountSelect, openHelp, openMenu, openModal, passwordScore, generatePassword, selectContents, toast } from "./ui.js";

const URL_RE = /https?:\/\/[^\s<>"']+/gi;

export function safeNext(value) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (value.startsWith("/login")) return "/";
  return value;
}

export function formatTime(ms) {
  return formatRelative(ms, Date.now());
}

export function absoluteTime(ms) {
  return formatAbsoluteStamp(ms);
}

// Inbox rows and details use only the device receive time, to the minute,
// in the browser's own timezone. Never build it from created_at.
export function formatDateTime(ms) {
  return formatMinuteStamp(ms);
}

// Kept for callers that adopted the earlier helper name.
export function minuteStamp(ms) {
  return formatDateTime(ms);
}

export function receivedStamp(ms) {
  const text = formatDateTime(ms);
  return text ? t("time.receivedAt", { time: text }) : "";
}

export function showNotice(element, message) {
  if (!element) return;
  const text = message ? String(message) : "";
  element.hidden = text.length === 0;
  element.textContent = text;
}

export function emptyParagraph(text) {
  const empty = document.createElement("p");
  empty.className = "empty";
  empty.textContent = text;
  return empty;
}

export async function flashLabel(button, value, label) {
  if (!button) return false;
  let copied = false;
  try {
    await copyText(value);
    copied = true;
    button.textContent = t("common.copied");
    button.classList.add("is-copied");
  } catch {
    button.textContent = t("common.copyManual");
    button.classList.remove("is-copied");
  }
  window.setTimeout(() => {
    button.textContent = label;
    button.classList.remove("is-copied");
  }, 1500);
  return copied;
}

export async function copyText(value) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const area = document.createElement("textarea");
  area.value = value;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.left = "-9999px";
  document.body.append(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (!copied) throw new Error("copy failed");
}

export function renderContent(element, content, code) {
  element.replaceChildren();
  appendRich(element, String(content ?? ""), code);
}

export function closeSidebar() {
  document.querySelector("#sidebar")?.classList.remove("is-open");
  const backdrop = document.querySelector("#sidebar-backdrop");
  if (backdrop) backdrop.hidden = true;
  document.querySelector("#menu-toggle")?.setAttribute("aria-expanded", "false");
  document.body.classList.remove("nav-open");
}

export function openSidebar() {
  document.querySelector("#sidebar")?.classList.add("is-open");
  const backdrop = document.querySelector("#sidebar-backdrop");
  if (backdrop) backdrop.hidden = false;
  document.querySelector("#menu-toggle")?.setAttribute("aria-expanded", "true");
  document.body.classList.add("nav-open");
}

let shellHooks = {};
let shellBound = false;
let navigateTo = (href) => {
  location.assign(href);
};

export function setNavigator(navigate) {
  navigateTo = navigate;
}

export function followAppLink(href) {
  navigateTo(href);
}

export function setActiveDevice(id) {
  const current = String(id || "");
  for (const button of document.querySelectorAll("#sidebar-devices [data-device-id]")) {
    button.classList.toggle("is-active", (button.getAttribute("data-device-id") || "") === current);
  }
}

export function paintDevicePresence(id) {
  const device = getDevices().find((item) => item.id === id);
  const button = deviceButton(id);
  if (!device || !button) return;
  paintState(button, device);
}

export function clearSidebarDevices() {
  document.querySelector("#sidebar-devices")?.replaceChildren();
}

export function renderSidebarDevices(devices, activeId = getActiveId()) {
  const box = document.querySelector("#sidebar-devices");
  if (!box) return;
  const active = String(activeId || "");
  // Plain capped list (no collapsing, no "view all" row): pinned
  // devices when any exist, else the first ones.
  const selection = selectSidebarDevices(devices || []);
  const rows = [];
  for (const device of selection.shown) {
    rows.push({
      id: String(device.id),
      key: String(device.id),
      name: String(device.name || t("common.unnamedDevice")),
      device,
    });
  }
  const wanted = new Set(rows.map((row) => row.key));
  for (const node of [...box.querySelectorAll(":scope > [data-key]")]) {
    if (!wanted.has(node.getAttribute("data-key") || "")) node.remove();
  }
  rows.forEach((row, index) => {
    const buttons = () => [...box.querySelectorAll(":scope > [data-key]")];
    let button = buttons().find((node) => (node.getAttribute("data-key") || "") === row.key);
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "device-link";
      button.dataset.deviceId = row.id;
      button.dataset.key = row.key;
    }
    // The id only lives in the data attribute; text and title stay human.
    button.classList.toggle("is-active", row.id === active);
    button.title = row.name;
    paintLabel(button, row.name, row.device);
    paintState(button, row.device);
    const current = buttons();
    if (current[index] !== button) box.insertBefore(button, current[index] || box.querySelector(".sidebar-empty"));
  });
  let empty = box.querySelector(".sidebar-empty");
  if (!devices?.length) {
    if (!empty) {
      empty = document.createElement("p");
      empty.className = "sidebar-empty";
      empty.textContent = t("devices.sidebarEmpty");
      empty.setAttribute("data-i18n", "devices.sidebarEmpty");
      box.append(empty);
    }
  } else {
    empty?.remove();
  }
  // Rows painted by older versions may linger; drop any stale "…" row.
  box.querySelector(".device-more")?.remove();
}

export function initShell(options = {}) {
  shellHooks = options;
  applyI18n(document);
  if (shellBound) return;
  shellBound = true;
  applyTheme(currentTheme());
  document.addEventListener("smsinbox:locale", () => {
    applyTheme(currentTheme());
    renderSidebarDevices(getDevices(), getActiveId());
    const user = getMe();
    if (user) paintSidebarProfile(user);
  });
  const flash = takeFlash();
  if (flash) toast(flash, { tone: "danger" });
  document.querySelector("#sidebar")?.addEventListener("click", (event) => {
    if (event.target.closest("a[href]")) closeSidebar();
  });
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    // The shell replaces .main (topbar included) on every in-app
    // navigation, so controls living there MUST be handled by delegation:
    // a listener bound to the node itself dies with the swapped-out copy
    // and the button goes dead on every later page.
    if (target.closest("#menu-toggle")) {
      if (document.querySelector("#sidebar")?.classList.contains("is-open")) closeSidebar();
      else openSidebar();
    }
    if (target.closest("#sidebar-backdrop")) closeSidebar();
    if (target.closest("[data-theme-toggle]")) cycleTheme();
    if (target.closest("[data-help]")) openHelp();
    if (target.closest("#refresh")) shellHooks.onRefresh?.();
    if (target.closest("#search-toggle")) openSearch();
  });
  document.addEventListener("keydown", (event) => {
    if (document.querySelector(".modal-root, dialog[open], .ui-drawer")) return;
    if (event.key === "Escape") {
      closeMenu();
      closeSidebar();
      document.querySelector(".topbar")?.classList.remove("is-searching");
      shellHooks.onEscape?.();
      return;
    }
    if (isTyping(event.target)) return;
    if (event.key === "/") {
      const search = document.querySelector(".topbar-search");
      if (!search) return;
      event.preventDefault();
      openSearch();
    } else if (event.key === "?") {
      event.preventDefault();
      openHelp();
    }
  });
  for (const button of document.querySelectorAll("[data-logout]")) {
    button.addEventListener("click", () => {
      Promise.resolve(shellHooks.onLogout ? shellHooks.onLogout() : logout()).catch(() => {});
    });
  }
  document.querySelector("#sidebar-devices")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-device-id]");
    if (!button) return;
    const id = button.getAttribute("data-device-id") || "";
    setActiveId(id);
    closeSidebar();
    // The sidebar is the quick path: pop the detail drawer right here, on
    // whatever page is showing, instead of navigating to the devices page.
    const device = id ? getDevices().find((item) => item.id === id) : null;
    if (!device) {
      followAppLink("/devices.html");
      return;
    }
    void import("./device-detail.js")
      .then((detail) => detail.openDeviceDetail(device))
      .catch(() => followAppLink(`/devices.html#dev-${encodeURIComponent(id)}`));
  });
  void renderSidebarProfile().catch(() => {});
}

export async function loadNav() {
  const result = await ensureMe();
  return result?.user || getMe() || null;
}

async function renderSidebarProfile() {
  const user = await loadNav();
  paintSidebarProfile(user);
}

export function paintSidebarProfile(user) {
  const footer = document.querySelector(".sidebar-footer");
  if (!footer) return;
  const profileUsername =
    user && typeof user.profile_username === "string" ? user.profile_username.trim() : "";
  const name = profileUsername || (user && (user.username || user.name)) || t("nav.admin");
  const avatar = footer.querySelector(".account-avatar");
  const label = footer.querySelector(".account-name");
  const accountBtn = footer.querySelector(".account-btn");
  if (avatar) paintSidebarAvatar(avatar, name, profileUsername, user);
  if (label) label.textContent = name;
  const title = t("nav.accountTitle", { name });
  if (accountBtn) {
    accountBtn.title = title;
    accountBtn.setAttribute("aria-label", title);
  }
}

export function paintSidebarAvatar(avatar, name, profileUsername, user = null) {
  const initial = initialOf(name);
  // Priority: the uploaded custom avatar, then the bound GitHub account's
  // avatar, then the name-based chain below. Any source that fails to load
  // steps down to the next one.
  const sources = [];
  const custom = user && typeof user.avatar_data === "string" ? user.avatar_data : "";
  if (custom) sources.push(custom);
  const githubAvatar =
    user && user.github && typeof user.github.avatar_url === "string" ? user.github.avatar_url : "";
  if (githubAvatar) sources.push(githubAvatar);
  if (profileUsername) {
    // Layered by design — no single URL is trusted to resolve for every
    // name: a GitHub photo when the name is a real GitHub handle, then a
    // DiceBear initials avatar generated from the name (any string works,
    // same name always renders the same image), then the local initial.
    sources.push(
      `https://github.com/${encodeURIComponent(profileUsername)}.png?s=96`,
      `https://api.dicebear.com/10.x/initials/svg?seed=${encodeURIComponent(profileUsername)}`,
    );
  }
  if (!sources.length) {
    avatar.textContent = initial;
    return;
  }
  const img = document.createElement("img");
  img.alt = "";
  let step = 0;
  img.addEventListener("error", () => {
    step += 1;
    if (step < sources.length) {
      img.src = sources[step];
      return;
    }
    avatar.textContent = initial;
  });
  img.src = sources[0];
  avatar.replaceChildren(img);
}

function initialOf(name) {
  const value = String(name || "").trim();
  return value ? [...value][0].toUpperCase() : t("nav.adminInitial");
}


export async function logout() {
  clearShellCache();
  await api("/api/v1/auth/logout", { method: "POST", body: "{}" });
  location.assign("/login.html");
}

function openSearch() {
  document.querySelector(".topbar")?.classList.add("is-searching");
  document.querySelector(".topbar-search")?.focus();
}

function deviceButton(id) {
  return [...document.querySelectorAll("#sidebar-devices [data-device-id]")].find(
    (node) => (node.getAttribute("data-device-id") || "") === String(id || ""),
  );
}

function paintLabel(button, name, device) {
  let title = button.querySelector(".device-name");
  if (!title) {
    button.replaceChildren();
    const dot = document.createElement("span");
    dot.className = "ui-status-dot";
    dot.setAttribute("aria-hidden", "true");
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("class", "icon device-type-icon");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `/icons.svg#${sidebarDeviceIcon(device)}`);
    icon.append(use);
    title = document.createElement("span");
    title.className = "device-name";
    const state = document.createElement("span");
    state.className = "device-state";
    button.append(dot, icon, title, state);
  } else {
    // Keep the type icon current when the stored type changes.
    const use = button.querySelector(".device-type-icon use");
    if (use) use.setAttribute("href", `/icons.svg#${sidebarDeviceIcon(device)}`);
  }
  if (title.textContent !== name) title.textContent = name;
}

function paintState(button, device) {
  const state = deviceStateOf(device);
  const dotStatus = state.key === "recent" ? "ok" : "idle";
  const dotLabel = state.key === "recent" ? t("devices.online") : (state.key === "stale" ? t("devices.offline") : t("devices.unreported"));
  const dot = button.querySelector(".ui-status-dot");
  if (dot && dot.getAttribute("data-status") !== dotStatus) {
    dot.setAttribute("data-status", dotStatus);
  }
  const node = button.querySelector(".device-state");
  if (node && node.textContent !== state.text) node.textContent = state.text;
  if (button.getAttribute("data-state") !== state.key) button.setAttribute("data-state", state.key);
  const name = button.querySelector(".device-name")?.textContent || "";
  button.title = name ? `${name} (${dotLabel} · ${state.text})` : state.text;
}

function appendRich(parent, content, code) {
  if (!code || !/^\d{4,8}$/.test(code)) {
    appendLinked(parent, content);
    return;
  }
  const pattern = new RegExp(`(?<!\\d)${code}(?!\\d)`, "g");
  let last = 0;
  for (const match of content.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) appendLinked(parent, content.slice(last, index));
    const mark = document.createElement("mark");
    mark.className = "code";
    mark.textContent = code;
    parent.append(mark);
    last = index + code.length;
  }
  if (last < content.length) appendLinked(parent, content.slice(last));
}

function appendLinked(parent, text) {
  let last = 0;
  for (const match of text.matchAll(new RegExp(URL_RE.source, "gi"))) {
    const index = match.index ?? 0;
    if (index > last) parent.append(document.createTextNode(text.slice(last, index)));
    let href = match[0];
    let trailing = "";
    while (/[.,);:，。、]$/.test(href)) {
      trailing = href.slice(-1) + trailing;
      href = href.slice(0, -1);
    }
    const link = document.createElement("a");
    link.href = href;
    link.textContent = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    parent.append(link);
    if (trailing) parent.append(document.createTextNode(trailing));
    last = index + match[0].length;
  }
  if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
}

// ─── Shared UI components ────────────────────────────────────────────────────

let drawerState = null;

export function openDrawer({ title = "", bodyHTML = "", onClose = null } = {}) {
  closeDrawer();
  const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const root = document.createElement("div");
  root.className = "ui-drawer";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  const titleId = `ui-drawer-${Math.random().toString(36).slice(2, 8)}`;
  root.setAttribute("aria-labelledby", titleId);

  const overlay = document.createElement("div");
  overlay.className = "ui-drawer-overlay";
  overlay.setAttribute("aria-hidden", "true");
  overlay.addEventListener("click", closeDrawer);

  const panel = document.createElement("div");
  panel.className = "ui-drawer-panel";

  const head = document.createElement("header");
  head.className = "ui-drawer-head";
  const heading = document.createElement("h2");
  heading.id = titleId;
  heading.className = "ui-drawer-title";
  heading.textContent = String(title);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "ui-drawer-close secondary";
  close.textContent = t("common.close");
  close.addEventListener("click", closeDrawer);
  head.append(heading, close);

  const body = document.createElement("div");
  body.className = "ui-drawer-body";
  if (typeof bodyHTML === "string") body.innerHTML = bodyHTML;
  else if (bodyHTML?.nodeType) body.append(bodyHTML);

  panel.append(head, body);
  root.append(overlay, panel);
  document.body.append(root);
  document.body.classList.add("drawer-open");

  const onKey = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closeDrawer();
  };
  document.addEventListener("keydown", onKey, true);
  drawerState = { root, trigger, onKey, onClose };
  (panel.querySelector("button, input, select, textarea, a[href]") || close).focus();
  return root;
}

export function closeDrawer() {
  if (!drawerState) return;
  const { root, trigger, onKey, onClose } = drawerState;
  drawerState = null;
  document.removeEventListener("keydown", onKey, true);
  root.remove();
  document.body.classList.remove("drawer-open");
  if (trigger?.isConnected) trigger.focus();
  onClose?.();
}

export function CodeChip(code) {
  const value = String(code ?? "");
  const box = document.createElement("span");
  box.className = "ui-codechip";
  const chip = document.createElement("span");
  chip.className = "ui-codechip-code";
  chip.textContent = value;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "ui-codechip-copy secondary";
  copy.textContent = t("common.copy");
  copy.addEventListener("click", async (event) => {
    event.stopPropagation();
    const copied = await flashLabel(copy, value, t("common.copy"));
    if (copied) toast(t("common.copiedCode", { code: value }));
    else toast(t("common.copyFailed"), { tone: "danger" });
  });
  box.append(chip, copy);
  return box;
}

export function statusDot(status, label = "") {
  const dot = document.createElement("span");
  dot.className = "ui-status-dot";
  dot.setAttribute("data-status", status === "warn" ? "warn" : status === "bad" ? "bad" : "ok");
  if (!label) return dot;
  const wrap = document.createElement("span");
  wrap.className = "ui-status";
  wrap.append(dot);
  const text = document.createElement("span");
  text.textContent = String(label);
  wrap.append(text);
  return wrap;
}

export function emptyState({ title = "", text = "", actions = [] } = {}) {
  const box = document.createElement("div");
  box.className = "empty-state";
  if (title) {
    const heading = document.createElement("h2");
    heading.className = "empty-title";
    heading.textContent = String(title);
    box.append(heading);
  }
  if (text) {
    const paragraph = document.createElement("p");
    paragraph.textContent = String(text);
    box.append(paragraph);
  }
  if (actions.length) {
    const wrap = document.createElement("div");
    wrap.className = "empty-actions";
    for (const action of actions) if (action?.nodeType) wrap.append(action);
    box.append(wrap);
  }
  return box;
}

// ─── Shared state components: loading / load failure ────────────────────────
//
// Every list view renders its loading and load-failure states through these
// three components instead of hand-building the DOM per page:
//   loadingState — a fragment of skeleton rows for a pending list.
//   errorState   — the centered failure block (message + retry button),
//                  built on emptyState so all pages share one structure.
//   errorBanner  — fills a page's .callout danger box with a message and
//                  an optional retry button (banner-style failure).

export function loadingState({ count = 3, className = "skeleton", ariaHidden = false } = {}) {
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < count; index += 1) {
    const row = document.createElement("div");
    row.className = className;
    if (ariaHidden) row.setAttribute("aria-hidden", "true");
    fragment.append(row);
  }
  return fragment;
}

export function errorState({ message = "", onRetry = null, retryLabel = "" } = {}) {
  const actions = [];
  if (onRetry) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = retryLabel || t("common.retry");
    button.addEventListener("click", () => {
      onRetry();
    });
    actions.push(button);
  }
  return emptyState({ text: message, actions });
}

export function errorBanner(element, message, onRetry = null) {
  if (!element) return;
  element.hidden = false;
  element.replaceChildren();
  const text = document.createElement("span");
  text.textContent = String(message || "");
  element.append(text);
  if (onRetry) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "secondary";
    retry.textContent = t("common.retry");
    retry.addEventListener("click", () => {
      onRetry();
    });
    element.append(retry);
  }
}
