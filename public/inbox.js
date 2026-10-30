import { api, copyText, formatTime, logout, renderContent } from "./common.js";

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

document.querySelector("#logout").addEventListener("click", () => {
  stopRealtime();
  logout().catch(() => {
    errorBox.textContent = "退出失败";
    errorBox.hidden = false;
  });
});
document.querySelector("#refresh").addEventListener("click", () => {
  banner.hidden = true;
  loadMessages().catch(showError);
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
  const current = deviceSelect.value;
  deviceSelect.replaceChildren(new Option("全部设备", ""));
  for (const device of result.data.devices || []) {
    deviceSelect.append(new Option(device.name, device.id));
  }
  if ([...deviceSelect.options].some((option) => option.value === current)) deviceSelect.value = current;
  const me = await api("/api/v1/auth/me");
  document.querySelector("#who").textContent = me.data.user?.username || "";
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
  article.className = "message";
  article.id = `msg-${message.id}`;
  const header = document.createElement("header");
  const sender = document.createElement("div");
  sender.className = "sender";
  sender.textContent = message.from_number || "未知发件人";
  const time = document.createElement("time");
  time.className = "time";
  time.dateTime = new Date(message.received_at).toISOString();
  time.textContent = formatTime(message.received_at);
  header.append(sender, time);

  const meta = document.createElement("p");
  meta.className = "subtle";
  const bits = [message.device_name];
  if (message.sim) bits.push(`SIM ${message.sim}`);
  if (message.to_number) bits.push(`接收 ${message.to_number}`);
  meta.textContent = bits.filter(Boolean).join(" · ");

  article.append(header, meta);
  if (message.code) {
    const row = document.createElement("div");
    row.className = "code-row";
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = message.code;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "secondary";
    copy.textContent = "复制验证码";
    copy.addEventListener("click", async () => {
      try {
        await copyText(message.code);
        copy.textContent = "已复制";
        window.setTimeout(() => {
          copy.textContent = "复制验证码";
        }, 1600);
      } catch {
        copy.textContent = "复制失败";
      }
    });
    row.append(chip, copy);
    article.append(row);
  }
  const content = document.createElement("p");
  content.className = "content";
  renderContent(content, message.content, message.code);
  article.append(content);
  return article;
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
