import { t } from "./i18n.js";
import { api, emptyState, errorState, formatDateTime, initShell, isUnauthorized, loadNav, logout, openModal, showNotice, statusDot, toast } from "./common.js";
import { registerView } from "./shell.js";

const MAX_CHANNELS = 10;
const KINDS = [
  {
    kind: "telegram",
    label: () => t("notify.kindTelegram"),
    hint: () => t("notify.kindTelegramHint"),
    icon: '<use href="/icons.svg#icon-send"/>',
  },
  {
    kind: "wecom",
    label: () => t("notify.kindWecom"),
    hint: () => t("notify.kindGroupBot"),
    icon: '<use href="/icons.svg#icon-message-square"/>',
  },
  {
    kind: "bark",
    label: () => t("notify.kindBark"),
    hint: () => t("notify.kindBarkHint"),
    icon: '<use href="/icons.svg#icon-bell"/>',
  },
  {
    kind: "email",
    label: () => t("notify.kindEmail"),
    hint: () => t("notify.kindEmailHint"),
    icon: '<use href="/icons.svg#icon-mail"/>',
  },
  {
    kind: "webhook",
    label: () => t("notify.kindWebhook"),
    hint: () => t("notify.kindWebhookHint"),
    icon: '<use href="/icons.svg#icon-link"/>',
  },
  {
    kind: "notifyx",
    label: () => t("notify.kindNotifyx"),
    hint: () => t("notify.kindNotifyxHint"),
    icon: '<use href="/icons.svg#icon-bell"/>',
  },
  {
    kind: "feishu",
    label: () => t("notify.kindFeishu"),
    hint: () => t("notify.kindGroupBot"),
    icon: '<use href="/icons.svg#icon-message-square-text"/>',
  },
  {
    kind: "dingtalk",
    label: () => t("notify.kindDingtalk"),
    hint: () => t("notify.kindGroupBot"),
    icon: '<use href="/icons.svg#icon-message-square-text"/>',
  },
];

let form;
let fields;
let formError;
let errorBox;
let statusBox;
let list;
let dialog;
let kindStep;
let addButton;
let historyList;
let historyError;
let historyMore;
let historyEnd;
let selectedKind = "telegram";
let emailMode = "webhook";
let editingChannel = null;

// Fields whose values the API only returns masked: in the edit form they
// start blank and a blank means "keep the stored value".
const SECRET_FIELDS = {
  telegram: ["bot_token"],
  wecom: ["webhook_url"],
  bark: ["device_key"],
  email: ["webhook_url", "smtp_password", "resend_api_key"],
  webhook: ["url"],
  notifyx: ["api_key"],
  feishu: ["webhook_url", "secret"],
  dingtalk: ["webhook_url", "secret"],
};
let viewToken = 0;
let historyOffset = 0;
let historyTotal = 0;
let historyLoading = false;
let channelRows = null;
let listErrorKey = "";
let listErrorText = "";
let bannerErrorKey = "";
let bannerStatusKey = "";
let historyItems = [];
let historyState = "idle";
let historyErrorWasReset = true;

function startView() {
  viewToken += 1;
  const token = viewToken;
  selectedKind = "telegram";
  emailMode = "webhook";
  form = document.querySelector("#notify-form");
  fields = document.querySelector("#notify-fields");
  formError = document.querySelector("#notify-form-error");
  errorBox = document.querySelector("#notify-error");
  statusBox = document.querySelector("#notify-status");
  list = document.querySelector("#notify-list");
  dialog = document.querySelector("#notify-dialog");
  kindStep = document.querySelector("#kind-step");
  addButton = document.querySelector("#add-channel");
  historyList = document.querySelector("#notify-history-list");
  historyError = document.querySelector("#notify-history-error");
  historyMore = document.querySelector("#notify-history-more");
  historyEnd = document.querySelector("#notify-history-end");
  historyOffset = 0;
  historyTotal = 0;
  historyLoading = false;
  channelRows = null;
  listErrorKey = "";
  listErrorText = "";
  bannerErrorKey = "";
  bannerStatusKey = "";
  historyItems = [];
  historyState = "idle";
  historyErrorWasReset = true;
  renderKindGrid();
  wirePageTabs();
  const onLocale = () => {
    if (token !== viewToken) return;
    renderKindGrid();
    if (channelRows) paintChannels();
    paintListError();
    if (bannerErrorKey) setErrorKey(bannerErrorKey);
    if (bannerStatusKey) setStatusKey(bannerStatusKey);
    if (historyState === "loading") {
      if (historyList) historyList.textContent = t("notify.historyLoading");
    } else if (historyState === "error") {
      paintHistoryError();
      if (historyItems.length && historyList) {
        historyList.replaceChildren();
        for (const item of historyItems) historyList.append(renderPushLog(item));
      }
    } else if (historyState === "ready") {
      repaintHistory();
    }
    if (dialog?.open) dialog.close();
  };
  document.addEventListener("smsinbox:locale", onLocale);
  initShell({
    onLogout: () => logout().catch(() => setErrorKey("notify.logoutFailed")),
    onRefresh: () => (document.querySelector("#npanel-history").hidden ? loadChannels() : loadHistory(true)).catch((error) => {
      if (isUnauthorized(error)) return;
      setErrorKey("notify.loadFailed");
    }),
  });
  addButton.addEventListener("click", openCreate);
  historyMore.addEventListener("click", () => loadHistory(false));
  document.querySelector("#notify-close").addEventListener("click", () => dialog.close());
  document.querySelector("#notify-back").addEventListener("click", () => showKindStep());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => document.body.classList.remove("modal-open"));
  form.addEventListener("submit", submitChannel);
  loadNav().catch((error) => {
    if (isUnauthorized(error)) return;
  });
  loadChannels().catch((error) => {
    if (token !== viewToken || isUnauthorized(error)) return;
    setErrorKey("notify.loadFailed");
  });
  return () => {
    document.removeEventListener("smsinbox:locale", onLocale);
    if (viewToken === token) viewToken += 1;
    if (dialog?.open) dialog.close();
  };
}

