import { api, emptyState, errorState, formatTime, initShell, isUnauthorized, loadNav, logout, openModal, showNotice, statusDot, toast } from "./common.js";
import { registerView } from "./shell.js";

const MAX_CHANNELS = 10;
const KINDS = [
  {
    kind: "telegram",
    label: "Telegram",
    hint: "Bot 与 Chat",
    icon: '<use href="/icons.svg#icon-send"/>',
  },
  {
    kind: "wecom",
    label: "企业微信",
    hint: "群机器人",
    icon: '<use href="/icons.svg#icon-message-square"/>',
  },
  {
    kind: "bark",
    label: "Bark",
    hint: "iOS 通知",
    icon: '<use href="/icons.svg#icon-bell"/>',
  },
  {
    kind: "email",
    label: "邮件",
    hint: "Webhook 或 SMTP",
    icon: '<use href="/icons.svg#icon-mail"/>',
  },
  {
    kind: "feishu",
    label: "飞书",
    hint: "群机器人",
    icon: '<use href="/icons.svg#icon-message-square-text"/>',
  },
  {
    kind: "dingtalk",
    label: "钉钉",
    hint: "群机器人",
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
let count;
let view;
let viewFields;
let selectedKind = "telegram";
let emailMode = "webhook";
let viewToken = 0;
const lastTest = new Map();

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
  view = document.querySelector("#notify-view");
  viewFields = document.querySelector("#notify-view-fields");
  addButton = document.querySelector("#add-channel");
  count = document.querySelector("#channel-count");
  lastTest.clear();
  renderKindGrid();
  initShell({
    onLogout: () => logout().catch(() => setError("退出失败")),
    onRefresh: () => loadChannels().catch((error) => {
      if (isUnauthorized(error)) return;
      setError("加载推送渠道失败");
    }),
  });
  addButton.addEventListener("click", openCreate);
  document.querySelector("#notify-close").addEventListener("click", () => dialog.close());
  document.querySelector("#notify-back").addEventListener("click", () => showKindStep());
  document.querySelector("#notify-view-close").addEventListener("click", () => dialog.close());
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
    setError("加载推送渠道失败");
  });
  return () => {
    if (viewToken === token) viewToken += 1;
    if (dialog?.open) dialog.close();
  };
}

function renderKindGrid() {
  const grid = document.querySelector("#notify-kinds");
  for (const item of KINDS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "kind-card";
    button.append(icon(item.icon), strong(item.label), hint(item.hint));
    button.addEventListener("click", () => chooseKind(item.kind));
    grid.append(button);
  }
}

function openCreate() {
  if (addButton.disabled) return;
  showKindStep();
  showFormError("");
  if (!dialog.open) dialog.showModal();
  document.body.classList.add("modal-open");
}

function showKindStep() {
  kindStep.hidden = false;
  form.hidden = true;
  view.hidden = true;
  document.querySelector("#notify-dialog-title").textContent = "添加渠道";
}

function chooseKind(kind) {
  selectedKind = kind;
  emailMode = "webhook";
  showFormError("");
  renderFields();
  kindStep.hidden = true;
  view.hidden = true;
  form.hidden = false;
  const label = KINDS.find((item) => item.kind === kind)?.label || "渠道";
  document.querySelector("#notify-dialog-title").textContent = `添加${label}`;
  form.querySelector("input")?.focus();
}

function openView(channel) {
  const meta = KINDS.find((item) => item.kind === channel.kind);
  viewFields.replaceChildren(...viewFieldsFor(channel));
  kindStep.hidden = true;
  form.hidden = true;
  view.hidden = false;
  document.querySelector("#notify-dialog-title").textContent = `${meta?.label || channel.kind}配置`;
  if (!dialog.open) dialog.showModal();
  document.body.classList.add("modal-open");
}

