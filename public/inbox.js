import { api, copyText, formatTime, logout, renderContent } from "./common.js";

const POLL_MS = 8000;
const state = { page: 1, pageSize: 20, total: 0, timer: 0, loading: false };

const filters = document.querySelector("#filters");
const list = document.querySelector("#list");
const summary = document.querySelector("#summary");
const errorBox = document.querySelector("#inbox-error");
const pageLabel = document.querySelector("#page-label");
const deviceSelect = document.querySelector("#device");

document.querySelector("#logout").addEventListener("click", () => {
  logout().catch(() => {
    errorBox.textContent = "退出失败";
    errorBox.hidden = false;
  });
});
document.querySelector("#refresh").addEventListener("click", () => {
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
filters.addEventListener("submit", (event) => {
  event.preventDefault();
  state.page = 1;
  loadMessages().catch(showError);
});

boot().catch((error) => {
  if (error instanceof Error && error.message === "unauthorized") return;
  showError(error);
});

async function boot() {
  await loadDevices();
  await loadMessages();
  armPolling();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      window.clearInterval(state.timer);
      return;
    }
    loadMessages().catch(showError);
    armPolling();
  });
}

function armPolling() {
  window.clearInterval(state.timer);
  state.timer = window.setInterval(() => {
    if (!state.loading) loadMessages().catch(showError);
  }, POLL_MS);
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
    summary.textContent = `共 ${state.total} 条 · 每 8 秒自动刷新`;
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
  for (const message of messages) {
    const article = document.createElement("article");
    article.className = "message";
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
    list.append(article);
  }
}

function showError(reason) {
  errorBox.hidden = false;
  errorBox.textContent = reason instanceof Error ? "加载失败" : String(reason || "加载失败");
}