// The add-channel action belongs to the system tab; history and the external placeholder hide it.
function wirePageTabs() {
  const systemTab = document.querySelector("#ntab-system");
  const externalTab = document.querySelector("#ntab-external");
  const historyTab = document.querySelector("#ntab-history");
  const systemPanel = document.querySelector("#npanel-system");
  const externalPanel = document.querySelector("#npanel-external");
  const historyPanel = document.querySelector("#npanel-history");
  if (!systemTab || !externalTab || !historyTab || !systemPanel || !externalPanel || !historyPanel || !addButton) return;
  const activate = (name) => {
    const activeTab = name === "system" ? systemTab : name === "external" ? externalTab : historyTab;
    const activePanel = name === "system" ? systemPanel : name === "external" ? externalPanel : historyPanel;
    for (const [tab, panel] of [
      [systemTab, systemPanel],
      [externalTab, externalPanel],
      [historyTab, historyPanel],
    ]) {
      const active = tab === activeTab;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
      panel.hidden = !active;
    }
    addButton.hidden = name !== "system";
    if (activePanel === historyPanel) loadHistory(true);
  };
  systemTab.addEventListener("click", () => activate("system"));
  externalTab.addEventListener("click", () => activate("external"));
  historyTab.addEventListener("click", () => activate("history"));
}

async function loadHistory(reset = true) {
  if (historyLoading) return;
  historyLoading = true;
  const token = viewToken;
  if (reset) {
    historyOffset = 0;
    historyTotal = 0;
    historyItems = [];
    historyList.replaceChildren();
    historyList.textContent = t("notify.historyLoading");
    historyMore.hidden = true;
    historyEnd.hidden = true;
    historyState = "loading";
  }
  historyError.hidden = true;
  try {
    const result = await api(`/api/v1/notify/history?limit=50&offset=${reset ? 0 : historyOffset}`);
    if (token !== viewToken) return;
    if (!result.response.ok) {
      showHistoryError(reset);
      return;
    }
    const items = Array.isArray(result.data.items) ? result.data.items : [];
    historyTotal = Number(result.data.total) || 0;
    if (reset) historyItems = items.slice();
    else historyItems.push(...items);
    historyOffset = historyItems.length;
    historyState = "ready";
    repaintHistory();
  } catch (error) {
    if (isUnauthorized(error)) return;
    showHistoryError(reset);
  } finally {
    if (token === viewToken) historyLoading = false;
  }
}

function repaintHistory() {
  if (!historyList) return;
  historyList.replaceChildren();
  if (historyItems.length === 0) {
    historyList.append(emptyState({
      text: t("notify.historyEmpty"),
    }));
  } else {
    for (const item of historyItems) historyList.append(renderPushLog(item));
  }
  const hasMore = historyOffset < historyTotal;
  historyMore.hidden = !hasMore;
  historyEnd.hidden = hasMore || historyOffset === 0;
}

function paintHistoryError() {
  historyError.replaceChildren(errorState({
    message: t("notify.historyFailed"),
    onRetry: () => loadHistory(historyErrorWasReset),
  }));
  historyError.hidden = false;
  historyMore.hidden = true;
  historyEnd.hidden = true;
}