function renderFields() {
  fields.replaceChildren();
  if (selectedKind === "telegram") {
    fields.append(
      field("Bot token", "bot_token", "123456:AA...", "off"),
      field("Chat ID", "chat_id", "数字或 @频道", "off"),
      help("在哪里获取", "Bot token：@BotFather；Chat ID：数字或 @频道。", "https://core.telegram.org/bots#botfather"),
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
      error.textContent = bad ? "企业微信 Webhook 必须是 qyapi.weixin.qq.com 的 https 地址" : "";
      input.querySelector("input").setAttribute("aria-invalid", bad ? "true" : "false");
    });
    fields.append(input, error, help("在哪里获取", "复制群机器人的 Webhook URL。", "https://developer.work.weixin.qq.com/document/path/91770"));
    return;
  }
  if (selectedKind === "bark") {
    fields.append(
      field("Device key", "device_key", "Bark 设备密钥", "off"),
      field("服务器", "server", "留空则使用 https://api.day.app", "off"),
      help("在哪里获取", "复制设备密钥；服务器可留空。", "https://bark.day.app/#/tutorial"),
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
      error.textContent = bad ? "飞书 Webhook 必须是 open.feishu.cn 的 https 地址" : "";
      input.querySelector("input").setAttribute("aria-invalid", bad ? "true" : "false");
    });
    fields.append(
      input,
      error,
      secretField("签名密钥（可选）", "secret"),
      help("在哪里获取", "复制群机器人 Webhook；启用签名校验时填写密钥。", "https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot"),
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
      error.textContent = bad ? "钉钉 Webhook 必须是 oapi.dingtalk.com 的 https 地址" : "";
      input.querySelector("input").setAttribute("aria-invalid", bad ? "true" : "false");
    });
    fields.append(
      input,
      error,
      secretField("签名密钥（可选）", "secret"),
      help("在哪里获取", "复制群机器人 Webhook；启用加签时填写密钥。", "https://open.dingtalk.com/document/robots/custom-robot-access"),
    );
    return;
  }
  const modes = document.createElement("div");
  modes.className = "segmented";
  modes.setAttribute("role", "group");
  modes.setAttribute("aria-label", "邮件方式");
  const extra = document.createElement("div");
  extra.className = "stack";
  const paintMode = () => {
    for (const button of modes.querySelectorAll("button")) {
      button.setAttribute("aria-pressed", button.dataset.mode === emailMode ? "true" : "false");
    }
    extra.replaceChildren();
    if (emailMode === "webhook") {
      extra.append(field("Webhook URL", "webhook_url", "https://example.com/mail", "off"));
      extra.append(help("在哪里获取", "HTTPS 地址；通知包含收件与发件邮箱。"));
      return;
    }
    extra.append(
      field("SMTP 主机", "smtp_host", "smtp.example.com", "off"),
      field("SMTP 用户名", "smtp_username", "smtp-user", "off"),
      secretField("SMTP 密码", "smtp_password"),
      portNote(),
    );
  };
  for (const [mode, label] of [["webhook", "Webhook"], ["smtp", "SMTP"]]) {
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
  fields.append(field("收件邮箱", "to", "you@example.com", "email"), field("发件邮箱", "from", "sms@example.com", "email"), modes, extra);
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
  button.textContent = "添加中…";
  try {
    const created = await api("/api/v1/notifications", { method: "POST", body: JSON.stringify(body) });
    if (token !== viewToken) return;
    if (!created.response.ok) {
      const message = created.data.error || "添加失败";
      showFormError(message);
      toast(message, { tone: "danger" });
      return;
    }
    form.reset();
    dialog.close();
    setStatus("已添加。密钥只以掩码显示。");
    toast("已添加。密钥只以掩码显示。");
    await loadChannels();
  } catch (error) {
    if (isUnauthorized(error)) return;
    showFormError("添加失败");
    toast("添加失败", { tone: "danger" });
  } finally {
    button.disabled = false;
    button.textContent = previous;
  }
}

function readForm() {
  const payload = new FormData(form);
  const body = { kind: selectedKind };
  if (selectedKind === "wecom") {
    const webhook = String(payload.get("webhook_url") || "").trim();
    if (!wecomHostOk(webhook)) return { error: "企业微信 Webhook 必须是 qyapi.weixin.qq.com 的 https 地址" };
  }
  if (selectedKind === "feishu") {
    const webhook = String(payload.get("webhook_url") || "").trim();
    if (!feishuHostOk(webhook)) return { error: "飞书 Webhook 必须是 open.feishu.cn 的 https 地址" };
  }
  if (selectedKind === "dingtalk") {
    const webhook = String(payload.get("webhook_url") || "").trim();
    if (!dingtalkHostOk(webhook)) return { error: "钉钉 Webhook 必须是 oapi.dingtalk.com 的 https 地址" };
  }
  for (const [key, value] of payload.entries()) {
    const text = String(value).trim();
    if (!text) continue;
    if (selectedKind === "email" && emailMode === "webhook" && key.startsWith("smtp_")) continue;
    if (selectedKind === "email" && emailMode === "smtp" && key === "webhook_url") continue;
    body[key] = text;
  }
  return body;
}

