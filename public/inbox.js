import {
  absoluteTime,
  api,
  flashLabel,
  formatTime,
  initShell,
  isUnauthorized,
  loadNav,
  logout,
  renderContent,
  toast,
} from "./common.js";
import { ensureDevices, getDevices, noteDeviceSeen, setActiveId } from "./device-store.js";
import { registerView, syncShellHistory } from "./shell.js";
import { isTyping } from "./ui.js";

const PAGE_SIZE = 30;
const FALLBACK_MS = 30_000;
const UNREADABLE = "无法解密这条短信。请确认 CONTENT_KEY 与写入时一致。";
const state = {
  page: 1,
  total: 0,
  loading: false,
  hasMore: false,
  live: null,
  fallback: 0,
  cursor: "",
  liveMode: "connecting",
  failures: 0,
  expectReconnect: false,
  paused: false,
  devices: [],
  pending: [],
  seen: new Set(),
  dismissedQuery: null,
  listGen: 0,
  selectedId: "",
};

let filters;
let list;
let summary;
let errorBox;
let deviceSelect;
let banner;
let drawer;
let drawerSender;
let drawerTime;
let drawerMeta;
let drawerBody;
let qInput;
let qCount;
let queryError;
let searchNote;
let endNote;
let sentinel;
let announcer;
let clearButton;
let chips;
let observer = null;
let media = null;
const messages = new Map();
let viewToken = 0;

function startView() {
  viewToken += 1;
  const token = viewToken;
  resetInbox();
  filters = document.querySelector("#filters");
  list = document.querySelector("#list");
  summary = document.querySelector("#summary");
  errorBox = document.querySelector("#inbox-error");
  deviceSelect = document.querySelector("#device");
  banner = document.querySelector("#live-banner");
  drawer = document.querySelector("#message-drawer");
  drawerSender = document.querySelector("#drawer-sender");
  drawerTime = document.querySelector("#drawer-time");
  drawerMeta = document.querySelector("#drawer-meta");
  drawerBody = document.querySelector("#drawer-body");
  qInput = document.querySelector("input[name=q]");
  qCount = document.querySelector("#q-count");
  queryError = document.querySelector("#query-error");
  searchNote = document.querySelector("#search-note");
  endNote = document.querySelector("#list-end");
  sentinel = document.querySelector("#list-sentinel");
  announcer = document.querySelector("#live-announcer");
  clearButton = document.querySelector("#clear-filters");
  chips = document.querySelector("#filter-chips");
  initShell({
    onLogout() {
      stopRealtime();
      return logout().catch(() => toast("退出失败", { tone: "danger" }));
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
    onEscape() {
      closeDrawer();
    },
  });
  document.querySelector("#drawer-close")?.addEventListener("click", closeDrawer);
  drawer?.addEventListener("click", (event) => {
    if (event.target === drawer) closeDrawer();
  });
  media = window.matchMedia("(max-width: 639px)");
  media.addEventListener("change", onMedia);
  banner.addEventListener("click", flushPending);
  clearButton.addEventListener("click", () => {
    deviceSelect.value = "";
    setActiveId("");
    filters.elements.from.value = "";
    qInput.value = "";
    state.page = 1;
    loadMessages().catch(showError);
  });
  document.querySelector("#search-note-close")?.addEventListener("click", () => {
    state.dismissedQuery = qInput.value.trim();
    searchNote.hidden = true;
  });
  filters.addEventListener("submit", (event) => {
    event.preventDefault();
    state.page = 1;
    loadMessages().catch(showError);
  });
  deviceSelect.addEventListener("change", () => {
    state.page = 1;
    setActiveId(deviceSelect.value);
    loadMessages().catch(showError);
  });
  const queueSearch = debounce(() => {
    state.page = 1;
    loadMessages().catch(showError);
  }, 300);
  filters.elements.from.addEventListener("input", queueSearch);
  qInput.addEventListener("input", () => {
    paintQueryGuard();
    queueSearch();
  });
  document.addEventListener("keydown", onInboxKey, true);
  observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) loadMore().catch(showError);
  });
  observer.observe(sentinel);
  showSkeleton();
  boot(token).catch((error) => {
    if (token !== viewToken || isUnauthorized(error)) return;
    showError(error);
  });
  return () => {
    if (viewToken === token) viewToken += 1;
    state.listGen += 1;
    stopRealtime();
    observer?.disconnect();
    observer = null;
    document.removeEventListener("keydown", onInboxKey, true);
    document.removeEventListener("visibilitychange", onVisibility);
    media?.removeEventListener("change", onMedia);
    closeDrawer();
  };
}

