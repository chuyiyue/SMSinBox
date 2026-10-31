import { api, copyText, formatTime, initShell, loadNav, logout } from "./common.js";

const TEMPLATE = '{"from":"{{FROM}}","content":"{{SMS}}","timestamp":"{{RECEIVE_TIME}}","device":"{{DEVICE_NAME}}","sim":"{{CARD_SLOT}}"}';
const PUSH_LABEL = {
  none: "未生成推送链接",
  active: "推送链接有效",
  revoked: "推送链接已撤销",
};
const form = document.querySelector("#device-form");
const errorBox = document.querySelector("#device-error");
const statusBox = document.querySelector("#device-status");
const tokenBox = document.querySelector("#token-box");
const bearerWrap = document.querySelector("#bearer-wrap");
const tokenValue = document.querySelector("#token-value");
const pushWrap = document.querySelector("#push-wrap");
const pushUrlValue = document.querySelector("#push-url-value");
const devices = document.querySelector("#devices");
const webhookUrl = `${location.origin}/api/v1/sms`;
let shownDeviceId = "";

document.querySelector("#sms-url").textContent = webhookUrl;
document.querySelector("#android-template").textContent = TEMPLATE;
initShell({
  onLogout: () => logout().catch(() => setError("退出失败")),
  onRefresh: () => loadDevices().catch(() => setError("加载设备失败")),
});
document.querySelector("#copy-template").addEventListener("click", async (event) => {
  await copyAndFlash(event.currentTarget, TEMPLATE, "复制模板");
});
document.querySelector("#copy-token").addEventListener("click", async (event) => {
  await copyAndFlash(event.currentTarget, tokenValue.textContent || "", "复制 token");
});
document.querySelector("#copy-push-url").addEventListener("click", async (event) => {
  await copyAndFlash(event.currentTarget, pushUrlValue.textContent || "", "复制推送链接");
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
    showCredentials({
      deviceId: result.data.device?.id || "",
      token: result.data.token || "",
      pushUrl: result.data.push_url || "",
    });
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
loadNav().catch((error) => {
  if (error instanceof Error && error.message === "unauthorized") return;
});

function showCredentials({ deviceId, token, pushUrl }) {
  shownDeviceId = deviceId || "";
  tokenValue.textContent = token || "";
  pushUrlValue.textContent = pushUrl || "";
  bearerWrap.hidden = !token;
  pushWrap.hidden = !pushUrl;
  tokenBox.hidden = !token && !pushUrl;
}

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
    const push = PUSH_LABEL[device.push] || PUSH_LABEL.none;
    meta.textContent = `${seen}${device.has_secret ? " · 已启用 HMAC" : ""} · ${push}`;
    text.append(title, meta);
    const actions = document.createElement("div");
    actions.className = "actions";
    const test = document.createElement("button");
    test.type = "button";
    test.className = "secondary";
    test.textContent = "发送测试消息";
    test.addEventListener("click", async () => {
      test.disabled = true;
      setError("");
      try {
        const sent = await api(`/api/v1/devices/${device.id}/test`, { method: "POST", body: "{}" });
        if (!sent.response.ok) {
          setStatus(sent.data.error || "测试失败");
          return;
        }
        setStatus(`已写入收件箱，验证码 ${sent.data.code || ""}`);
      } catch (error) {
        if (error instanceof Error && error.message === "unauthorized") return;
        setStatus("测试失败");
      } finally {
        test.disabled = false;
      }
    });
    actions.append(test);
    if (device.push !== "active") actions.append(pushButton(device, "issue", "生成推送链接"));
    if (device.push === "active" || device.push === "revoked") actions.append(pushButton(device, "rotate", "轮换"));
    if (device.push === "active") actions.append(pushButton(device, "revoke", "撤销"));
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
      if (shownDeviceId === device.id) showCredentials({ deviceId: "", token: "", pushUrl: "" });
      await loadDevices();
    });
    actions.append(remove);
    row.append(text, actions);
    devices.append(row);
  }
}

function pushButton(device, action, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = action === "revoke" ? "danger" : "secondary";
  button.textContent = label;
  button.addEventListener("click", async () => {
    if (action === "rotate" && !window.confirm(`轮换「${device.name}」的推送链接？手机上的旧链接会立刻失效。`)) return;
    if (action === "revoke" && !window.confirm(`撤销「${device.name}」的推送链接？短信仍会保留。`)) return;
    button.disabled = true;
    setError("");
    try {
      const result = await api(`/api/v1/devices/${device.id}/push`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      if (!result.response.ok) {
        setError(result.data.error || "操作失败");
        return;
      }
      if (result.data.push_url) {
        showCredentials({ deviceId: device.id, token: "", pushUrl: result.data.push_url });
      } else if (shownDeviceId === device.id) {
        showCredentials({ deviceId: "", token: "", pushUrl: "" });
      }
      await loadDevices();
    } catch (error) {
      if (error instanceof Error && error.message === "unauthorized") return;
      setError("操作失败");
    } finally {
      button.disabled = false;
    }
  });
  return button;
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

function setStatus(message) {
  statusBox.hidden = !message;
  statusBox.textContent = message;
}