function showHistoryError(reset) {
  historyState = "error";
  historyErrorWasReset = reset;
  paintHistoryError();
  if (reset) {
    historyItems = [];
    historyList.replaceChildren();
  }
}

function renderPushLog(item) {
  const meta = KINDS.find((kind) => kind.kind === item.channel_kind);
  const row = document.createElement("article");
  row.className = "push-history-item";

  const heading = document.createElement("div");
  heading.className = "push-history-heading";
  const channel = document.createElement("div");
  channel.className = "push-history-channel";
  const name = document.createElement("strong");
  name.className = "push-history-name";
  name.textContent = item.channel_name || (meta ? meta.label() : item.channel_kind);
  const kind = document.createElement("span");
  kind.className = "push-history-kind";
  kind.textContent = meta ? meta.label() : item.channel_kind;
  channel.append(name, kind);
  const time = document.createElement("time");
  time.className = "push-history-time";
  const timestamp = Number(item.created_at);
  time.textContent = formatDateTime(timestamp);
  if (Number.isFinite(timestamp)) time.dateTime = new Date(timestamp).toISOString();
  heading.append(channel, time);

  const badges = document.createElement("div");
  badges.className = "push-history-badges";
  const source = document.createElement("span");
  source.className = "push-history-source";
  source.textContent = item.source === "test" ? t("notify.test") : t("notify.sourceMessage");
  const status = document.createElement("span");
  status.className = `push-history-status ${item.ok ? "is-ok" : "is-failed"}`;
  status.textContent = item.ok ? t("notify.statusOk") : t("notify.statusFailed");
  badges.append(source, status);

  const preview = document.createElement("p");
  preview.className = "push-history-preview";
  preview.textContent = item.preview || "";
  row.append(heading, badges, preview);
  if (!item.ok && item.error) {
    const error = document.createElement("p");
    error.className = "push-history-error-text";
    error.textContent = [...String(item.error)].slice(0, 100).join("");
    error.title = item.error;
    row.append(error);
  }
  return row;
}

function renderKindGrid() {
  const grid = document.querySelector("#notify-kinds");
  if (!grid) return;
  grid.replaceChildren();
  for (const item of KINDS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "kind-card";
    button.append(icon(item.icon), strong(item.label()), hint(item.hint()));
    button.addEventListener("click", () => chooseKind(item.kind));
    grid.append(button);
  }
}

function openCreate() {
  if (addButton.disabled) return;
  editingChannel = null;
  showKindStep();
  showFormError("");
  if (!dialog.open) dialog.showModal();
  document.body.classList.add("modal-open");
}

function showKindStep() {
  kindStep.hidden = false;
  form.hidden = true;
  document.querySelector("#notify-back").hidden = false;
  form.querySelector("button[type=submit]").textContent = t("notify.addSubmit");
  document.querySelector("#notify-dialog-title").textContent = t("notify.addChannel");
}

function chooseKind(kind) {
  selectedKind = kind;
  emailMode = "webhook";
  showFormError("");
  renderFields();
  kindStep.hidden = true;
  form.hidden = false;
  const meta = KINDS.find((item) => item.kind === kind);
  const label = meta ? meta.label() : t("notify.channelFallback");
  document.querySelector("#notify-dialog-title").textContent = t("notify.addKind", { name: label });
  form.querySelector("input")?.focus();
}

/**
 * Edit mode: the same form as creation, kind locked, prefilled from the
 * channel's (masked) config. Secret fields start blank — a blank secret
 * means "keep the stored value" and the API merges it back server-side.
 */
function openEdit(channel) {
  editingChannel = channel;
  selectedKind = channel.kind;
  if (channel.kind === "email") {
    const config = channel.config || {};
    emailMode = config.resend_api_key ? "resend" : config.webhook_url ? "webhook" : "smtp";
  }
  showFormError("");
  renderFields();
  fillEditForm(channel);
  kindStep.hidden = true;
  form.hidden = false;
  document.querySelector("#notify-back").hidden = true;
  form.querySelector("button[type=submit]").textContent = t("common.save");
  const meta = KINDS.find((item) => item.kind === channel.kind);
  document.querySelector("#notify-dialog-title").textContent = t("notify.editChannel", { name: meta ? meta.label() : channel.kind });
  if (!dialog.open) dialog.showModal();
  document.body.classList.add("modal-open");
}