function resetInbox() {
  stopRealtime();
  state.page = 1;
  state.total = 0;
  state.loading = false;
  state.hasMore = false;
  state.cursor = "";
  state.liveMode = "connecting";
  state.failures = 0;
  state.expectReconnect = false;
  state.paused = false;
  state.devices = [];
  state.pending = [];
  state.seen.clear();
  state.dismissedQuery = null;
  state.listGen += 1;
  state.selectedId = "";
  messages.clear();
}

function onMedia(event) {
  if (!event.matches) closeDrawer();
}

function onVisibility() {
  if (document.hidden) {
    state.paused = true;
    stopRealtime();
    setLive("已暂停", "paused");
    return;
  }
  state.paused = false;
  loadMessages({ silent: true })
    .then(() => startRealtime())
    .catch(showError);
}

async function boot(token) {
  const params = new URLSearchParams(location.search);
  if (params.get("q") && !qInput.value) qInput.value = params.get("q");
  if (params.get("from") && !filters.elements.from.value) filters.elements.from.value = params.get("from");
  const preferred = params.get("device_id") || "";
  await loadDevices(preferred);
  if (token !== viewToken) return;
  await loadMessages();
  if (token !== viewToken) return;
  startRealtime();
  document.addEventListener("visibilitychange", onVisibility);
  await loadNav();
}

function startRealtime() {
  stopRealtime();
  if (state.paused) return;
  if (!state.cursor) state.cursor = `${Date.now()}:`;
  const source = new EventSource(`/api/v1/events?cursor=${encodeURIComponent(state.cursor)}`);
  state.live = source;
  source.onopen = () => {
    state.expectReconnect = false;
    state.failures = 0;
    setLive("实时", "ok");
  };
  source.addEventListener("message", (event) => {
    let payload = null;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!payload?.message) return;
    onLiveMessage(payload.message);
  });
  source.addEventListener("bye", () => {
    state.expectReconnect = true;
    setLive("重新连接中…", "warn");
  });
  source.onerror = () => {
    if (state.expectReconnect) {
      state.expectReconnect = false;
      setLive("重新连接中…", "warn");
      return;
    }
    state.failures += 1;
    if (state.failures > 3) setLive("连接中断，已每 30 秒自动刷新", "danger");
    else setLive("重新连接中…", "warn");
  };
  state.fallback = window.setInterval(() => {
    if (!state.loading) loadMessages({ silent: true }).catch(() => {});
  }, FALLBACK_MS);
}

function stopRealtime() {
  state.live?.close();
  state.live = null;
  window.clearInterval(state.fallback);
  state.fallback = 0;
}

function onLiveMessage(message) {
  if (message?.device_id) noteDeviceSeen(message.device_id, message.created_at || message.received_at || Date.now());
  if (!message?.id || state.seen.has(message.id)) return;
  remember(message);
  const next = `${message.created_at}:${message.id}`;
  if (cursorIsNewer(next, state.cursor)) state.cursor = next;
  if (!matchesFilters(message) || document.getElementById(`msg-${message.id}`)) return;
  announce(message);
  if (nearTop()) {
    prependMessage(message);
    state.total += 1;
    paintSummary();
    return;
  }
  state.pending.push(message);
  state.total += 1;
  paintPending();
  paintSummary();
}

async function loadDevices(preferred = "") {
  const token = viewToken;
  const result = await ensureDevices();
  if (token !== viewToken || result?.stale) return;
  state.devices = getDevices();
  const current = preferred || deviceSelect.value;
  deviceSelect.replaceChildren(new Option("全部设备", ""));
  for (const device of state.devices) deviceSelect.append(new Option(device.name, device.id));
  if ([...deviceSelect.options].some((option) => option.value === current)) deviceSelect.value = current;
  setActiveId(deviceSelect.value);
  if (!result.ok && state.devices.length === 0) showError(result.error || "加载设备失败");
}

