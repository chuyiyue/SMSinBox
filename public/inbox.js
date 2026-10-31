import {
  api,
  copyText,
  formatTime,
  initShell,
  loadNav,
  logout,
  renderContent,
  renderSidebarDevices,
  setActiveDevice,
} from "./common.js";

const FALLBACK_MS = 30_000;
const state = {
  page: 1,
  pageSize: 20,
  total: 0,
  loading: false,
  live: null,
  fallback: 0,
  cursor: "",
  liveStatus: "正在连接",
  searchNote: "",
  expectReconnect: false,
  pending: false,
  seen: new Set(),
};

const filters = document.querySelector("#filters");
const list = document.querySelector("#list");
const summary = document.querySelector("#summary");
const errorBox = document.querySelector("#inbox-error");
const pageLabel = document.querySelector("#page-label");
const deviceSelect = document.querySelector("#device");
const banner = document.querySelector("#live-banner");
const drawer = document.querySelector("#message-drawer");
const drawerSender = document.querySelector("#drawer-sender");
const drawerTime = document.querySelector("#drawer-time");
const drawerMeta = document.querySelector("#drawer-meta");
const drawerCode = document.querySelector("#drawer-code");
const drawerBody = document.querySelector("#drawer-body");

initShell({
  onLogout() {
    stopRealtime();
    return logout().catch(() => {
      errorBox.textContent = "退出失败";
      errorBox.hidden = false;
    });
  },
  onRefresh() {
    banner.hidden = true;
    loadMessages().catch(showError);
  },
  onDeviceFilter(id) {
    deviceSelect.value = id;
    state.page = 1;
    banner.hidden = true;
    loadMessages().catch(showError);
  },
});
document.querySelector("#drawer-close")?.addEventListener("click", closeDrawer);
drawer?.addEventListener("click", (event) => {
  if (event.target === drawer) closeDrawer();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDrawer();
});
document.querySelector("#prev").addEventListener("click", () => {
  if (state.page > 1) {
    state.page -= 1;
    loadMessages().catch(showError);
  }
});
document.querySelector("#next").addEventListener("click", () => {
  const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
  if (state.page < pages) {
    state.page += 1;
    loadMessages().catch(showError);
  }
});
banner.addEventListener("click", () => {
  banner.hidden = true;
  state.page = 1;
  loadMessages().catch(showError);
});
filters.addEventListener("submit", (event) => {
  event.preventDefault();
  state.page = 1;
  banner.hidden = true;
  setActiveDevice(deviceSelect.value);
  loadMessages().catch(showError);
});

boot().catch((error) => {
  if (error instanceof Error && error.message === "unauthorized") return;
  showError(error);
});

async function boot() {
  await loadDevices();
  await loadMessages();
  startRealtime();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopRealtime();
      return;
    }
    loadMessages()
      .then(() => startRealtime())
      .catch(showError);
  });
}

function startRealtime() {
  stopRealtime();
  if (!state.cursor) state.cursor = `${Date.now()}:`;
  const source = new EventSource(`/api/v1/events?cursor=${encodeURIComponent(state.cursor)}`);
  state.live = source;
  source.onopen = () => {
    state.expectReconnect = false;
    setLiveStatus("实时更新");
  };
  source.addEventListener("message", (event) => {
    let payload = null;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!payload?.message) return;
    onLiveMessage(payload.message).catch(showError);
  });
  source.addEventListener("bye", () => {
    state.expectReconnect = true;
    setLiveStatus("实时更新");
  });
  source.onerror = () => {
    if (state.expectReconnect) {
      state.expectReconnect = false;
      setLiveStatus("实时更新");
      return;
    }
    setLiveStatus("实时连接中断，将自动重试");
  };
  state.fallback = window.setInterval(() => {
    if (state.page === 1 && !state.loading) loadMessages().catch(showError);
  }, FALLBACK_MS);
}

function stopRealtime() {
  state.live?.close();
  state.live = null;
  window.clearInterval(state.fallback);
  state.fallback = 0;
}

async function onLiveMessage(message) {
  if (!message?.id || state.seen.has(message.id)) return;
  state.seen.add(message.id);
  const next = `${message.created_at}:${message.id}`;
  if (cursorIsNewer(next, state.cursor)) state.cursor = next;
  if (!matchesFilters(message)) return;
  if (state.page !== 1) {
    banner.hidden = false;
    return;
  }
  if (state.loading) {
    state.pending = true;
    return;
  }
  await loadMessages();
  if (state.pending) {
    state.pending = false;
    await loadMessages();
  }
}