function fillEditForm(channel) {
  const config = channel.config || {};
  const secrets = new Set(SECRET_FIELDS[channel.kind] || []);
  for (const input of form.querySelectorAll("input[name]")) {
    const name = input.getAttribute("name");
    if (!name || name === "note") continue;
    if (secrets.has(name)) {
      input.value = "";
      input.placeholder = t("notify.keepSecretPlaceholder");
    } else if (config[name] !== undefined && config[name] !== null) {
      input.value = String(config[name]);
    }
  }
  const noteInput = form.querySelector("input[name=note]");
  if (noteInput) noteInput.value = channel.note || "";
}

/**
 * Shape an edit submission for PATCH: readForm fields become `config`, the
 * remark stays top-level, and blank secret fields of the active form are
 * re-added as empty strings so the server knows to keep the stored values.
 */
function buildEditPayload(readBody) {
  const { kind, note, ...config } = readBody;
  let secrets = SECRET_FIELDS[kind] || [];
  if (kind === "email") {
    secrets = emailMode === "webhook" ? ["webhook_url"] : emailMode === "resend" ? ["resend_api_key"] : ["smtp_password"];
  }
  for (const name of secrets) {
    const input = form.querySelector(`input[name="${name}"]`);
    if (input && !(name in config)) config[name] = "";
  }
  return { config, note: note || "" };
}



