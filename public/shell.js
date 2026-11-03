import "./registry.js";
import { closeSidebar, clearSidebarDevices, paintDevicePresence, renderSidebarDevices, setActiveDevice, setNavigator } from "./common.js";
import {
  devicesKnown,
  ensureDevices,
  getActiveId,
  getDevices,
  hydrateShell,
  subscribeDevices,
} from "./device-store.js";
import { closeMenu } from "./ui.js";

// The route map is generated from the single module registry in
// public/registry.js (imported above and also loaded before sidebar-boot.js
// on every page): href -> the view script the shell lazy-loads for it.
const VIEWS = Object.fromEntries(
  (globalThis.SMSINBOX_MODULES || []).map((item) => [item.href, item.script]),
);

// Exported so tests can assert the generated route map without a DOM.
export const VIEW_SCRIPTS = VIEWS;

const PORTALS = ["#message-drawer", "#device-dialog", "#notify-dialog", "#token-dialog"];

const views = new Map();
let shellReady = false;
let navigating = 0;
let navSeq = 0;
let navAbort = null;
let cleanupView = null;
let lastKey = "";

export function canonicalPath(pathname) {
  if (pathname === "/" || pathname === "/index.html") return "/";
  return pathname;
}

export function registerView(path, start) {
  const key = canonicalPath(path);
  views.set(key, start);
  installShell();
  if (navigating > 0) return;
  if (canonicalPath(location.pathname) === key) runStart(start);
}

export function syncShellHistory() {
  lastKey = canonicalPath(location.pathname) + location.search;
}

export function go(href, options = {}) {
  return navigate(href, options);
}

function installShell() {
  if (shellReady) return;
  shellReady = true;
  hydrateShell();
  syncShellHistory();
  subscribeDevices((event) => {
    if (event?.type === "presence") {
      paintDevicePresence(event.id);
      return;
    }
    if (event?.type === "active") {
      setActiveDevice(getActiveId());
      return;
    }
    if (event?.type === "cleared") {
      clearSidebarDevices();
      return;
    }
    if (!devicesKnown() && getDevices().length === 0) return;
    renderSidebarDevices(getDevices(), getActiveId());
  });
  if (devicesKnown() || getDevices().length > 0) renderSidebarDevices(getDevices(), getActiveId());
  setNavigator((href, options) => navigate(href, options || {}));
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("submit", onDocumentSubmit);
  window.addEventListener("popstate", onPopState);
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  void ensureDevices().catch(() => {});
}

function onDocumentClick(event) {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!link || link.target || link.hasAttribute("download")) return;
  const url = new URL(link.href, location.origin);
  if (url.origin !== location.origin || !VIEWS[canonicalPath(url.pathname)]) return;
  const same = canonicalPath(url.pathname) === canonicalPath(location.pathname) && url.search === location.search;
  if (same) {
    if (url.hash && url.hash !== location.hash) return;
    event.preventDefault();
    return;
  }
  event.preventDefault();
  void navigate(url);
}

function onDocumentSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || event.defaultPrevented) return;
  const method = (form.getAttribute("method") || "get").toLowerCase();
  if (method !== "get") return;
  const action = new URL(form.action, location.origin);
  if (action.origin !== location.origin || !VIEWS[canonicalPath(action.pathname)]) return;
  event.preventDefault();
  const params = new URLSearchParams(new FormData(form));
  const query = params.toString();
  const path = canonicalPath(action.pathname);
  void navigate(query ? `${path}?${query}` : path);
}

function onPopState() {
  const path = canonicalPath(location.pathname);
  if (!VIEWS[path]) {
    location.reload();
    return;
  }
  const nextKey = path + location.search;
  if (nextKey === lastKey) return;
  void navigate(location, { history: "pop" });
}

async function navigate(href, options = {}) {
  const url = href instanceof URL ? href : new URL(href, location.origin);
  const path = canonicalPath(url.pathname);
  const script = VIEWS[path];
  const historyMode = options.history || (options.replace ? "replace" : "push");
  const nextKey = path + url.search;
  if (!script) {
    location.assign(url.href);
    return;
  }
  if (historyMode !== "pop" && nextKey === lastKey && !options.force) {
    if (url.hash) location.hash = url.hash;
    return;
  }
  const ticket = ++navSeq;
  navigating += 1;
  navAbort?.abort();
  const controller = new AbortController();
  navAbort = controller;
  try {
    let response;
    try {
      response = await fetch(path, {
        headers: { accept: "text/html" },
        credentials: "same-origin",
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === "AbortError" || ticket !== navSeq) return;
      location.assign(`${path}${url.search}${url.hash}`);
      return;
    }
    if (ticket !== navSeq) return;
    if (response.redirected && new URL(response.url).pathname.includes("login")) {
      location.assign(response.url);
      return;
    }
    if (!response.ok) {
      location.assign(`${path}${url.search}${url.hash}`);
      return;
    }
    const html = await response.text();
    if (ticket !== navSeq) return;
    const doc = new DOMParser().parseFromString(html, "text/html");
    const main = doc.querySelector(".app-layout > .main");
    if (!main) {
      location.assign(`${path}${url.search}${url.hash}`);
      return;
    }
    main.querySelectorAll("script").forEach((node) => node.remove());
    runCleanup();
    document.querySelector(".app-layout > .main")?.replaceWith(document.importNode(main, true));
    swapPortals(doc);
    if (doc.title) document.title = doc.title;
    markActiveNav(path);
    closeMenu();
    closeSidebar();
    document.querySelector(".modal-root")?.remove();
    document.body.classList.remove("modal-open", "drawer-open", "nav-open");
    const nextUrl = `${path}${url.search}${url.hash}`;
    if (historyMode === "push") history.pushState({ shell: 1 }, "", nextUrl);
    else if (historyMode === "replace") history.replaceState({ shell: 1 }, "", nextUrl);
    syncShellHistory();
    if (!views.has(path)) await import(script);
    if (ticket !== navSeq) return;
    const start = views.get(path);
    if (!start) {
      location.assign(nextUrl);
      return;
    }
    runStart(start);
    if (!url.hash) window.scrollTo(0, 0);
    else document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView();
  } finally {
    navigating -= 1;
  }
}

function runStart(start) {
  runCleanup();
  const next = start();
  cleanupView = typeof next === "function" ? next : null;
}

function runCleanup() {
  const cleanup = cleanupView;
  cleanupView = null;
  try {
    cleanup?.();
  } catch {
    // Leaving a view should still swap the page.
  }
}

function swapPortals(doc) {
  for (const selector of PORTALS) {
    document.querySelector(selector)?.remove();
    const next = doc.querySelector(selector);
    if (!next) continue;
    next.querySelectorAll("script").forEach((node) => node.remove());
    document.body.append(document.importNode(next, true));
  }
}

function markActiveNav(path) {
  for (const link of document.querySelectorAll(".sidebar-nav a")) {
    const href = link.getAttribute("href") || "";
    let linkPath = "";
    try {
      linkPath = canonicalPath(new URL(href, location.origin).pathname);
    } catch {
      continue;
    }
    const on = linkPath === path;
    link.classList.toggle("active", on);
    if (on) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  // System management is not a nav entry; its entry point is the sidebar
  // account button, which carries the current-page state instead.
  const account = document.querySelector(".account-btn");
  if (account) {
    const on = path === "/users.html";
    account.classList.toggle("active", on);
    if (on) account.setAttribute("aria-current", "page");
    else account.removeAttribute("aria-current");
  }
}