function matchesFilters(message) {
  const params = new FormData(filters);
  const device = String(params.get("device_id") || "");
  const from = String(params.get("from") || "").trim();
  const query = String(params.get("q") || "").trim().toLowerCase();
  if (device && message.device_id !== device) return false;
  if (from && message.from_number !== from) return false;
  if (!query) return true;
  const haystack = `${message.content}\n${message.from_number}\n${message.code || ""}`.toLowerCase();
  return haystack.includes(query);
}

async function loadDevices() {
  const result = await api("/api/v1/devices");
  const params = new URLSearchParams(location.search);
  const current = params.get("device_id") || deviceSelect.value;
  deviceSelect.replaceChildren(new Option("全部设备", ""));
  for (const device of result.data.devices || []) {
    deviceSelect.append(new Option(device.name, device.id));
  }
  if ([...deviceSelect.options].some((option) => option.value === current)) deviceSelect.value = current;
  const q = params.get("q");
  const qInput = document.querySelector("input[name=q]");
  if (q && qInput && !qInput.value) qInput.value = q;
  const from = params.get("from");
  if (from && !filters.elements.from.value) filters.elements.from.value = from;
  renderSidebarDevices(result.data.devices || []);
  setActiveDevice(deviceSelect.value);
  await loadNav();
}

async function loadMessages() {
  state.loading = true;
  const params = new URLSearchParams(new FormData(filters));
  params.set("page", String(state.page));
  params.set("page_size", String(state.pageSize));
  for (const [key, value] of [...params.entries()]) {
    if (!value) params.delete(key);
  }
  params.set("page", String(state.page));
  params.set("page_size", String(state.pageSize));
  try {
    const result = await api(`/api/v1/messages?${params.toString()}`);
    if (!result.response.ok) {
      showError(result.data.error || "加载失败");
      return;
    }
    errorBox.hidden = true;
    state.total = result.data.total || 0;
    state.page = result.data.page || state.page;
    const nextCursor = maxCursor(result.data.messages || []);
    if (nextCursor && cursorIsNewer(nextCursor, state.cursor)) state.cursor = nextCursor;
    else if (!state.cursor) state.cursor = `${Date.now()}:`;
    if (state.page === 1) banner.hidden = true;
    state.searchNote = result.data.search_truncated ? " · 加密搜索只覆盖最近 500 条" : "";
    setLiveStatus(state.liveStatus);
    renderMessages(result.data.messages || []);
    const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
    pageLabel.textContent = `第 ${state.page} / ${pages} 页`;
    document.querySelector("#prev").disabled = state.page <= 1;
    document.querySelector("#next").disabled = state.page >= pages;
  } finally {
    state.loading = false;
  }
}

function renderMessages(messages) {
  closeDrawer();
  list.replaceChildren();
  if (messages.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "还没有短信。到设备页配置 iOS 快捷指令或 SmsForwarder。";
    list.append(empty);
    return;
  }
  for (const message of messages) list.append(renderMessage(message));
}

function renderMessage(message) {
  const article = document.createElement("article");
  article.className = "message-row";
  article.id = `msg-${message.id}`;
  article.tabIndex = 0;
  article.setAttribute("aria-expanded", "false");
  const senderText = message.from_number || "未知发件人";
  const timeLabel = formatTime(message.received_at);
  const metaText = messageMeta(message);

  const line = document.createElement("div");
  line.className = "message-row-line";
  const sender = document.createElement("div");
  sender.className = "sender";
  sender.textContent = senderText;
  const preview = document.createElement("div");
  preview.className = "preview";
  preview.textContent = previewText(message.content);
  const end = document.createElement("div");
  end.className = "message-row-end";
  if (message.code) end.append(codeChip(message.code));
  const time = document.createElement("time");
  time.className = "time";
  time.dateTime = new Date(message.received_at).toISOString();
  time.textContent = timeLabel;
  end.append(time);
  line.append(sender, preview, end);

  const detail = document.createElement("div");
  detail.className = "message-detail";
  const meta = document.createElement("p");
  meta.className = "subtle";
  meta.textContent = metaText;
  detail.append(meta);
  if (message.code) {
    const row = document.createElement("div");
    row.className = "code-row";
    row.append(codeChip(message.code), copyButton(message.code));
    detail.append(row);
  }
  const content = document.createElement("p");
  content.className = "content";
  renderContent(content, message.content, message.code);
  detail.append(content);

  article.append(line, detail);
  article.addEventListener("click", (event) => {
    if (event.target.closest(".chip, .code-row button")) return;
    openMessage(article, message);
  });
  article.addEventListener("keydown", (event) => {
    if (event.target.closest(".chip, .code-row button")) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openMessage(article, message);
  });
  return article;
}