function renderFields() {
  fields.replaceChildren();
  // Every kind takes an optional remark, shown on the channel card.
  const noteField = field(t("notify.noteOptional"), "note", t("notify.notePlaceholder"), "off");
  noteField.querySelector("input").maxLength = 80;
  fields.append(noteField);
  if (selectedKind === "telegram") {
    fields.append(
      field("Bot token", "bot_token", "123456:AA...", "off"),
      field("Chat ID", "chat_id", t("notify.chatIdPlaceholder"), "off"),
      help(t("notify.where"), t("notify.telegramHelp"), "https://core.telegram.org/bots#botfather"),
    );
    return;
  }
  if (selectedKind === "wecom") {
    const input = field("Webhook URL", "webhook_url", "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=", "off");
    const error = document.createElement("p");
    error.className = "field-error";
    error.hidden = true;
    input.querySelector("input").addEventListener("input", () => {
      const value = input.querySelector("input").value.trim();
      const bad = value && !wecomHostOk(value);
      error.hidden = !bad;
      error.textContent = bad ? t("notify.wecomHost") : "";
      input.querySelector("input").setAttribute("aria-invalid", bad ? "true" : "false");
    });
    fields.append(input, error, help(t("notify.where"), t("notify.wecomHelp"), "https://developer.work.weixin.qq.com/document/path/91770"));
    return;
  }
  if (selectedKind === "bark") {
    fields.append(
      field("Device key", "device_key", t("notify.barkKeyPlaceholder"), "off"),
      field(t("notify.server"), "server", t("notify.barkServerPlaceholder"), "off"),
      help(t("notify.where"), t("notify.barkHelp"), "https://bark.day.app/#/tutorial"),
    );
    return;
  }
  if (selectedKind === "webhook") {
    fields.append(
      field("Webhook URL", "url", "https://example.com/webhook", "off"),
      help(t("notify.where"), t("notify.webhookHelp")),
    );
    return;
  }
  if (selectedKind === "notifyx") {
    fields.append(
      secretField("API 密钥", "api_key"),
      field("群组 ID（可选）", "team", "1234567890", "off"),
      help("在哪里获取", "登录 NotifyX 控制台，先建好通道配置，再到「API 密钥管理」生成密钥。密钥关联一个通道；要发到群组时填群组 ID，不用群组可留空", "https://www.notifyx.cn/help"),
    );
    return;
  }
  if (selectedKind === "feishu") {
    const input = field("Webhook URL", "webhook_url", "https://open.feishu.cn/open-apis/bot/v2/hook/", "off");
    const error = document.createElement("p");
    error.className = "field-error";
    error.hidden = true;
    input.querySelector("input").addEventListener("input", () => {
      const value = input.querySelector("input").value.trim();
      const bad = value && !feishuHostOk(value);
      error.hidden = !bad;
      error.textContent = bad ? t("notify.feishuHost") : "";
      input.querySelector("input").setAttribute("aria-invalid", bad ? "true" : "false");
    });
    fields.append(
      input,
      error,
      secretField(t("notify.signSecretOptional"), "secret"),
      help(t("notify.where"), t("notify.feishuHelp"), "https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot"),
    );
    return;
  }
  if (selectedKind === "dingtalk") {
    const input = field("Webhook URL", "webhook_url", "https://oapi.dingtalk.com/robot/send?access_token=", "off");
    const error = document.createElement("p");
    error.className = "field-error";
    error.hidden = true;
    input.querySelector("input").addEventListener("input", () => {
      const value = input.querySelector("input").value.trim();
      const bad = value && !dingtalkHostOk(value);
      error.hidden = !bad;
      error.textContent = bad ? t("notify.dingtalkHost") : "";
      input.querySelector("input").setAttribute("aria-invalid", bad ? "true" : "false");
    });
    fields.append(
      input,
      error,
      secretField(t("notify.signSecretOptional"), "secret"),
      help(t("notify.where"), t("notify.dingtalkHelp"), "https://open.dingtalk.com/document/robots/custom-robot-access"),
    );
    return;
  }
  const modes = document.createElement("div");
  modes.className = "segmented";
  modes.setAttribute("role", "group");
  modes.setAttribute("aria-label", t("notify.emailMode"));
  const extra = document.createElement("div");
  extra.className = "stack";
  const paintMode = () => {
    for (const button of modes.querySelectorAll("button")) {
      button.setAttribute("aria-pressed", button.dataset.mode === emailMode ? "true" : "false");
    }
    extra.replaceChildren();
    if (emailMode === "webhook") {
      extra.append(field("Webhook URL", "webhook_url", "https://example.com/mail", "off"));
      extra.append(help(t("notify.where"), t("notify.emailWebhookHelp")));
      return;
    }
    if (emailMode === "resend") {
      extra.append(
        secretField("Resend API Key", "resend_api_key"),
        help(t("notify.where"), t("notify.resendHelp"), "https://resend.com/docs/api-reference/introduction"),
      );
      return;
    }
    extra.append(
      field(t("notify.smtpHost"), "smtp_host", "smtp.example.com", "off"),
      field(t("notify.smtpUser"), "smtp_username", "smtp-user", "off"),
      secretField(t("notify.smtpPassword"), "smtp_password"),
      portNote(),
    );
  };
  for (const [mode, label] of [["webhook", "Webhook"], ["smtp", "SMTP"], ["resend", "Resend"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "segment";
    button.dataset.mode = mode;
    button.textContent = label;
    button.addEventListener("click", () => {
      emailMode = mode;
      paintMode();
    });
    modes.append(button);
  }
  fields.append(field(t("notify.emailTo"), "to", "you@example.com", "email"), field(t("notify.emailFrom"), "from", "sms@example.com", "email"), modes, extra);
  paintMode();
}

async function submitChannel(event) {
  event.preventDefault();
  const token = viewToken;
  showFormError("");
  setStatus("");
  const body = readForm();
  if (body.error) {
    showFormError(body.error);
    return;
  }
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  const previous = button.textContent;
  const editing = editingChannel;
  button.textContent = editing ? t("notify.saving") : t("notify.adding");
  try {
    const result = editing
      ? await api(`/api/v1/notifications/${editing.id}`, { method: "PATCH", body: JSON.stringify(buildEditPayload(body)) })
      : await api("/api/v1/notifications", { method: "POST", body: JSON.stringify(body) });
    if (token !== viewToken) return;
    if (!result.response.ok) {
      const message = result.data.error || (editing ? t("notify.saveFailed") : t("notify.addFailed"));
      showFormError(message);
      toast(message, { tone: "danger" });
      return;
    }
    form.reset();
    editingChannel = null;
    dialog.close();
    if (editing) {
      toast(t("notify.updated"));
    } else {
      setStatusKey("notify.added");
      toast(t("notify.added"));
    }
    await loadChannels();
  } catch (error) {
    if (isUnauthorized(error)) return;
    showFormError(editing ? t("notify.saveFailed") : t("notify.addFailed"));
    toast(editing ? t("notify.saveFailed") : t("notify.addFailed"), { tone: "danger" });
  } finally {
    button.disabled = false;
    button.textContent = t("notify.addSubmit");
  }
}

function readForm() {
  const payload = new FormData(form);
  const body = { kind: selectedKind };
  // In edit mode a blank URL field means "keep the stored one" — only a
  // non-empty replacement gets host-checked here (the server re-validates
  // the merged config either way). Creation keeps the strict checks.
  if (selectedKind === "wecom") {
    const webhook = String(payload.get("webhook_url") || "").trim();
    if (!wecomHostOk(webhook) && (webhook || !editingChannel)) return { error: t("notify.wecomHost") };
  }
  if (selectedKind === "webhook") {
    const webhook = String(payload.get("url") || "").trim();
    if (!httpUrlOk(webhook) && (webhook || !editingChannel)) return { error: t("notify.webhookUrlInvalid") };
    body.url = webhook;
    body.note = String(payload.get("note") || "").trim();
    return body;
  }
  if (selectedKind === "feishu") {
    const webhook = String(payload.get("webhook_url") || "").trim();
    if (!feishuHostOk(webhook) && (webhook || !editingChannel)) return { error: t("notify.feishuHost") };
  }
  if (selectedKind === "dingtalk") {
    const webhook = String(payload.get("webhook_url") || "").trim();
    if (!dingtalkHostOk(webhook) && (webhook || !editingChannel)) return { error: t("notify.dingtalkHost") };
  }
  for (const [key, value] of payload.entries()) {
    const text = String(value).trim();
    if (!text) continue;
    if (selectedKind === "email" && emailMode === "webhook" && (key.startsWith("smtp_") || key === "resend_api_key")) continue;
    if (selectedKind === "email" && emailMode === "smtp" && (key === "webhook_url" || key === "resend_api_key")) continue;
    if (selectedKind === "email" && emailMode === "resend" && (key === "webhook_url" || key.startsWith("smtp_"))) continue;
    body[key] = text;
  }
  if (selectedKind === "email") {
    const to = String(payload.get("to") || "").trim();
    const from = String(payload.get("from") || "").trim();
    if (emailMode === "resend") {
      const key = String(payload.get("resend_api_key") || "").trim();
      if (!key && !editingChannel) return { error: t("notify.resendKeyRequired") };
      if (!emailOk(to) || !emailOk(from)) return { error: t("notify.emailInvalid") };
      body.resend_api_key = key;
      return body;
    }
    if (!emailOk(to) || !emailOk(from)) return { error: t("notify.emailInvalid") };
  }
  return body;
}

async function loadChannels() {
  const token = viewToken;
  const result = await api("/api/v1/notifications");
  if (token !== viewToken) return;
  if (!result.response.ok) {
    showChannelLoadError(result.data.error || "");
    return;
  }
  listErrorKey = "";
  listErrorText = "";
  setError("");
  channelRows = result.data.channels || [];
  paintChannels();
}

function showChannelLoadError(serverMessage) {
  listErrorText = serverMessage || "";
  listErrorKey = serverMessage ? "" : "notify.loadFailed";
  if (list.querySelector(".channel-card")) {
    if (serverMessage) setError(serverMessage);
    else setErrorKey("notify.loadFailed");
    return;
  }
  setError("");
  paintListError();
}

function paintListError() {
  if (!list || list.querySelector(".channel-card")) return;
  if (!listErrorKey && !listErrorText) return;
  const message = listErrorText || t("notify.loadFailed");
  list.replaceChildren(retryState(message));
}

function paintChannels() {
  if (!list || !channelRows) return;
  paintCount(channelRows.length);
  list.replaceChildren();
  if (channelRows.length === 0) {
    list.append(emptyChannels());
    return;
  }
  for (const channel of channelRows) list.append(renderChannel(channel));
}

function paintCount(total) {
  const full = total >= MAX_CHANNELS;
  addButton.disabled = full;
  addButton.title = full ? t("notify.maxChannels", { n: MAX_CHANNELS }) : "";
}

function renderChannel(channel) {
  const meta = KINDS.find((item) => item.kind === channel.kind);
  const name = meta ? meta.label() : channel.kind;
  const row = document.createElement("article");
  row.className = "channel-card";
  row.dataset.channelId = channel.id;

  const head = document.createElement("div");
  head.className = "channel-card-head";
  const badge = document.createElement("span");
  badge.className = "channel-icon";
  badge.append(icon(meta?.icon || ""));
  const title = document.createElement("span");
  title.className = "channel-title";
  const nameNode = document.createElement("strong");
  nameNode.className = "channel-name";
  nameNode.textContent = name;
  const hintText = document.createElement("span");
  hintText.className = "channel-hint";
  // The owner's remark replaces the generic kind description under
  // the channel title when one is set (Roye).
  hintText.textContent = channel.note || (meta ? meta.hint() : "");
  title.append(nameNode, hintText);
  head.append(badge, title, enabledDot(channel.enabled));

  // The card shows only who receives the pushes (Roye); keys, tokens
  // and signing state stay in the editor. A channel with no recipient
  // line (NotifyX without a group) renders no row at all.
  const recipient = describe(channel);
  const masked = recipient ? document.createElement("p") : null;
  if (masked) {
    masked.className = "channel-mask";
    masked.textContent = recipient;
  }

  // One 2x2 grid, one button family (Roye): edit/test first, then the
  // enable/disable fill toggle and delete.
  const actions = document.createElement("div");
  actions.className = "channel-actions-grid";
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "secondary";
  edit.textContent = t("notify.edit");
  edit.addEventListener("click", () => openEdit(channel));
  const testButton = document.createElement("button");
  testButton.type = "button";
  testButton.className = "secondary";
  testButton.textContent = t("notify.test");
  testButton.addEventListener("click", () => sendTest(channel, testButton));
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = channel.enabled ? "btn-disable" : "btn-enable";
  toggle.textContent = channel.enabled ? t("notify.disable") : t("notify.enable");
  toggle.setAttribute("aria-label", channel.enabled ? t("notify.disableNamed", { name }) : t("notify.enableNamed", { name }));
  toggle.addEventListener("click", () => setEnabled(channel, toggle));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger";
  remove.textContent = t("common.delete");
  remove.addEventListener("click", () => removeChannel(channel));
  actions.append(edit, testButton, toggle, remove);

  row.append(head, ...(masked ? [masked] : []), actions);
  return row;
}

function enabledDot(enabled) {
  // statusDot() only emits ok/warn/bad; disabled falls back to the gray base dot.
  const status = statusDot(enabled ? "ok" : "idle", enabled ? t("notify.enabled") : t("notify.disabled"));
  if (!enabled) status.querySelector(".ui-status-dot")?.setAttribute("data-status", "idle");
  return status;
}

async function sendTest(channel, button) {
  button.disabled = true;
  button.textContent = t("notify.sending");
  try {
    const tested = await api(`/api/v1/notifications/${channel.id}/test`, { method: "POST", body: "{}" });
    if (!tested.response.ok || !tested.data.ok) {
      const message = tested.data.error || t("notify.testFailed");
      if (tested.data.error) setError(tested.data.error);
      else setErrorKey("notify.testFailed");
      setStatus("");
      toast(message, { tone: "danger" });
      return;
    }
    setError("");
    setStatusKey("notify.testSent");
    toast(t("notify.testSent"));
  } catch (error) {
    if (isUnauthorized(error)) return;
    setErrorKey("notify.testFailed");
    toast(t("notify.testFailed"), { tone: "danger" });
  } finally {
    button.disabled = false;
    button.textContent = t("notify.test");
  }
}

async function setEnabled(channel, toggle) {
  const next = !channel.enabled;
  toggle.disabled = true;
  try {
    const updated = await api(`/api/v1/notifications/${channel.id}`, {
      method: "POST",
      body: JSON.stringify({ enabled: next }),
    });
    if (!updated.response.ok) {
      const message = updated.data.error || t("notify.updateFailed");
      if (updated.data.error) setError(updated.data.error);
      else setErrorKey("notify.updateFailed");
      toast(message, { tone: "danger" });
      return;
    }
    setError("");
    await loadChannels();
  } catch (error) {
    if (isUnauthorized(error)) return;
    setErrorKey("notify.updateFailed");
    toast(t("notify.updateFailed"), { tone: "danger" });
  } finally {
    toggle.disabled = false;
  }
}

async function removeChannel(channel) {
  const meta = KINDS.find((item) => item.kind === channel.kind);
  const label = meta ? meta.label() : t("notify.thisChannel");
  const confirmed = await openModal({
    title: t("notify.deleteTitle", { name: label }),
    text: t("notify.deleteText"),
    confirmLabel: t("common.delete"),
    danger: true,
  });
  if (!confirmed) return;
  try {
    const removed = await api(`/api/v1/notifications/${channel.id}`, { method: "DELETE" });
    if (!removed.response.ok) {
      const message = removed.data.error || t("notify.deleteFailed");
      if (removed.data.error) setError(removed.data.error);
      else setErrorKey("notify.deleteFailed");
      toast(message, { tone: "danger" });
      return;
    }
    setError("");
    toast(t("notify.deleted"));
    await loadChannels();
  } catch (error) {
    if (isUnauthorized(error)) return;
    setErrorKey("notify.deleteFailed");
    toast(t("notify.deleteFailed"), { tone: "danger" });
  }
}

// Card summaries are uniformly abbreviated on every kind (Roye): identity
// fields (chat id, email addresses) stay readable, but URLs shrink to
// their host and keys to a masked tail — full values live in the editor.
function hostOf(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).host || raw;
  } catch {
    return raw.replace(/^[a-z]+:\/\//i, "").split("/")[0] || raw;
  }
}

function maskTail(value) {
  const raw = String(value || "");
  if (!raw || raw.includes("*") || raw.length <= 4) return raw;
  return `****${raw.slice(-4)}`;
}

// Recipient only (Roye): the one line under a channel's name says who
// receives its pushes — never a key, token, sender or transport detail.
// An empty string means the card renders no recipient row at all.
function describe(channel) {
  const config = channel.config || {};
  if (channel.kind === "telegram") return `chat ${config.chat_id || ""}`;
  if (channel.kind === "wecom") return hostOf(config.webhook_url);
  if (channel.kind === "webhook") return hostOf(config.url);
  if (channel.kind === "notifyx") return config.team ? `群组 ${config.team}` : "";
  if (channel.kind === "bark") return maskTail(config.device_key);
  if (channel.kind === "feishu" || channel.kind === "dingtalk") return hostOf(config.webhook_url);
  if (channel.kind === "email") return config.to || "";
  return "";
}

function retryState(message) {
  return errorState({
    message,
    onRetry: () => {
      loadChannels().catch((error) => {
        if (isUnauthorized(error)) return;
        setErrorKey("notify.loadFailed");
      });
    },
  });
}

function emptyChannels() {
  return emptyState({
    title: t("notify.emptyTitle"),
    text: t("notify.emptyText"),
  });
}

function wecomHostOk(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "qyapi.weixin.qq.com";
  } catch {
    return false;
  }
}

