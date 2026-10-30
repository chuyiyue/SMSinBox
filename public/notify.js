import { api } from "./common.js";

const KINDS = {
  telegram: "Telegram",
  wecom: "企业微信",
  bark: "Bark",
  email: "邮件",
};

const form = document.querySelector("#notify-form");
const fields = document.querySelector("#notify-fields");
const errorBox = document.querySelector("#notify-error");
const statusBox = document.querySelector("#notify-status");
const list = document.querySelector("#notify-list");
const kindSelect = form.querySelector("select[name=kind]");

kindSelect.addEventListener("change", renderFields);
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setError("");
  setStatus("");
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const result = await api("/api/v1/notifications", {
      method: "POST",
      body: JSON.stringify(readForm()),
    });
    if (!result.response.ok) {
      setError(result.data.error || "添加失败");
      return;
    }
    form.reset();
    renderFields();
    setStatus("已添加。密钥只以掩码显示。");
    await loadChannels();
  } catch (error) {
    if (error instanceof Error && error.message === "unauthorized") return;
    setError("添加失败");
  } finally {
    button.disabled = false;
  }
});

renderFields();
loadChannels().catch((error) => {
  if (error instanceof Error && error.message === "unauthorized") return;
  setError("加载推送渠道失败");
});

function renderFields() {
  fields.replaceChildren();
  const kind = kindSelect.value;
  if (kind === "telegram") {
    fields.append(field("Bot token", "bot_token", "123456:AA..."), field("Chat ID", "chat_id", "数字或 @频道"));
    return;
  }
  if (kind === "wecom") {
    fields.append(field("Webhook URL", "webhook_url", "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key="));
    return;
  }
  if (kind === "bark") {
    fields.append(
      field("Device key", "device_key", "Bark 设备密钥"),
      field("服务器", "server", "留空则使用 https://api.day.app"),
    );
    return;
  }
  const mode = document.createElement("label");
  mode.append("方式");
  const select = document.createElement("select");
  select.name = "email_mode";
  select.append(new Option("Webhook", "webhook"), new Option("SMTP（465 端口）", "smtp"));
  mode.append(select);
  fields.append(mode, field("收件邮箱", "to", "you@example.com"), field("发件邮箱", "from", "sms@example.com"));
  const extra = document.createElement("div");
  extra.className = "stack";
  fields.append(extra);
  const paintEmail = () => {
    extra.replaceChildren();
    if (select.value === "webhook") {
      extra.append(field("Webhook URL", "webhook_url", "https://example.com/mail"));
      return;
    }
    extra.append(
      field("SMTP 主机", "smtp_host", "smtp.example.com"),
      field("SMTP 用户名", "smtp_username", "smtp-user"),
      secretField("SMTP 密码", "smtp_password"),
    );
  };
  select.addEventListener("change", paintEmail);
  paintEmail();
}

function readForm() {
  const payload = new FormData(form);
  const body = { kind: String(payload.get("kind") || "") };
  for (const [key, value] of payload.entries()) {
    if (key === "kind" || key === "email_mode") continue;
    const text = String(value).trim();
    if (text) body[key] = text;
  }
  return body;
}

async function loadChannels() {
  const result = await api("/api/v1/notifications");
  list.replaceChildren();
  const rows = result.data.channels || [];
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "还没有推送渠道。";
    list.append(empty);
    return;
  }
  for (const channel of rows) {
    const row = document.createElement("article");
    row.className = "device";
    const text = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = `${KINDS[channel.kind] || channel.kind}${channel.enabled ? "" : " · 已停用"}`;
    const meta = document.createElement("p");
    meta.className = "subtle";
    meta.textContent = describe(channel);
    text.append(title, meta);
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(
      actionButton("测试", async () => {
        const tested = await api(`/api/v1/notifications/${channel.id}/test`, { method: "POST", body: "{}" });
        if (!tested.response.ok || !tested.data.ok) {
          setError(tested.data.error || "测试失败");
          setStatus("");
          return;
        }
        setError("");
        setStatus("测试通知已发送。");
      }),
      actionButton(channel.enabled ? "停用" : "启用", async () => {
        const updated = await api(`/api/v1/notifications/${channel.id}`, {
          method: "POST",
          body: JSON.stringify({ enabled: !channel.enabled }),
        });
        if (!updated.response.ok) {
          setError(updated.data.error || "更新失败");
          return;
        }
        await loadChannels();
      }),
      actionButton("删除", async () => {
        if (!window.confirm("删除这个推送渠道？")) return;
        const removed = await api(`/api/v1/notifications/${channel.id}`, { method: "DELETE" });
        if (!removed.response.ok) {
          setError(removed.data.error || "删除失败");
          return;
        }
        await loadChannels();
      }, "danger"),
    );
    row.append(text, actions);
    list.append(row);
  }
}

function describe(channel) {
  const config = channel.config || {};
  if (channel.kind === "telegram") return `chat ${config.chat_id || ""} · token ${config.bot_token || ""}`;
  if (channel.kind === "wecom") return config.webhook_url || "";
  if (channel.kind === "bark") return `${config.server || ""} · ${config.device_key || ""}`;
  if (config.webhook_url) return `${config.from || ""} → ${config.to || ""} · Webhook`;
  return `${config.from || ""} → ${config.to || ""} · ${config.smtp_host || "SMTP"}`;
}

function field(label, name, placeholder) {
  const wrap = document.createElement("label");
  wrap.append(label);
  const input = document.createElement("input");
  input.name = name;
  input.placeholder = placeholder;
  input.autocomplete = "off";
  input.maxLength = 512;
  wrap.append(input);
  return wrap;
}

function secretField(label, name) {
  const wrap = field(label, name, "");
  wrap.querySelector("input").type = "password";
  return wrap;
}

function actionButton(label, onClick, className) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className || "secondary";
  button.textContent = label;
  button.addEventListener("click", () => {
    onClick().catch((error) => {
      if (error instanceof Error && error.message === "unauthorized") return;
      setError("操作失败");
    });
  });
  return button;
}

function setError(message) {
  errorBox.hidden = !message;
  errorBox.textContent = message;
}

function setStatus(message) {
  statusBox.hidden = !message;
  statusBox.textContent = message;
}