async function loadChannels() {
  const token = viewToken;
  const result = await api("/api/v1/notifications");
  if (token !== viewToken) return;
  if (!result.response.ok) {
    const message = result.data.error || "加载推送渠道失败";
    if (list.querySelector(".channel-card")) {
      setError(message);
      return;
    }
    setError("");
    list.replaceChildren(retryState(message));
    return;
  }
  setError("");
  const rows = result.data.channels || [];
  paintCount(rows.length);
  list.replaceChildren();
  if (rows.length === 0) {
    list.append(emptyChannels());
    return;
  }
  for (const channel of rows) list.append(renderChannel(channel));
}

function paintCount(total) {
  count.textContent = `${total} / ${MAX_CHANNELS}`;
  const full = total >= MAX_CHANNELS;
  addButton.disabled = full;
  addButton.title = full ? "最多 10 个推送渠道" : "";
}

function renderChannel(channel) {
  const meta = KINDS.find((item) => item.kind === channel.kind);
  const name = meta?.label || channel.kind;
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
  hintText.textContent = meta?.hint || "";
  title.append(nameNode, hintText);
  head.append(badge, title, enabledDot(channel.enabled));

  const masked = document.createElement("p");
  masked.className = "channel-mask";
  masked.textContent = describe(channel);

  const test = document.createElement("div");
  test.className = "channel-test";
  test.append(testStatus(channel));

  const actions = document.createElement("div");
  actions.className = "channel-actions";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "switch";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-checked", channel.enabled ? "true" : "false");
  toggle.setAttribute("aria-label", channel.enabled ? `停用${name}` : `启用${name}`);
  toggle.addEventListener("click", () => setEnabled(channel, toggle));
  const buttons = document.createElement("div");
  buttons.className = "actions";
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "secondary";
  edit.textContent = "编辑";
  edit.addEventListener("click", () => openView(channel));
  const testButton = document.createElement("button");
  testButton.type = "button";
  testButton.className = "secondary";
  testButton.textContent = "发送测试";
  testButton.addEventListener("click", () => sendTest(channel, testButton));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "ghost";
  remove.textContent = "删除";
  remove.addEventListener("click", () => removeChannel(channel));
  buttons.append(edit, testButton, remove);
  actions.append(toggle, buttons);

  row.append(head, masked, test, actions);
  return row;
}

function enabledDot(enabled) {
  // statusDot() only emits ok/warn/bad; disabled falls back to the gray base dot.
  const status = statusDot(enabled ? "ok" : "idle", enabled ? "已启用" : "已停用");
  if (!enabled) status.querySelector(".ui-status-dot")?.setAttribute("data-status", "idle");
  return status;
}

function testStatus(channel) {
  const record = lastTest.get(channel.id);
  if (!record) {
    const empty = document.createElement("span");
    empty.className = "channel-test-empty";
    empty.textContent = "尚未测试";
    return empty;
  }
  return statusDot(record.ok ? "ok" : "bad", `${record.ok ? "测试成功" : "测试失败"} · ${formatTime(record.at)}`);
}

function paintTest(channel) {
  const row = list.querySelector(`[data-channel-id="${channel.id}"]`);
  row?.querySelector(".channel-test")?.replaceChildren(testStatus(channel));
}

async function sendTest(channel, button) {
  button.disabled = true;
  const previous = button.textContent;
  button.textContent = "发送中…";
  try {
    const tested = await api(`/api/v1/notifications/${channel.id}/test`, { method: "POST", body: "{}" });
    if (!tested.response.ok || !tested.data.ok) {
      const message = tested.data.error || "测试失败";
      lastTest.set(channel.id, { ok: false, at: Date.now() });
      setError(message);
      setStatus("");
      toast(message, { tone: "danger" });
      return;
    }
    lastTest.set(channel.id, { ok: true, at: Date.now() });
    setError("");
    setStatus("测试通知已发送。");
    toast("测试通知已发送。");
  } catch (error) {
    if (isUnauthorized(error)) return;
    lastTest.set(channel.id, { ok: false, at: Date.now() });
    setError("测试失败");
    toast("测试失败", { tone: "danger" });
  } finally {
    button.disabled = false;
    button.textContent = previous;
    paintTest(channel);
  }
}