function httpUrlOk(value) {
  try {
    const url = new URL(value);
    if (!("http:" === url.protocol || "https:" === url.protocol)) return false;
    if (url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
    if (host === "metadata.google.internal" || host === "metadata.google.com") return false;
    if (host === "127.0.0.1" || host === "::1") return false;
    if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("ff")) return false;
    return true;
  } catch {
    return false;
  }
}

function emailOk(value) {
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(String(value || ""));
}

function feishuHostOk(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "open.feishu.cn" || url.hostname === "open.larksuite.com");
  } catch {
    return false;
  }
}

function dingtalkHostOk(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "oapi.dingtalk.com";
  } catch {
    return false;
  }
}

function field(label, name, placeholder, autocomplete) {
  const wrap = document.createElement("label");
  wrap.append(label);
  const input = document.createElement("input");
  input.name = name;
  input.placeholder = placeholder;
  input.autocomplete = autocomplete || "off";
  input.maxLength = 512;
  wrap.append(input);
  return wrap;
}

function secretField(label, name) {
  const wrap = field(label, name, "", "new-password");
  wrap.querySelector("input").type = "password";
  return wrap;
}

function portNote() {
  const wrap = document.createElement("label");
  wrap.append(t("notify.port"));
  const input = document.createElement("input");
  input.value = "465";
  input.readOnly = true;
  input.tabIndex = -1;
  wrap.append(input);
  const note = document.createElement("p");
  note.className = "subtle";
  note.textContent = t("notify.smtpPortNote");
  const stack = document.createElement("div");
  stack.className = "stack";
  stack.append(wrap, note);
  return stack;
}

