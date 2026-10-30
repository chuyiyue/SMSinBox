import { api, copyText, formatTime, logout } from "./common.js";

const TEMPLATE = '{"from":"{{FROM}}","content":"{{SMS}}","timestamp":"{{RECEIVE_TIME}}","device":"{{DEVICE_NAME}}","sim":"{{CARD_SLOT}}"}';
const form = document.querySelector("#device-form");
const errorBox = document.querySelector("#device-error");
const tokenBox = document.querySelector("#token-box");
const tokenValue = document.querySelector("#token-value");
const devices = document.querySelector("#devices");

document.querySelector("#sms-url").textContent = `${location.origin}/api/v1/sms`;
document.querySelector("#android-template").textContent = TEMPLATE;
document.querySelector("#logout").addEventListener("click", () => {
  logout().catch(() => setError("退出失败"));
});
document.querySelector("#copy-template").addEventListener("click", async (event) => {
  await copyAndFlash(event.currentTarget, TEMPLATE, "复制模板");
});
document.querySelector("#copy-token").addEventListener("click", async (event) => {
  await copyAndFlash(event.currentTarget, tokenValue.textContent || "", "复制 token");
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setError("");
  const payload = new FormData(form);
  const secret = String(payload.get("secret") || "").trim();
  const body = { name: String(payload.get("name") || "").trim() };
  if (secret) body.secret = secret;
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    const result = await api("/api/v1/devices", { method: "POST", body: JSON.stringify(body) });
    if (!result.response.ok) {
      setError(result.data.error || "创建失败");
      return;
    }
    tokenValue.textContent = result.data.token;
    tokenBox.hidden = false;
    form.reset();
    await loadDevices();
  } catch (error) {
    if (error instanceof Error && error.message === "unauthorized") return;
    setError("创建失败");
  } finally {
    button.disabled = false;
  }
});

loadDevices().catch((error) => {
  if (error instanceof Error && error.message === "unauthorized") return;
  setError("加载设备失败");
});

async function loadDevices() {
  const result = await api("/api/v1/devices");
  devices.replaceChildren();
  const rows = result.data.devices || [];
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "还没有设备。";
    devices.append(empty);
    return;
  }
  for (const device of rows) {
    const row = document.createElement("article");
    row.className = "device";
    const text = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = device.name;
    const meta = document.createElement("p");
    meta.className = "subtle";
    const seen = device.last_seen_at ? `最近上报 ${formatTime(device.last_seen_at)}` : "还没有上报";
    meta.textContent = `${seen}${device.has_secret ? " · 已启用 HMAC" : ""}`;
    text.append(title, meta);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "删除";
    remove.addEventListener("click", async () => {
      if (!window.confirm(`删除「${device.name}」及其短信？`)) return;
      const deleted = await api(`/api/v1/devices/${device.id}`, { method: "DELETE" });
      if (!deleted.response.ok) {
        setError(deleted.data.error || "删除失败");
        return;
      }
      await loadDevices();
    });
    row.append(text, remove);
    devices.append(row);
  }
}

async function copyAndFlash(button, value, label) {
  try {
    await copyText(value);
    button.textContent = "已复制";
  } catch {
    button.textContent = "复制失败";
  }
  window.setTimeout(() => {
    button.textContent = label;
  }, 1600);
}

function setError(message) {
  errorBox.hidden = !message;
  errorBox.textContent = message;
}