async function setEnabled(channel, toggle) {
  const next = !channel.enabled;
  toggle.setAttribute("aria-checked", next ? "true" : "false");
  toggle.disabled = true;
  try {
    const updated = await api(`/api/v1/notifications/${channel.id}`, {
      method: "POST",
      body: JSON.stringify({ enabled: next }),
    });
    if (!updated.response.ok) {
      toggle.setAttribute("aria-checked", channel.enabled ? "true" : "false");
      const message = updated.data.error || "更新失败";
      setError(message);
      toast(message, { tone: "danger" });
      return;
    }
    setError("");
    await loadChannels();
  } catch (error) {
    if (isUnauthorized(error)) return;
    toggle.setAttribute("aria-checked", channel.enabled ? "true" : "false");
    setError("更新失败");
    toast("更新失败", { tone: "danger" });
  } finally {
    toggle.disabled = false;
  }
}

async function removeChannel(channel) {
  const label = KINDS.find((item) => item.kind === channel.kind)?.label || "这个渠道";
  const confirmed = await openModal({
    title: `删除${label}？`,
    text: "删除后，新短信不会再推送到这里。",
    confirmLabel: "删除",
    danger: true,
  });
  if (!confirmed) return;
  try {
    const removed = await api(`/api/v1/notifications/${channel.id}`, { method: "DELETE" });
    if (!removed.response.ok) {
      const message = removed.data.error || "删除失败";
      setError(message);
      toast(message, { tone: "danger" });
      return;
    }
    setError("");
    toast("已删除");
    await loadChannels();
  } catch (error) {
    if (isUnauthorized(error)) return;
    setError("删除失败");
    toast("删除失败", { tone: "danger" });
  }
}

function describe(channel) {
  const config = channel.config || {};
  if (channel.kind === "telegram") return `chat ${config.chat_id || ""} · token ${config.bot_token || ""}`;
  if (channel.kind === "wecom") return config.webhook_url || "";
  if (channel.kind === "bark") return `${config.server || ""} · ${config.device_key || ""}`;
  if (channel.kind === "feishu" || channel.kind === "dingtalk") {
    return config.secret ? `${config.webhook_url || ""} · 已签名` : config.webhook_url || "";
  }
  if (config.webhook_url) return `${config.from || ""} → ${config.to || ""} · Webhook ${config.webhook_url}`;
  return `${config.from || ""} → ${config.to || ""} · ${config.smtp_host || "SMTP"}`;
}

function retryState(message) {
  return errorState({
    message,
    onRetry: () => {
      loadChannels().catch((error) => {
        if (isUnauthorized(error)) return;
        setError("加载推送渠道失败");
      });
    },
  });
}

function emptyChannels() {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "添加渠道";
  button.addEventListener("click", openCreate);
  return emptyState({
    title: "还没有推送渠道",
    text: "短信入库后，可以推到 Telegram、企业微信、Bark、飞书、钉钉或邮箱。",
    actions: [button],
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

function viewField(label, value) {
  const wrap = document.createElement("label");
  wrap.append(label);
  const input = document.createElement("input");
  input.value = value == null ? "" : String(value);
  input.readOnly = true;
  input.tabIndex = -1;
  wrap.append(input);
  return wrap;
}

function viewFieldsFor(channel) {
  const config = channel.config || {};
  if (channel.kind === "telegram") {
    return [viewField("Bot token", config.bot_token), viewField("Chat ID", config.chat_id)];
  }
  if (channel.kind === "wecom") {
    return [viewField("Webhook URL", config.webhook_url)];
  }
  if (channel.kind === "bark") {
    return [viewField("Device key", config.device_key), viewField("服务器", config.server)];
  }
  if (channel.kind === "feishu" || channel.kind === "dingtalk") {
    return [viewField("Webhook URL", config.webhook_url), viewField("签名密钥（可选）", config.secret || "未设置")];
  }
  if (config.webhook_url) {
    return [viewField("收件邮箱", config.to), viewField("发件邮箱", config.from), viewField("Webhook URL", config.webhook_url)];
  }
  return [
    viewField("收件邮箱", config.to),
    viewField("发件邮箱", config.from),
    viewField("SMTP 主机", config.smtp_host),
    viewField("SMTP 用户名", config.smtp_username),
    viewField("SMTP 密码", config.smtp_password),
    viewField("端口", 465),
  ];
}

function portNote() {
  const wrap = document.createElement("label");
  wrap.append("端口");
  const input = document.createElement("input");
  input.value = "465";
  input.readOnly = true;
  input.tabIndex = -1;
  wrap.append(input);
  const note = document.createElement("p");
  note.className = "subtle";
  note.textContent = "SMTP 只支持 465 端口（隐式 TLS）。";
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
    link.textContent = "打开说明";
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
  showNotice(errorBox, message);
}

function setStatus(message) {
  showNotice(statusBox, message);
}

registerView("/notify.html", startView);