async function loadMessages(options = {}) {
  const append = options.append === true;
  const silent = options.silent === true;
  if (queryTooLong()) {
    paintQueryGuard();
    list.querySelectorAll(".skeleton").forEach((node) => node.remove());
    return;
  }
  if (state.loading && !silent) return;
  const ticket = state.listGen;
  if (!silent) state.listGen = ticket + 1;
  const mine = silent ? ticket : state.listGen;
  if (!silent) state.loading = true;
  const page = append ? state.page : 1;
  if (!append && !silent) state.page = 1;
  try {
    const result = await api(`/api/v1/messages?${queryParams(page)}`);
    if (state.listGen !== mine) return;
    if (!result.response.ok) {
      if (append) state.page = Math.max(1, state.page - 1);
      showError(result.data.error || "加载失败");
      return;
    }
    clearError();
    state.total = result.data.total || 0;
    const rows = result.data.messages || [];
    for (const message of rows) remember(message);
    const nextCursor = maxCursor(rows);
    if (nextCursor && cursorIsNewer(nextCursor, state.cursor)) state.cursor = nextCursor;
    else if (!state.cursor) state.cursor = `${Date.now()}:`;
    if (silent) mergeHead(rows);
    else if (append) appendMessages(rows);
    else replaceMessages(rows);
    state.hasMore = list.querySelectorAll(".message-row").length < state.total;
    endNote.hidden = state.total === 0 || state.hasMore;
    paintSearchNote(Boolean(result.data.search_truncated));
    paintSummary();
    syncUrl();
    paintChips();
    setActiveId(deviceSelect.value);
  } catch (error) {
    if (state.listGen !== mine) return;
    if (isUnauthorized(error)) throw error;
    if (append) state.page = Math.max(1, state.page - 1);
    showError(error);
  } finally {
    if (!silent && state.listGen === mine) state.loading = false;
  }
}

async function loadMore() {
  if (state.loading || !state.hasMore || queryTooLong()) return;
  state.page += 1;
  await loadMessages({ append: true });
}

function replaceMessages(rows) {
  closeDrawer();
  state.pending = [];
  banner.hidden = true;
  paintTitle();
  list.replaceChildren();
  if (rows.length === 0) {
    list.append(emptyState());
    return;
  }
  for (const message of rows) list.append(renderMessage(message));
}

function appendMessages(rows) {
  const empty = list.querySelector(".empty-state");
  if (empty) empty.remove();
  for (const message of rows) {
    if (document.getElementById(`msg-${message.id}`)) continue;
    list.append(renderMessage(message));
  }
}

function mergeHead(rows) {
  const fresh = rows.filter((message) => !document.getElementById(`msg-${message.id}`));
  if (fresh.length === 0) return;
  if (nearTop()) {
    for (let index = fresh.length - 1; index >= 0; index -= 1) prependMessage(fresh[index]);
    return;
  }
  state.pending.push(...[...fresh].reverse());
  paintPending();
  paintSummary();
}

function prependMessage(message) {
  list.querySelector(".empty-state")?.remove();
  const row = renderMessage(message);
  row.classList.add("is-fresh");
  list.prepend(row);
}

function renderMessage(message) {
  messages.set(message.id, message);
  const article = document.createElement("article");
  article.className = "message-row";
  article.id = `msg-${message.id}`;
  article.tabIndex = 0;
  article.setAttribute("aria-expanded", "false");
  const senderText = message.from_number || "未知发件人";
  const line = document.createElement("div");
  line.className = "message-row-line";
  const senderLine = document.createElement("div");
  senderLine.className = "sender-line";
  const sender = document.createElement("div");
  sender.className = "sender";
  sender.textContent = senderText;
  senderLine.append(sender);
  const tagText = [message.device_name, message.sim ? `SIM ${message.sim}` : ""].filter(Boolean).join(" · ");
  if (tagText) {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = tagText;
    senderLine.append(tag);
  }
  const inlineTime = timeNode(message, "time-inline");
  senderLine.append(inlineTime);
  const preview = document.createElement("div");
  preview.className = "preview";
  if (!unreadable(message)) renderContent(preview, previewText(message.content), message.code);
  else preview.textContent = "这条短信无法解密";
  const slot = document.createElement("div");
  slot.className = "chip-slot";
  if (message.code && !unreadable(message)) slot.append(codeChip(message.code));
  line.append(avatarNode(senderText), senderLine, timeNode(message, "time-end"), preview, slot);
  const detail = document.createElement("div");
  detail.className = "message-detail";
  detail.append(buildDetail(message));
  article.append(line, detail);
  article.addEventListener("click", (event) => {
    if (event.target.closest("button, a")) return;
    openMessage(article, message);
  });
  article.addEventListener("keydown", (event) => {
    if (event.target.closest("button, a")) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openMessage(article, message);
  });
  return article;
}