function help(summary, text, href) {
  const details = document.createElement("details");
  details.className = "fold";
  const title = document.createElement("summary");
  title.textContent = summary;
  const paragraph = document.createElement("p");
  paragraph.className = "subtle";
  paragraph.textContent = text;
  details.append(title, paragraph);
  if (href) {
    const link = document.createElement("a");
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = t("notify.openDocs");
    details.append(link);
  }
  return details;
}

function icon(path) {
  const holder = document.createElement("div");
  holder.innerHTML = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
  return holder.firstElementChild;
}

function strong(text) {
  const node = document.createElement("strong");
  node.textContent = text;
  return node;
}

function hint(text) {
  const node = document.createElement("span");
  node.textContent = text;
  return node;
}

function showFormError(message) {
  formError.hidden = !message;
  formError.textContent = message || "";
}

function setError(message) {
  bannerErrorKey = "";
  showNotice(errorBox, message || "");
}

function setErrorKey(key) {
  bannerErrorKey = key || "";
  showNotice(errorBox, errorKeyText(key));
}

function errorKeyText(key) {
  if (key === "notify.logoutFailed") return t("notify.logoutFailed");
  if (key === "notify.loadFailed") return t("notify.loadFailed");
  if (key === "notify.testFailed") return t("notify.testFailed");
  if (key === "notify.updateFailed") return t("notify.updateFailed");
  if (key === "notify.deleteFailed") return t("notify.deleteFailed");
  return "";
}

function setStatus(message) {
  bannerStatusKey = "";
  showNotice(statusBox, message || "");
}

function setStatusKey(key) {
  bannerStatusKey = key || "";
  showNotice(statusBox, statusKeyText(key));
}

function statusKeyText(key) {
  if (key === "notify.added") return t("notify.added");
  if (key === "notify.testSent") return t("notify.testSent");
  return "";
}

registerView("/notify.html", startView);
