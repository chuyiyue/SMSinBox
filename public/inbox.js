import {
  api,
  closeDrawer,
  CodeChip,
  emptyState,
  errorBanner,
  flashLabel,
  formatDateTime,
  initShell,
  isUnauthorized,
  loadNav,
  loadingState,
  logout,
  mountSelect,
  openDrawer,
  openEventStream,
  openModal,
  receivedStamp,
  renderContent,
  toast,
} from "./common.js";
import { ensureDevices, getDevices, noteDeviceSeen, setActiveId } from "./device-store.js";
import { sidebarDeviceIcon } from "./device-panel.js";
import { registerView, syncShellHistory } from "./shell.js";
import { isTyping } from "./ui.js";
import { t } from "./i18n.js";

const PAGE_SIZE = 30;
const FALLBACK_MS = 30_000;
const UNREADABLE = "无法解密这条短信。请确认 CONTENT_KEY 与写入时一致。";
const READ_KEY = "smsinbox-inbox-read";
const READ_LIMIT = 500;
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
  range: "all",
  read: loadReadSet(),
  manageMode: false,
  checked: new Set(),
};

let filters;
let rangeButtons;
let manageButton;
let list;
let summary;
let errorBox;
let deviceSelect;
let banner;
let qInput;
let qCount;
let queryError;
let searchNote;
let endNote;
let sentinel;
let announcer;
let filterToggle;
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
  manageButton = document.querySelector("#manage-toggle");
  manageButton.addEventListener("click", () => {
    onManageToggle().catch(showError);
  });
  paintManageButton();
  list = document.querySelector("#list");
  summary = document.querySelector("#summary");
  errorBox = document.querySelector("#inbox-error");
  deviceSelect = mountSelect({
    name: "device_id",
    options: deviceOptions(),
    ariaLabel: t("inbox.device"),
  });
  deviceSelect.root.id = "device";
  document.querySelector("#device")?.replaceWith(deviceSelect.root);
  banner = document.querySelector("#live-banner");
  qInput = document.querySelector("input[name=q]");
  qCount = document.querySelector("#q-count");
  queryError = document.querySelector("#query-error");
  searchNote = document.querySelector("#search-note");
  endNote = document.querySelector("#list-end");
  sentinel = document.querySelector("#list-sentinel");
  announcer = document.querySelector("#live-announcer");
  filterToggle = document.querySelector("#open-filters");
  chips = document.querySelector("#filter-chips");
  rangeButtons = document.querySelectorAll("[data-range]");
  rangeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const next = button.dataset.range;
      if (!next || state.range === next) return;
      state.range = next;
      paintRangeButtons();
      state.page = 1;
      loadMessages().catch(showError);
    });
  });
  paintRangeButtons();
  initShell({
    onLogout() {
      stopRealtime();
      return logout().catch(() => toast(t("inbox.logoutFailed"), { tone: "danger" }));
    },
    onRefresh() {
      banner.hidden = true;
      loadMessages().catch(showError);
    },
    onEscape() {
      closeDrawer();
    },
  });
  // Aligned with the unified mobile drawer breakpoint (< 640px) in tokens.css.
  media = window.matchMedia("(max-width: 639px)");
  media.addEventListener("change", onMedia);
  banner.addEventListener("click", flushPending);
  filterToggle.addEventListener("click", openFilterSheet);
  document.querySelector("#search-note-close")?.addEventListener("click", () => {
    state.dismissedQuery = qInput.value.trim();
    searchNote.hidden = true;
  });
  filters.addEventListener("submit", (event) => {
    event.preventDefault();
    state.page = 1;
    loadMessages().catch(showError);
    if (media.matches) closeDrawer();
  });
  deviceSelect.input.addEventListener("change", () => {
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
  paintSummary();
  setLive(t("inbox.liveConnecting"), "connecting");
  document.addEventListener("smsinbox:locale", onInboxLocale);
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
    document.removeEventListener("smsinbox:locale", onInboxLocale);
    document.removeEventListener("visibilitychange", onVisibility);
    media?.removeEventListener("change", onMedia);
    closeDrawer();
  };
}

function onInboxLocale() {
  paintDeviceSelect();
  paintManageButton();
  repaintList();
  paintSummary();
  paintLive();
  paintNotes();
  paintChips();
  paintPending();
  repaintOpenDrawer();
}