function openMessage(article, message) {
  state.selectedId = message.id;
  for (const row of list.querySelectorAll(".message-row.is-selected")) row.classList.remove("is-selected");
  article.classList.add("is-selected");
  if (window.matchMedia("(max-width: 639px)").matches) {
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
  drawerTime.textContent = absoluteTime(message.received_at);
  drawerTime.title = drawerTime.textContent;
  drawerMeta.textContent = messageMeta(message);
  drawerBody.replaceChildren(buildDetail(message));
  drawer.hidden = false;
  document.body.classList.add("drawer-open");
  document.querySelector("#drawer-close")?.focus();
}

function closeDrawer() {
  if (!drawer || drawer.hidden) return;
  drawer.hidden = true;
  document.body.classList.remove("drawer-open");
}

function buildDetail(message) {
  const wrap = document.createElement("div");
  const meta = document.createElement("p");
  meta.className = "subtle";
  meta.textContent = `${absoluteTime(message.received_at)} · ${messageMeta(message)}`;
  wrap.append(meta);
  if (unreadable(message)) {
    const warn = document.createElement("div");
    warn.className = "callout warn";
    warn.textContent = "这条短信无法解密（加密密钥已更换或被清空）";
    wrap.append(warn);
  } else {
    const actions = document.createElement("div");
    actions.className = "actions";
    if (message.code) actions.append(labeledCopy(message.code, "复制验证码", true));
    const full = document.createElement("button");
    full.type = "button";
    full.className = "secondary";
    full.textContent = "复制全文";
    full.addEventListener("click", async (event) => {
      event.stopPropagation();
      await flashLabel(full, message.content || "", "复制全文");
    });
    actions.append(full);
    const content = document.createElement("p");
    content.className = "content";
    renderContent(content, message.content, message.code);
    wrap.append(actions, content);
  }
  const extra = document.createElement("details");
  extra.className = "fold";
  const summaryNode = document.createElement("summary");
  summaryNode.textContent = "高级信息";
  const facts = document.createElement("dl");
  facts.className = "device-facts";
  addTiny(facts, "短信 ID", message.id);
  addTiny(facts, "接收时间", absoluteTime(message.received_at));
  if (message.created_at) addTiny(facts, "入库时间", absoluteTime(message.created_at));
  if (message.reported_device) addTiny(facts, "上报设备", message.reported_device);
  extra.append(summaryNode, facts);
  wrap.append(extra);
  return wrap;
}

function labeledCopy(code, label, primary) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = primary ? "primary" : "secondary";
  button.textContent = label;
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    const copied = await flashLabel(button, code, label);
    if (copied) toast(`验证码 ${code} 已复制`);
  });
  return button;
}

function codeChip(code) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "chip";
  chip.textContent = code;
  chip.title = "复制验证码";
  chip.setAttribute("aria-label", `复制验证码 ${code}`);
  chip.addEventListener("click", async (event) => {
    event.stopPropagation();
    const copied = await flashLabel(chip, code, code);
    if (copied) toast(`验证码 ${code} 已复制`);
  });
  return chip;
}

function emptyState() {
  const box = document.createElement("div");
  box.className = "empty-state";
  const title = document.createElement("h2");
  title.className = "empty-title";
  const text = document.createElement("p");
  const filtered = Boolean(deviceSelect.value || filters.elements.from.value.trim() || qInput.value.trim());
  if (filtered) {
    title.textContent = "没有符合条件的短信";
    text.textContent = "换一个设备、号码，或缩短搜索词。";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "清除筛选";
    button.addEventListener("click", () => clearButton.click());
    box.append(title, text, button);
    return box;
  }
  title.textContent = "收件箱还是空的";
  if (state.devices.length === 0) {
    text.textContent = "让手机把短信转发到这里。";
    const steps = document.createElement("ol");
    steps.className = "steps";
    for (const line of ["创建设备", "在手机上配置转发（iOS 或 Android）", "发送一条测试短信"]) {
      const item = document.createElement("li");
      item.textContent = line;
      steps.append(item);
    }
    const link = document.createElement("a");
    link.className = "button";
    link.href = "/devices.html";
    link.textContent = "去添加设备";
    box.append(title, text, steps, link);
    return box;
  }
  text.textContent = "设备已经就绪。发送一条测试短信，确认转发通了。";
  const link = document.createElement("a");
  link.className = "button";
  link.href = "/devices.html";
  link.textContent = "发送一条测试短信";
  box.append(title, text, link);
  return box;
}

