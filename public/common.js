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

export async function logout() {
  await api("/api/v1/auth/logout", { method: "POST", body: "{}" });
  location.assign("/login.html");
}