function paintNotes() {
  const note = searchNote?.querySelector("span");
  if (note) note.textContent = t("inbox.searchNote");
  if (endNote) endNote.textContent = t("inbox.listEnd");
  if (queryError) queryError.textContent = t("inbox.queryTooLong");
}

function paintLive() {
  setLive(liveLabel(state.liveMode), state.liveMode);
}

function liveLabel(mode) {
  if (mode === "ok") return t("inbox.liveOk");
  if (mode === "paused") return t("inbox.livePaused");
  if (mode === "danger") return t("inbox.liveInterrupted");
  if (mode === "warn") return t("inbox.liveReconnecting");
  return t("inbox.liveConnecting");
}

function deviceOptions() {
  return [{ value: "", label: t("inbox.allDevices") }, ...state.devices.map((device) => ({ value: device.id, label: device.name }))];
}

function paintDeviceSelect() {
  if (!deviceSelect) return;
  deviceSelect.setOptions(deviceOptions(), deviceSelect.value);
  deviceSelect.root.querySelector(".select-toggle")?.setAttribute("aria-label", t("inbox.device"));
}

function repaintList() {
  if (!list) return;
  const rows = [...list.querySelectorAll(".message-row")];
  if (rows.length === 0) {
    const empty = list.querySelector(".empty-state");
    if (empty) empty.replaceWith(inboxEmptyState());
    return;
  }
  const active = document.activeElement;
  const focusId = active instanceof Element && list.contains(active) ? active.closest(".message-row")?.id || "" : "";
  for (const row of rows) {
    const message = messages.get(row.id.replace(/^msg-/, ""));
    if (!message) continue;
    const next = renderMessage(message);
    if (row.classList.contains("is-selected")) next.classList.add("is-selected");
    if (row.classList.contains("is-fresh")) next.classList.add("is-fresh");
    row.replaceWith(next);
  }
  if (focusId) document.getElementById(focusId)?.focus();
}

function repaintOpenDrawer() {
  const drawer = document.querySelector(".ui-drawer");
  if (!drawer) return;
  const title = drawer.querySelector(".ui-drawer-title");
  const closeButton = drawer.querySelector(".ui-drawer-close");
  if (closeButton) closeButton.textContent = t("common.close");
  if (drawer.classList.contains("ui-drawer--filters")) {
    if (title) title.textContent = t("inbox.filter");
    return;
  }
  const message = state.selectedId ? messages.get(state.selectedId) : null;
  if (!message) return;
  if (title) title.textContent = t("inbox.detailTitle");
  const body = drawer.querySelector(".ui-drawer-body");
  if (body) body.replaceChildren(buildDetail(message));
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
  state.range = "all";
  state.manageMode = false;
  state.checked.clear();
  messages.clear();
}

function onMedia(event) {
  if (!event.matches) closeDrawer();
}