function showSkeleton() {
  list.replaceChildren();
  for (let index = 0; index < 6; index += 1) {
    const row = document.createElement("div");
    row.className = "skeleton";
    list.append(row);
  }
}

function avatarNode(sender) {
  const node = document.createElement("div");
  node.className = "avatar";
  node.setAttribute("aria-hidden", "true");
  if (!sender || sender === "未知发件人" || /^\d+$/.test(sender)) {
    node.innerHTML =
      '<svg class="icon" viewBox="0 0 24 24"><path d="M5 6h14v10H8l-3 3z"/></svg>';
    return node;
  }
  let hash = 0;
  for (const char of sender) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  node.dataset.tone = String((hash % 6) + 1);
  node.textContent = [...sender][0] || "?";
  return node;
}

function timeNode(message, extra) {
  const time = document.createElement("time");
  time.className = `time ${extra}`;
  time.dateTime = new Date(message.received_at).toISOString();
  time.textContent = formatTime(message.received_at);
  time.title = absoluteTime(message.received_at);
  return time;
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

function unreadable(message) {
  return message?.content === UNREADABLE;
}

function addTiny(listNode, label, value) {
  const wrap = document.createElement("div");
  wrap.className = "span-2";
  const term = document.createElement("dt");
  term.textContent = label;
  const detail = document.createElement("dd");
  detail.textContent = value || "";
  wrap.append(term, detail);
  listNode.append(wrap);
}

function queryParams(page) {
  const params = new URLSearchParams();
  if (deviceSelect.value) params.set("device_id", deviceSelect.value);
  const from = String(filters.elements.from.value || "").trim();
  if (from) params.set("from", from);
  const query = String(qInput.value || "").trim();
  if (query && !queryTooLong()) params.set("q", query);
  params.set("page", String(page));
  params.set("page_size", String(PAGE_SIZE));
  return params;
}

function syncUrl() {
  const params = queryParams(1);
  params.delete("page");
  params.delete("page_size");
  const next = params.toString();
  const url = next ? `/?${next}` : "/";
  if (`${location.pathname}${location.search}` !== url) history.replaceState({ shell: 1 }, "", url);
  syncShellHistory();
}

function paintChips() {
  chips.replaceChildren();
  if (deviceSelect.value) {
    chips.append(filterChip("设备", deviceSelect.selectedOptions[0]?.textContent || "设备", () => {
      deviceSelect.value = "";
      state.page = 1;
      loadMessages().catch(showError);
    }));
  }
  const from = String(filters.elements.from.value || "").trim();
  if (from) {
    chips.append(filterChip("号码", from, () => {
      filters.elements.from.value = "";
      state.page = 1;
      loadMessages().catch(showError);
    }));
  }
  const query = String(qInput.value || "").trim();
  if (query) {
    chips.append(filterChip("搜索", query, () => {
      qInput.value = "";
      paintQueryGuard();
      state.page = 1;
      loadMessages().catch(showError);
    }));
  }
  clearButton.hidden = chips.childElementCount === 0;
}

function filterChip(label, value, onRemove) {
  const chip = document.createElement("span");
  chip.className = "filter-chip";
  chip.append(`${label}：${value}`);
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", `移除${label}筛选`);
  button.textContent = "×";
  button.addEventListener("click", onRemove);
  chip.append(button);
  return chip;
}

function paintQueryGuard() {
  const bytes = likePatternBytes(qInput.value);
  const tooLong = bytes > 50;
  qInput.classList.toggle("is-invalid", tooLong);
  queryError.hidden = !tooLong;
  const near = bytes >= 40;
  qCount.hidden = !near;
  qCount.textContent = `${bytes}/50`;
}

function queryTooLong() {
  return likePatternBytes(qInput.value) > 50;
}

function likePatternBytes(query) {
  const trimmed = String(query || "").trim();
  if (!trimmed) return 0;
  const escaped = trimmed.replace(/[\\%_]/g, (char) => `\\${char}`);
  return new TextEncoder().encode(`%${escaped}%`).length;
}

function paintSearchNote(truncated) {
  const query = qInput.value.trim();
  if (!truncated || !query) {
    searchNote.hidden = true;
    return;
  }
  searchNote.hidden = state.dismissedQuery === query;
}

function paintSummary() {
  summary.textContent = `共 ${state.total} 条`;
}

function paintPending() {
  const count = state.pending.length;
  banner.hidden = count === 0;
  banner.textContent = `↑ ${count} 条新短信`;
  paintTitle();
}

function paintTitle() {
  const base = "收件箱 · SMSinBox";
  document.title = state.pending.length ? `(${state.pending.length}) ${base}` : base;
}

function flushPending() {
  const batch = state.pending.splice(0);
  for (const message of batch) prependMessage(message);
  banner.hidden = true;
  paintTitle();
  paintSummary();
  window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

function announce(message) {
  const sender = message.from_number || "未知发件人";
  announcer.textContent = `收到来自 ${sender} 的新短信`;
}

function remember(message) {
  if (message?.id) state.seen.add(message.id);
}

function matchesFilters(message) {
  const device = deviceSelect.value;
  const from = String(filters.elements.from.value || "").trim();
  const query = String(qInput.value || "").trim().toLowerCase();
  if (device && message.device_id !== device) return false;
  if (from && message.from_number !== from) return false;
  if (query && !queryTooLong()) {
    const haystack = `${message.content}\n${message.from_number}\n${message.code || ""}`.toLowerCase();
    return haystack.includes(query);
  }
  return true;
}

function nearTop() {
  return window.scrollY < 80;
}

function setLive(text, mode) {
  state.liveMode = mode;
  const node = document.querySelector("#live-status");
  const label = document.querySelector("#live-status-text");
  if (label) label.textContent = text;
  node?.classList.remove("is-ok", "is-warn", "is-danger", "is-paused");
  if (mode === "ok") node?.classList.add("is-ok");
  if (mode === "warn") node?.classList.add("is-warn");
  if (mode === "danger") node?.classList.add("is-danger");
  if (mode === "paused") node?.classList.add("is-paused");
}

function showError(reason) {
  const message = reason instanceof Error ? "加载失败，请重试" : String(reason || "加载失败");
  errorBox.hidden = false;
  errorBox.replaceChildren();
  const text = document.createElement("span");
  text.textContent = message;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "secondary";
  retry.textContent = "重试";
  retry.addEventListener("click", () => {
    loadMessages().catch(showError);
  });
  errorBox.append(text, retry);
  list.querySelectorAll(".skeleton").forEach((node) => node.remove());
}

function clearError() {
  errorBox.hidden = true;
  errorBox.replaceChildren();
}

function onInboxKey(event) {
  if (document.querySelector(".modal-root, dialog[open]")) return;
  if (event.key === "Escape" && document.activeElement === qInput) {
    event.stopPropagation();
    if (qInput.value) {
      qInput.value = "";
      paintQueryGuard();
      state.page = 1;
      loadMessages().catch(showError);
    }
    qInput.blur();
    document.querySelector(".topbar")?.classList.remove("is-searching");
    return;
  }
  if (isTyping(event.target)) return;
  const rows = [...list.querySelectorAll(".message-row")];
  if (event.key === "j" || event.key === "k") {
    if (rows.length === 0) return;
    event.preventDefault();
    const current = rows.findIndex((row) => row.id === `msg-${state.selectedId}`);
    const next = event.key === "j" ? Math.min(rows.length - 1, current + 1) : Math.max(0, current < 0 ? 0 : current - 1);
    const row = rows[next];
    state.selectedId = row.id.replace(/^msg-/, "");
    for (const item of rows) item.classList.toggle("is-selected", item === row);
    row.classList.add("is-selected");
    row.focus();
    row.scrollIntoView({ block: "nearest" });
  } else if (event.key === "Enter" && state.selectedId) {
    const row = document.getElementById(`msg-${state.selectedId}`);
    const message = messages.get(state.selectedId);
    if (!row || !message || event.target.closest("button, a")) return;
    event.preventDefault();
    openMessage(row, message);
  } else if (event.key === "c" && state.selectedId) {
    const message = messages.get(state.selectedId);
    if (!message?.code) return;
    event.preventDefault();
    document.querySelector(`#msg-${CSS.escape(state.selectedId)} .chip`)?.click();
  }
}

function maxCursor(rows) {
  let createdAt = -1;
  let id = "";
  for (const message of rows) {
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

function debounce(fn, wait) {
  let timer = 0;
  return () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(fn, wait);
  };
}

registerView("/", startView);