function openMessage(article, message) {
  if (window.matchMedia("(max-width: 768px)").matches) {
    openDrawer(message);
    return;
  }
  const open = article.classList.contains("is-open");
  for (const row of list.querySelectorAll(".message-row.is-open")) {
    row.classList.remove("is-open");
    row.setAttribute("aria-expanded", "false");
  }
  if (!open) {
    article.classList.add("is-open");
    article.setAttribute("aria-expanded", "true");
  }
}

function openDrawer(message) {
  if (!drawer) return;
  drawerSender.textContent = message.from_number || "未知发件人";
  drawerTime.dateTime = new Date(message.received_at).toISOString();
  drawerTime.textContent = formatTime(message.received_at);
  drawerMeta.textContent = messageMeta(message);
  drawerCode.replaceChildren();
  if (message.code) {
    const row = document.createElement("div");
    row.className = "code-row";
    row.append(codeChip(message.code), copyButton(message.code));
    drawerCode.append(row);
  }
  renderContent(drawerBody, message.content, message.code);
  drawer.hidden = false;
  document.body.classList.add("drawer-open");
  document.querySelector("#drawer-close")?.focus();
}

function closeDrawer() {
  if (!drawer || drawer.hidden) return;
  drawer.hidden = true;
  document.body.classList.remove("drawer-open");
}

function messageMeta(message) {
  const bits = [message.device_name];
  if (message.sim) bits.push(`SIM ${message.sim}`);
  if (message.to_number) bits.push(`接收 ${message.to_number}`);
  return bits.filter(Boolean).join(" · ");
}

function previewText(content) {
  return String(content || "").replace(/\s+/g, " ").trim();
}

function codeChip(code) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "chip";
  chip.textContent = code;
  chip.title = "复制验证码";
  chip.addEventListener("click", async (event) => {
    event.stopPropagation();
    const label = code;
    try {
      await copyText(code);
      chip.textContent = "已复制";
    } catch {
      chip.textContent = "失败";
    }
    window.setTimeout(() => {
      chip.textContent = label;
    }, 1600);
  });
  return chip;
}

function copyButton(code) {
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "secondary";
  copy.textContent = "复制验证码";
  copy.addEventListener("click", async (event) => {
    event.stopPropagation();
    try {
      await copyText(code);
      copy.textContent = "已复制";
      window.setTimeout(() => {
        copy.textContent = "复制验证码";
      }, 1600);
    } catch {
      copy.textContent = "复制失败";
    }
  });
  return copy;
}

function maxCursor(messages) {
  let createdAt = -1;
  let id = "";
  for (const message of messages) {
    if (message.created_at > createdAt || (message.created_at === createdAt && message.id > id)) {
      createdAt = message.created_at;
      id = message.id;
    }
  }
  if (createdAt < 0) return "";
  return `${createdAt}:${id}`;
}

function cursorIsNewer(next, current) {
  const left = cursorTuple(next);
  if (!left) return false;
  const right = cursorTuple(current);
  if (!right) return true;
  if (left.createdAt !== right.createdAt) return left.createdAt > right.createdAt;
  return left.id > right.id;
}

function cursorTuple(value) {
  if (!value) return null;
  const separator = value.indexOf(":");
  if (separator <= 0) return null;
  const createdAt = Number(value.slice(0, separator));
  if (!Number.isSafeInteger(createdAt)) return null;
  return { createdAt, id: value.slice(separator + 1) };
}

function setLiveStatus(status) {
  state.liveStatus = status;
  summary.textContent = `共 ${state.total} 条 · ${status}${state.searchNote}`;
}

function showError(reason) {
  errorBox.hidden = false;
  errorBox.textContent = reason instanceof Error ? "加载失败" : String(reason || "加载失败");
}
