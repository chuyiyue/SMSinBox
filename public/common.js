import {
  applyTheme,
  closeMenu,
  currentTheme,
  cycleTheme,
  isTyping,
  openHelp,
  rememberFlash,
  takeFlash,
  toast,
} from "./ui.js";

export { openHelp, openMenu, openModal, passwordScore, generatePassword, toast } from "./ui.js";

const URL_RE = /https?:\/\/[^\s<>"']+/gi;

export async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { ok: false, error: "响应无法解析" };
    }
  }
  if (response.status === 401 && !options.allowUnauthorized) {
    rememberFlash("登录已过期");
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    location.assign(`/login.html?next=${next}`);
    throw new Error("unauthorized");
  }
  return { response, data };
}

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

export function isUnauthorized(error) {
  return error instanceof Error && error.message === "unauthorized";
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

export function setActiveDevice(id) {
  const current = String(id || "");
  for (const button of document.querySelectorAll("#sidebar-devices [data-device-id]")) {
    button.classList.toggle("is-active", (button.getAttribute("data-device-id") || "") === current);
  }
}

export function renderSidebarDevices(devices) {
  const box = document.querySelector("#sidebar-devices");
  if (!box) return;
  box.dataset.loaded = "1";
  box.replaceChildren();
  const all = document.createElement("button");
  all.type = "button";
  all.className = "device-link is-active";
  all.dataset.deviceId = "";
  all.textContent = "全部设备";
  box.append(all);
  if (!devices.length) {
    const empty = document.createElement("p");
    empty.className = "sidebar-empty";
    empty.textContent = "还没有设备。";
    box.append(empty);
    return;
  }
  for (const device of devices) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "device-link";
    button.dataset.deviceId = device.id;
    button.title = device.name;
    button.textContent = device.name;
    box.append(button);
  }
}

export function initShell(options = {}) {
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
  document.querySelector("#more-toggle")?.addEventListener("click", openMore);
  document.querySelector("#more-close")?.addEventListener("click", closeMore);
  document.querySelector("#more-sheet")?.addEventListener("click", (event) => {
    if (event.target?.id === "more-sheet") closeMore();
  });
  for (const button of document.querySelectorAll("[data-theme-toggle]")) {
    button.addEventListener("click", () => cycleTheme());
  }
  for (const button of document.querySelectorAll("[data-help]")) {
    button.addEventListener("click", () => {
      closeMore();
      openHelp();
    });
  }
  document.querySelector("#search-toggle")?.addEventListener("click", () => {
    const bar = document.querySelector(".topbar");
    bar?.classList.add("is-searching");
    document.querySelector(".topbar-search")?.focus();
  });
  document.addEventListener("keydown", (event) => {
    if (document.querySelector(".modal-root, dialog[open]")) return;
    if (event.key === "Escape") {
      closeMenu();
      closeMore();
      closeSidebar();
      document.querySelector(".topbar")?.classList.remove("is-searching");
      options.onEscape?.();
      return;
    }
    if (isTyping(event.target)) return;
    if (event.key === "/") {
      const search = document.querySelector(".topbar-search");
      if (!search) return;
      event.preventDefault();
      document.querySelector(".topbar")?.classList.add("is-searching");
      search.focus();
    } else if (event.key === "?") {
      event.preventDefault();
      openHelp();
    }
  });
  for (const button of document.querySelectorAll("[data-logout]")) {
    button.addEventListener("click", () => {
      Promise.resolve(options.onLogout ? options.onLogout() : logout()).catch(() => {});
    });
  }
  document.querySelector("#refresh")?.addEventListener("click", () => {
    options.onRefresh?.();
  });
  document.querySelector("#sidebar-devices")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-device-id]");
    if (!button) return;
    const id = button.getAttribute("data-device-id") || "";
    setActiveDevice(id);
    closeSidebar();
    if (options.onDeviceFilter) {
      options.onDeviceFilter(id);
      return;
    }
    const url = new URL("/", location.origin);
    if (id) url.searchParams.set("device_id", id);
    location.assign(`${url.pathname}${url.search}`);
  });
}

export async function loadNav() {
  const me = await api("/api/v1/auth/me");
  const user = me.data.user || null;
  for (const who of document.querySelectorAll("[data-who], #who")) {
    who.textContent = user?.username || "";
  }
  for (const link of document.querySelectorAll("#users-link, #users-tab")) {
    if (user?.role === "admin") link.hidden = false;
    else link.remove();
  }
  const box = document.querySelector("#sidebar-devices");
  if (box && box.dataset.loaded !== "1") {
    const result = await api("/api/v1/devices");
    if (result.response.ok) renderSidebarDevices(result.data.devices || []);
  }
  return user;
}

export async function logout() {
  await api("/api/v1/auth/logout", { method: "POST", body: "{}" });
  location.assign("/login.html");
}

function openMore() {
  const sheet = document.querySelector("#more-sheet");
  if (!sheet) return;
  sheet.hidden = false;
  document.body.classList.add("modal-open");
  document.querySelector("#more-close")?.focus();
}

function closeMore() {
  const sheet = document.querySelector("#more-sheet");
  if (!sheet || sheet.hidden) return;
  sheet.hidden = true;
  document.body.classList.remove("modal-open");
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