function onVisibility() {
  if (document.hidden) {
    state.paused = true;
    stopRealtime();
    setLive(t("inbox.livePaused"), "paused");
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
  const preferred = params.get("device") || params.get("device_id") || "";
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
  state.live = openEventStream(state.cursor, {
    onOpen() {
      state.expectReconnect = false;
      state.failures = 0;
      setLive(t("inbox.liveOk"), "ok");
    },
    onMessage(message) {
      onLiveMessage(message);
    },
    onBye() {
      state.expectReconnect = true;
      setLive(t("inbox.liveReconnecting"), "warn");
    },
    onError() {
      if (state.expectReconnect) {
        state.expectReconnect = false;
        setLive(t("inbox.liveReconnecting"), "warn");
        return;
      }
      state.failures += 1;
      if (state.failures > 3) setLive(t("inbox.liveInterrupted"), "danger");
      else setLive(t("inbox.liveReconnecting"), "warn");
    },
  });
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
  // Live arrivals only touch the list. Never close or rebuild the detail
  // drawer here: an open message must stay put while new SMS come in.
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
  deviceSelect.setOptions(deviceOptions(), current);
  setActiveId(deviceSelect.value);
  if (!result.ok && state.devices.length === 0) showError(result.error || t("devices.loadFailed"));
}

async function loadMessages(options = {}) {
  const append = options.append === true;
  const silent = options.silent === true;
  if (queryTooLong()) {
    paintQueryGuard();
    list.removeAttribute("aria-busy");
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
      showError(result.data.error || t("inbox.loadFailed"));
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
    if (!silent && state.listGen === mine) {
      state.loading = false;
      list.removeAttribute("aria-busy");
    }
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
  list.removeAttribute("aria-busy");
  if (rows.length === 0) {
    list.append(inboxEmptyState());
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
  const read = state.read.has(message.id);
  const article = document.createElement("article");
  article.className = `message-row ${read ? "is-read" : "is-unread"}`;
  article.id = `msg-${message.id}`;
  article.tabIndex = 0;
  const senderText = message.from_number || t("inbox.unknownSender");
  const line = document.createElement("div");
  line.className = "message-row-line";
  const senderLine = document.createElement("div");
  senderLine.className = "sender-line";
  if (!read) senderLine.append(unreadDot());
  const sender = document.createElement("div");
  sender.className = "sender";
  sender.textContent = senderText;
  senderLine.append(sender);
  if (message.device_name) {
    const device = document.createElement("span");
    device.className = "message-device";
    device.textContent = message.device_name;
    senderLine.append(device);
  }
  if (hasTranslation(message)) {
    const tag = document.createElement("span");
    tag.className = "message-translated";
    tag.textContent = translatedTag(message);
    senderLine.append(tag);
  }
  const inlineTime = timeNode(message, "time-inline");
  senderLine.append(inlineTime);
  const preview = document.createElement("div");
  preview.className = "preview";
  if (!unreadable(message)) {
    // The list prefers the translation; the original stays in the detail.
    const previewSource = hasTranslation(message) ? message.translated_content : message.content;
    renderContent(preview, previewText(shownContent(previewSource)), message.code);
  } else preview.textContent = t("inbox.unreadableShort");
  const slot = document.createElement("div");
  slot.className = "chip-slot";
  if (message.code && !unreadable(message)) slot.append(codeChip(message.code));
  line.append(state.manageMode ? rowSelectNode(message) : avatarNode(message), senderLine, timeNode(message, "time-end"), preview, slot);
  article.append(line);
  article.addEventListener("click", (event) => {
    if (state.manageMode) {
      // The checkbox itself toggles through its own change event; other
      // row clicks flip it here. The detail drawer never opens in manage mode.
      if (event.target.closest("input, button, a")) return;
      toggleRowSelection(article, message);
      return;
    }
    if (event.target.closest("button, a")) return;
    openMessage(article, message);
  });
  article.addEventListener("keydown", (event) => {
    if (event.target.closest("button, a, input")) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (state.manageMode) {
      toggleRowSelection(article, message);
      return;
    }
    openMessage(article, message);
  });
  return article;
}

// Manage mode swaps every row's avatar slot for a checkbox. The toggle
// button next to the range segments is the only way in and out: with
// nothing checked it reads 管理 and exits, with a selection it turns
// into a red 删除（N） that deletes through the shared confirm dialog.
function rowSelectNode(message) {
  const node = document.createElement("div");
  node.className = "avatar message-select";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "message-check";
  input.checked = state.checked.has(message.id);
  input.setAttribute("aria-label", t("inbox.selectMessage"));
  input.addEventListener("change", () => {
    if (input.checked) state.checked.add(message.id);
    else state.checked.delete(message.id);
    paintManageButton();
  });
  node.append(input);
  return node;
}

function toggleRowSelection(article, message) {
  const on = !state.checked.has(message.id);
  if (on) state.checked.add(message.id);
  else state.checked.delete(message.id);
  const input = article.querySelector(".message-check");
  if (input) input.checked = on;
  paintManageButton();
}

function repaintRowSlots() {
  for (const row of list.querySelectorAll(".message-row")) {
    const message = messages.get(row.id.replace(/^msg-/, ""));
    if (!message) continue;
    const line = row.querySelector(".message-row-line");
    const current = line?.querySelector(".avatar");
    if (!line || !current) continue;
    current.replaceWith(state.manageMode ? rowSelectNode(message) : avatarNode(message));
  }
}

function paintManageButton() {
  if (!manageButton) return;
  const count = state.checked.size;
  const deleting = state.manageMode && count > 0;
  manageButton.textContent = deleting ? t("inbox.deleteCount", { count }) : t("inbox.manage");
  manageButton.classList.toggle("danger", deleting);
  manageButton.setAttribute("aria-pressed", String(state.manageMode));
}

function exitManageMode() {
  state.manageMode = false;
  state.checked.clear();
  repaintRowSlots();
  paintManageButton();
}

async function onManageToggle() {
  if (!state.manageMode) {
    state.manageMode = true;
    state.checked.clear();
    repaintRowSlots();
    paintManageButton();
    return;
  }
  if (state.checked.size === 0) {
    exitManageMode();
    return;
  }
  const ids = [...state.checked];
  const confirmed = await openModal({
    title: t("inbox.deleteTitle"),
    body: t("inbox.deleteManyConfirm", { count: ids.length }),
    confirmLabel: t("common.delete"),
    danger: true,
  });
  if (!confirmed) return;
  const outcome = await requestDeleteMessages(ids);
  if (!outcome.ok) {
    toast(outcome.error, { tone: "danger" });
    return;
  }
  exitManageMode();
  state.page = 1;
  await loadMessages().catch(showError);
  toast(t("inbox.deletedCount", { count: outcome.deleted }));
}

async function requestDeleteMessages(ids) {
  const result = await api("/api/v1/messages/delete", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
  if (!result.response.ok) return { ok: false, error: result.data?.error || t("inbox.deleteFailed") };
  return { ok: true, deleted: result.data?.deleted ?? ids.length };
}

function openMessage(article, message) {
  state.selectedId = message.id;
  markRead(message.id, article);
  for (const row of list.querySelectorAll(".message-row.is-selected")) row.classList.remove("is-selected");
  article.classList.add("is-selected");
  showDrawer(message);
}

function showDrawer(message) {
  openDrawer({
    title: t("inbox.detailTitle"),
    bodyHTML: buildDetail(message),
  });
}

function buildDetail(message) {
  const wrap = document.createElement("div");
  wrap.className = "message-detail-inner";

  const meta = document.createElement("div");
  meta.className = "ui-drawer-meta message-detail-meta";
  meta.append(
    detailRow(t("inbox.fromLabel"), message.from_number || t("inbox.unknownSender")),
    detailRow(t("inbox.device"), message.device_name || message.device_id || t("inbox.unknownDevice")),
  );
  const stamp = receivedStamp(message.received_at);
  if (stamp) meta.append(detailRow(t("inbox.receivedLabel"), formatDateTime(message.received_at) || stamp));
  wrap.append(meta);

  if (unreadable(message)) {
    const warn = document.createElement("div");
    warn.className = "callout warn";
    warn.textContent = t("inbox.unreadableDetail");
    wrap.append(warn);
  } else {
    if (message.code) {
      const codeBlock = document.createElement("section");
      codeBlock.className = "message-card";
      codeBlock.append(
        cardHead(t("inbox.codeHeading"), cardCopyButton(t("inbox.copyCode"), message.code, t("common.copiedCode", { code: message.code }))),
        CodeChip(message.code),
      );
      wrap.append(codeBlock);
    }
    if (hasTranslation(message)) {
      const translatedCard = document.createElement("section");
      translatedCard.className = "message-card";
      const translatedBody = document.createElement("p");
      translatedBody.className = "content";
      translatedBody.dir = "auto";
      translatedBody.textContent = message.translated_content;
      const translatedNote = document.createElement("p");
      translatedNote.className = "message-card-note";
      translatedNote.textContent = translatedTag(message);
      translatedCard.append(
        cardHead(t("inbox.translationHeading"), cardCopyButton(t("inbox.copyTranslation"), message.translated_content, t("inbox.translationCopied"))),
        translatedBody,
        translatedNote,
      );
      wrap.append(translatedCard);
    }
    const contentCard = document.createElement("section");
    contentCard.className = "message-card";
    const content = document.createElement("p");
    content.className = "content";
    content.dir = "auto";
    renderContent(content, shownContent(message.content), message.code);
    contentCard.append(
      cardHead(t("inbox.bodyHeading"), cardCopyButton(t("inbox.copyOriginal"), message.content, t("inbox.originalCopied"))),
      content,
    );
    wrap.append(contentCard);
  }

  const del = document.createElement("button");
  del.type = "button";
  del.className = "danger message-detail-delete";
  del.textContent = t("inbox.deleteMessage");
  del.addEventListener("click", async (event) => {
    event.stopPropagation();
    const confirmed = await openModal({
      title: t("inbox.deleteTitle"),
      body: t("inbox.deleteOneConfirm"),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!confirmed) return;
    const outcome = await requestDeleteMessages([message.id]);
    if (!outcome.ok) {
      toast(outcome.error, { tone: "danger" });
      return;
    }
    state.checked.delete(message.id);
    paintManageButton();
    closeDrawer();
    state.page = 1;
    await loadMessages().catch(showError);
    toast(t("inbox.deletedCount", { count: outcome.deleted }));
  });
  wrap.append(del);

  wrap.append(rawJsonFold(message));
  return wrap;
}

function cardHead(title, copyButton) {
  const head = document.createElement("div");
  head.className = "message-card-head";
  const label = document.createElement("h3");
  label.className = "message-card-title";
  label.textContent = title;
  head.append(label);
  if (copyButton) head.append(copyButton);
  return head;
}

function cardCopyButton(label, value, doneText) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost message-card-copy";
  button.textContent = label;
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    const copied = await flashLabel(button, value || "", label);
    if (copied) toast(doneText);
    else toast(t("common.copyFailed"), { tone: "danger" });
  });
  return button;
}

function detailRow(label, value) {
  const row = document.createElement("div");
  row.className = "ui-drawer-meta-row";
  const dt = document.createElement("span");
  dt.className = "ui-drawer-meta-label";
  dt.textContent = label;
  const dd = document.createElement("span");
  dd.className = "ui-drawer-meta-value";
  dd.textContent = value;
  row.append(dt, dd);
  return row;
}

function rawJsonFold(message) {
  const details = document.createElement("details");
  details.className = "fold message-raw";
  const summary = document.createElement("summary");
  summary.textContent = t("inbox.rawJson");
  const pre = document.createElement("pre");
  pre.className = "code-block";
  pre.textContent = JSON.stringify(message, null, 2);
  details.append(summary, pre);
  return details;
}

function codeChip(code) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "message-codechip";
  chip.title = t("inbox.copyCode");
  chip.setAttribute("aria-label", t("inbox.copyCodeValue", { code }));
  const value = document.createElement("span");
  value.className = "ui-codechip-code";
  value.textContent = code;
  chip.append(value);
  chip.addEventListener("click", async (event) => {
    event.stopPropagation();
    const copied = await flashLabel(value, code, code);
    if (copied) toast(t("common.copiedCode", { code }));
    else toast(t("common.copyFailed"), { tone: "danger" });
  });
  return chip;
}

function openFilterSheet() {
  const parent = filters.parentElement;
  const nextSibling = filters.nextSibling;
  const body = document.createElement("div");
  body.className = "inbox-filter-sheet";
  body.append(filters);
  filterToggle.setAttribute("aria-expanded", "true");
  const drawer = openDrawer({
    title: t("inbox.filter"),
    bodyHTML: body,
    onClose() {
      parent.insertBefore(filters, nextSibling);
      filterToggle.setAttribute("aria-expanded", "false");
    },
  });
  drawer.classList.add("ui-drawer--filters");
}

function inboxEmptyState() {
  const filtered = Boolean(deviceSelect.value || filters.elements.from.value.trim() || qInput.value.trim() || state.range !== "all");
  if (filtered) {
    return emptyState({
      title: t("inbox.emptyFilteredTitle"),
      text: t("inbox.emptyFilteredText"),
    });
  }
  if (state.devices.length === 0) {
    const link = document.createElement("a");
    link.className = "button";
    link.href = "/devices.html";
    link.textContent = t("inbox.addDevice");
    const box = emptyState({
      title: t("inbox.emptyTitle"),
      text: t("inbox.emptyNoDevice"),
      actions: [link],
    });
    const steps = document.createElement("ol");
    steps.className = "steps";
    for (const line of [t("inbox.stepCreate"), t("inbox.stepSetup"), t("inbox.stepTest")]) {
      const item = document.createElement("li");
      item.textContent = line;
      steps.append(item);
    }
    box.insertBefore(steps, box.querySelector(".empty-actions"));
    return box;
  }
  const link = document.createElement("a");
  link.className = "button";
  link.href = "/devices.html";
  link.textContent = t("inbox.stepTest");
  return emptyState({
    title: t("inbox.emptyTitle"),
    text: t("inbox.emptyReady"),
    actions: [link],
  });
}

function showSkeleton() {
  list.setAttribute("aria-busy", "true");
  list.replaceChildren();
  list.append(loadingState({ count: 6 }));
}

// Calling-code prefix → ISO country for the row avatar flag. Matching is
// longest-prefix first, so +852 resolves to hk before any shorter rule
// and +1 stays us. Only these countries ship a flag file in /flags.
const DIAL_CODE_COUNTRIES = [
  ["852", "hk"], ["886", "tw"], ["358", "fi"], ["353", "ie"], ["351", "pt"],
  ["971", "ae"], ["972", "il"],
  ["86", "cn"], ["44", "gb"], ["81", "jp"], ["82", "kr"], ["65", "sg"],
  ["61", "au"], ["49", "de"], ["33", "fr"], ["39", "it"], ["34", "es"],
  ["91", "in"], ["66", "th"], ["84", "vn"], ["62", "id"], ["60", "my"],
  ["63", "ph"], ["31", "nl"], ["41", "ch"], ["46", "se"], ["47", "no"],
  ["45", "dk"], ["48", "pl"], ["90", "tr"], ["55", "br"], ["52", "mx"],
  ["27", "za"], ["64", "nz"], ["30", "gr"], ["43", "at"], ["32", "be"],
  ["7", "ru"], ["1", "us"],
];
const DIAL_CODE_MAP = new Map(DIAL_CODE_COUNTRIES);

function flagCountryForNumber(from) {
  const text = String(from ?? "").trim();
  if (!text.startsWith("+")) return null;
  const digits = text.slice(1).replace(/\D/g, "");
  for (const length of [3, 2, 1]) {
    const hit = DIAL_CODE_MAP.get(digits.slice(0, length));
    if (hit) return hit;
  }
  return null;
}

// Sender-id → brand logo. The sender is normalized (lowercased, stripped
// of everything but letters and digits) and must equal an alias exactly,
// so ordinary phone numbers never match. Only brands with a file in
// /logos are listed; aliases are written already normalized.
const SENDER_LOGOS = [
  ["whatsapp", ["whatsapp"]],
  ["telegram", ["telegram"]],
  ["signal", ["signal"]],
  ["facebook", ["facebook", "meta"]],
  ["instagram", ["instagram"]],
  ["x", ["x", "twitter"]],
  ["google", ["google"]],
  ["apple", ["apple"]],
  ["github", ["github"]],
  ["discord", ["discord"]],
  ["steam", ["steam"]],
  ["tiktok", ["tiktok"]],
  ["netflix", ["netflix"]],
  ["spotify", ["spotify"]],
  ["ebay", ["ebay"]],
  ["uber", ["uber", "ubereats"]],
  ["paypal", ["paypal"]],
  ["visa", ["visa"]],
  ["mastercard", ["mastercard"]],
  ["americanexpress", ["americanexpress", "amex"]],
  ["hsbc", ["hsbc", "hsbcuk"]],
  ["barclays", ["barclays", "barclaysuk"]],
  ["chase", ["chase"]],
  ["bankofamerica", ["bankofamerica", "bofa"]],
  ["revolut", ["revolut"]],
  ["wise", ["wise", "transferwise"]],
  ["binance", ["binance"]],
  ["coinbase", ["coinbase"]],
  ["alipay", ["alipay"]],
  ["wechat", ["wechat", "weixin"]],
  ["vodafone", ["vodafone", "vodafoneuk"]],
  ["orange", ["orange"]],
  ["dhl", ["dhl"]],
  ["fedex", ["fedex"]],
  // These five were removed from newer simple-icons releases; the SVGs
  // are vendored from simple-icons 9.21.0 instead.
  ["microsoft", ["microsoft"]],
  ["amazon", ["amazon"]],
  ["tmobile", ["tmobile"]],
  ["linkedin", ["linkedin"]],
  ["openai", ["openai", "chatgpt"]],
];
const SENDER_LOGO_MAP = new Map();
for (const [slug, aliases] of SENDER_LOGOS) {
  for (const alias of aliases) SENDER_LOGO_MAP.set(alias, slug);
}

function senderLogoSlug(from) {
  const normalized = String(from ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!normalized) return null;
  return SENDER_LOGO_MAP.get(normalized) ?? null;
}

function logoImg(src) {
  const img = document.createElement("img");
  img.className = "avatar-logo";
  img.src = src;
  img.alt = "";
  return img;
}

function avatarNode(message) {
  const node = document.createElement("div");
  node.className = "avatar";
  node.setAttribute("aria-hidden", "true");
  const from = message?.from_number;
  // A known brand sender id wins over every other avatar treatment.
  const slug = senderLogoSlug(from);
  if (slug) {
    node.classList.add("has-logo");
    node.append(logoImg(`/logos/${slug}.svg`));
    return node;
  }
  // Internal test messages come from the system itself: use its logo.
  // The app icon is a full-bleed design, so it fills the avatar circle
  // exactly like a flag does instead of sitting as a glyph on a disc.
  if (String(from ?? "").trim().toLowerCase() === "smsinbox") {
    node.classList.add("has-logo-fill");
    const img = logoImg("/logo.png");
    img.className = "avatar-logo-fill";
    node.append(img);
    return node;
  }
  const iso = flagCountryForNumber(from);
  if (iso) {
    const img = document.createElement("img");
    img.className = "avatar-flag";
    img.src = `/flags/${iso}.svg`;
    img.alt = "";
    node.append(img);
    return node;
  }
  // No country to infer (no + prefix, or an alphanumeric sender id):
  // fall back to the platform icon of the device that received it.
  const device = state.devices.find((item) => item.id === message?.device_id);
  const icon = sidebarDeviceIcon(device);
  node.innerHTML = `<svg class="avatar-type-icon" viewBox="0 0 24 24"><use href="/icons.svg#${icon}"/></svg>`;
  return node;
}

function timeNode(message, extra) {
  const time = document.createElement("time");
  time.className = `time ${extra}`;
  const at = Number(message.received_at);
  if (Number.isFinite(at) && at > 0) {
    time.dateTime = new Date(at).toISOString();
    time.textContent = formatDateTime(at);
  }
  return time;
}

function previewText(content) {
  return String(content || "").replace(/\s+/g, " ").trim();
}

// Source-language code → display name for the translation tag; codes the
// map does not know fall back to the raw code.
const LANG_NAMES = {
  en: "lang.en",
  ja: "lang.ja",
  ko: "lang.ko",
  ru: "lang.ru",
  uk: "lang.uk",
  th: "lang.th",
  ar: "lang.ar",
  hi: "lang.hi",
  el: "lang.el",
  he: "lang.he",
  fr: "lang.fr",
  de: "lang.de",
  es: "lang.es",
  it: "lang.it",
  pt: "lang.pt",
  nl: "lang.nl",
  vi: "lang.vi",
  id: "lang.id",
  "zh-Hant": "lang.zh-Hant",
};

function langName(code) {
  if (typeof code !== "string" || !code) return "";
  const key = LANG_NAMES[code];
  if (!key) return code;
  const name = t(key);
  return name === key ? code : name;
}

function hasTranslation(message) {
  return typeof message?.translated_content === "string" && message.translated_content.trim() !== "";
}

function translatedTag(message) {
  const lang = langName(message?.source_lang);
  return lang ? t("inbox.translatedFrom", { lang }) : t("inbox.translated");
}

function unreadable(message) {
  return message?.content === UNREADABLE;
}

function shownContent(content) {
  return content === UNREADABLE ? t("inbox.unreadable") : content;
}

function rangeSince() {
  if (state.range === "all") return null;
  if (state.range === "today") return new Date().setHours(0, 0, 0, 0);
  if (state.range === "7d") return Date.now() - 7 * 864e5;
  return null;
}

function queryParams(page) {
  const params = new URLSearchParams();
  if (deviceSelect.value) params.set("device", deviceSelect.value);
  const from = String(filters.elements.from.value || "").trim();
  if (from) params.set("from", from);
  const query = String(qInput.value || "").trim();
  if (query && !queryTooLong()) params.set("q", query);
  const since = rangeSince();
  if (since != null) params.set("since", String(since));
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

function paintRangeButtons() {
  rangeButtons?.forEach((button) => {
    const active = button.dataset.range === state.range;
    button.setAttribute("aria-pressed", String(active));
    button.classList.toggle("is-active", active);
  });
}

function paintChips() {
  chips.replaceChildren();
  if (deviceSelect.value) {
    const deviceLabel = t("inbox.device");
    chips.append(filterChip(deviceLabel, deviceSelect.label || deviceLabel, () => {
      deviceSelect.value = "";
      state.page = 1;
      loadMessages().catch(showError);
    }));
  }
  const from = String(filters.elements.from.value || "").trim();
  if (from) {
    chips.append(filterChip(t("inbox.number"), from, () => {
      filters.elements.from.value = "";
      state.page = 1;
      loadMessages().catch(showError);
    }));
  }
  const query = String(qInput.value || "").trim();
  if (query) {
    chips.append(filterChip(t("inbox.chipSearch"), query, () => {
      qInput.value = "";
      paintQueryGuard();
      state.page = 1;
      loadMessages().catch(showError);
    }));
  }
  if (state.range !== "all") {
    chips.append(filterChip(t("inbox.chipTime"), rangeLabel(state.range), () => {
      state.range = "all";
      paintRangeButtons();
      state.page = 1;
      loadMessages().catch(showError);
    }));
  }
}

function rangeLabel(range) {
  if (range === "today") return t("inbox.rangeToday");
  if (range === "7d") return t("inbox.range7d");
  return t("inbox.rangeAll");
}

function filterChip(label, value, onRemove) {
  const chip = document.createElement("span");
  chip.className = "filter-chip";
  chip.append(t("inbox.chipValue", { label, value }));
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", t("inbox.removeFilter", { label }));
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
  summary.textContent = t("inbox.summary", { count: state.total });
}

function paintPending() {
  const count = state.pending.length;
  banner.hidden = count === 0;
  banner.textContent = t("inbox.newCount", { count });
  paintTitle();
}

function paintTitle() {
  const base = t("inbox.documentTitle");
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
  const sender = message.from_number || t("inbox.unknownSender");
  announcer.textContent = t("inbox.announced", { sender });
}

function remember(message) {
  if (message?.id) state.seen.add(message.id);
}

function unreadDot() {
  const dot = document.createElement("span");
  dot.className = "unread-dot";
  dot.setAttribute("role", "img");
  dot.setAttribute("aria-label", t("inbox.unread"));
  return dot;
}

// Read state is a local convenience only: the API has no read flag, so we
// remember which messages were opened in this browser. Never send it upstream.
function loadReadSet() {
  try {
    const raw = JSON.parse(localStorage.getItem(READ_KEY) || "[]");
    if (!Array.isArray(raw)) return new Set();
    return new Set(raw.filter((id) => typeof id === "string").slice(-READ_LIMIT));
  } catch {
    return new Set();
  }
}

function saveReadSet() {
  try {
    localStorage.setItem(READ_KEY, JSON.stringify([...state.read].slice(-READ_LIMIT)));
  } catch {
    // Storage may be unavailable; the mark still holds for this view.
  }
}

function markRead(id, article) {
  if (!state.read.has(id)) {
    state.read.add(id);
    saveReadSet();
  }
  article?.classList.remove("is-unread");
  article?.classList.add("is-read");
  article?.querySelector(".unread-dot")?.remove();
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
  const message = reason instanceof Error ? t("inbox.loadFailedRetry") : String(reason || t("inbox.loadFailed"));
  errorBanner(errorBox, message, () => {
    loadMessages().catch(showError);
  });
  list.removeAttribute("aria-busy");
  list.querySelectorAll(".skeleton").forEach((node) => node.remove());
}

function clearError() {
  errorBox.hidden = true;
  errorBox.replaceChildren();
}

function onInboxKey(event) {
  if (document.querySelector(".modal-root, dialog[open], .ui-drawer")) return;
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
    // A focused row already handles Enter on its own; don't toggle twice.
    if (event.target.closest(".message-row")) return;
    event.preventDefault();
    openMessage(row, message);
  } else if (event.key === "c" && state.selectedId) {
    const message = messages.get(state.selectedId);
    if (!message?.code) return;
    event.preventDefault();
    document.querySelector(`#msg-${CSS.escape(state.selectedId)} .message-codechip`)?.click();
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
