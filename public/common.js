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

export { api, isUnauthorized, openEventStream } from "./api-client.js";
export { openHelp, openMenu, openModal, passwordScore, generatePassword, toast } from "./ui.js";

const URL_RE = /https?:\/\/[^\s<>"']+/gi;

export function safeNext(value) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (value.startsWith("/login")) return "/";
  return value;
}

export function formatTime(ms) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  const diff = Date.now() - ms;
  if (diff >= 0 && diff < 60_000) return "刚刚";
  if (diff >= 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const now = new Date();
  if (sameDay(date, now)) return clock;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return `昨天 ${clock}`;
  const monthDay = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
  if (date.getFullYear() === now.getFullYear()) return monthDay;
  return `${date.getFullYear()}-${monthDay}`;
}

export function absoluteTime(ms) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  const text = date.toLocaleString("zh-CN", {
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  let zone = "";
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    zone = "";
  }
  return zone ? `${text}（${zone}）` : text;
}

// Inbox rows and details use only the device receive time, to the minute,
// in the browser's own timezone. Never build it from created_at.
export function formatDateTime(ms) {
  const date = new Date(Number(ms));
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

// Kept for callers that adopted the earlier helper name.
export function minuteStamp(ms) {
  return formatDateTime(ms);
}

export function receivedStamp(ms) {
  const text = formatDateTime(ms);
  return text ? `收到时间 ${text}` : "";
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
    button.textContent = "已复制 ✓";
    button.classList.add("is-copied");
  } catch {
    button.textContent = "请手动复制";
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
  const rows = [{ id: "", key: "all", name: "全部设备", device: null }];
  for (const device of devices || []) {
    if (!device?.id) continue;
    rows.push({
      id: String(device.id),
      key: String(device.id),
      name: String(device.name || "未命名设备"),
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
    if (row.device) {
      button.title = row.name;
      paintLabel(button, row.name);
      paintState(button, row.device);
    } else {
      button.removeAttribute("title");
      button.removeAttribute("data-state");
      button.textContent = row.name;
    }
    const current = buttons();
    if (current[index] !== button) box.insertBefore(button, current[index] || box.querySelector(".sidebar-empty"));
  });
  let empty = box.querySelector(".sidebar-empty");
  if (!devices?.length) {
    if (!empty) {
      empty = document.createElement("p");
      empty.className = "sidebar-empty";
      empty.textContent = "还没有设备。";
      box.append(empty);
    }
  } else {
    empty?.remove();
  }
}

export function initShell(options = {}) {
  shellHooks = options;
  if (shellBound) return;
  shellBound = true;
  applyTheme(currentTheme());
  const flash = takeFlash();
  if (flash) toast(flash, { tone: "danger" });
  const toggle = document.querySelector("#menu-toggle");
  const backdrop = document.querySelector("#sidebar-backdrop");
  toggle?.addEventListener("click", () => {
    if (document.querySelector("#sidebar")?.classList.contains("is-open")) closeSidebar();
    else openSidebar();
  });
  backdrop?.addEventListener("click", closeSidebar);
  document.querySelector("#sidebar")?.addEventListener("click", (event) => {
    if (event.target.closest("a[href]")) closeSidebar();
  });
  for (const button of document.querySelectorAll("[data-theme-toggle]")) {
    button.addEventListener("click", () => cycleTheme());
  }
  for (const button of document.querySelectorAll("[data-help]")) {
    button.addEventListener("click", openHelp);
  }
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
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
    followAppLink(id ? `/devices.html#dev-${encodeURIComponent(id)}` : "/devices.html");
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

function paintSidebarProfile(user) {
  const footer = document.querySelector(".sidebar-footer");
  if (!footer) return;
  const name = (user && (user.username || user.name)) || "管理员";
  const avatar = footer.querySelector(".account-avatar");
  const label = footer.querySelector(".account-name");
  const accountBtn = footer.querySelector(".account-btn");
  if (avatar) avatar.textContent = initialOf(name);
  if (label) label.textContent = name;
  const title = `${name} · 系统管理`;
  if (accountBtn) {
    accountBtn.title = title;
    accountBtn.setAttribute("aria-label", title);
  }
}

function initialOf(name) {
  const value = String(name || "").trim();
  return value ? [...value][0].toUpperCase() : "管";
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

function paintLabel(button, name) {
  let title = button.querySelector(".device-name");
  if (!title) {
    button.replaceChildren();
    const dot = document.createElement("span");
    dot.className = "ui-status-dot";
    dot.setAttribute("aria-hidden", "true");
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("class", "icon");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "/icons.svg#icon-smartphone");
    icon.append(use);
    title = document.createElement("span");
    title.className = "device-name";
    const state = document.createElement("span");
    state.className = "device-state";
    button.append(dot, icon, title, state);
  }
  if (title.textContent !== name) title.textContent = name;
}

function paintState(button, device) {
  const state = deviceStateOf(device);
  const dotStatus = state.key === "recent" ? "ok" : "idle";
  const dotLabel = state.key === "recent" ? "在线" : (state.key === "stale" ? "离线" : "未上报");
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

function pad(value) {
  return String(value).padStart(2, "0");
}

function sameDay(left, right) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
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
  close.textContent = "关闭";
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

function codeSourceLabel(source) {
  if (source === "regex") return "正则识别";
  if (source === "workers-ai") return "AI 识别";
  return "";
}

export function CodeChip(code, source) {
  const value = String(code ?? "");
  const box = document.createElement("span");
  box.className = "ui-codechip";
  const chip = document.createElement("span");
  chip.className = "ui-codechip-code";
  chip.textContent = value;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "ui-codechip-copy secondary";
  copy.textContent = "复制";
  copy.addEventListener("click", async (event) => {
    event.stopPropagation();
    const copied = await flashLabel(copy, value, "复制");
    if (copied) toast(`验证码 ${value} 已复制`);
    else toast("复制失败，请手动复制", { tone: "danger" });
  });
  box.append(chip, copy);
  const label = codeSourceLabel(source);
  if (label) {
    const badge = document.createElement("span");
    badge.className = "ui-codechip-source";
    badge.textContent = label;
    box.append(badge);
  }
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

export function errorState({ message = "", onRetry = null, retryLabel = "重试" } = {}) {
  const actions = [];
  if (onRetry) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = retryLabel;
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
    retry.textContent = "重试";
    retry.addEventListener("click", () => {
      onRetry();
    });
    element.append(retry);
  }
}
