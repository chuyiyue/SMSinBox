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
  const diff = Date.now() - ms;
  if (diff >= 0 && diff < 60_000) return "刚刚";
  if (diff >= 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
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
  if (!code || !/^\d{4,8}$/.test(code)) {
    element.textContent = content;
    return;
  }
  const pattern = new RegExp(`(?<!\\d)${code}(?!\\d)`, "g");
  let last = 0;
  for (const match of content.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) element.append(document.createTextNode(content.slice(last, index)));
    const mark = document.createElement("mark");
    mark.className = "code";
    mark.textContent = code;
    element.append(mark);
    last = index + code.length;
  }
  if (last < content.length) element.append(document.createTextNode(content.slice(last)));
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
  for (const btn of document.querySelectorAll("#sidebar-devices [data-device-id]")) {
    btn.classList.toggle("is-active", (btn.getAttribute("data-device-id") || "") === current);
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
    empty.textContent = "还没有设备";
    box.append(empty);
    return;
  }
  for (const device of devices) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "device-link";
    btn.dataset.deviceId = device.id;
    btn.title = device.name;
    btn.textContent = device.name;
    box.append(btn);
  }
}

export function initShell(options = {}) {
  const toggle = document.querySelector("#menu-toggle");
  const backdrop = document.querySelector("#sidebar-backdrop");
  toggle?.addEventListener("click", () => {
    if (document.querySelector("#sidebar")?.classList.contains("is-open")) closeSidebar();
    else openSidebar();
  });
  backdrop?.addEventListener("click", closeSidebar);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    closeSidebar();
    options.onEscape?.();
  });
  for (const btn of document.querySelectorAll("[data-logout]")) {
    btn.addEventListener("click", () => {
      Promise.resolve(options.onLogout ? options.onLogout() : logout()).catch(() => {});
    });
  }
  document.querySelector("#refresh")?.addEventListener("click", () => {
    options.onRefresh?.();
  });
  document.querySelector("#sidebar-devices")?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-device-id]");
    if (!btn) return;
    const id = btn.getAttribute("data-device-id") || "";
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
  const link = document.querySelector("#users-link");
  if (link) link.hidden = user?.role !== "admin";
  const box = document.querySelector("#sidebar-devices");
  if (box && box.dataset.loaded !== "1") {
    const result = await api("/api/v1/devices");
    renderSidebarDevices(result.data.devices || []);
  }
  return user;
}

export async function logout() {
  await api("/api/v1/auth/logout", { method: "POST", body: "{}" });
  location.assign("/login.html");
}
