import { api, safeNext } from "./common.js";
import { takeFlash } from "./ui.js";

const form = document.querySelector("#login-form");
const error = document.querySelector("#login-error");
const password = document.querySelector("#password");
const toggle = document.querySelector("#password-toggle");
const submit = document.querySelector("#login-submit");
const totpForm = document.querySelector("#totp-form");
const totpError = document.querySelector("#totp-error");
const totpCode = document.querySelector("#totp-code");
const totpSubmit = document.querySelector("#totp-submit");
const totpCancel = document.querySelector("#totp-cancel");
const next = safeNext(new URLSearchParams(location.search).get("next"));
const label = "登录";
let ticket = "";

const flash = takeFlash();
if (flash) showError(flash);

toggle.addEventListener("click", () => {
  const show = password.type === "password";
  password.type = show ? "text" : "password";
  toggle.setAttribute("aria-pressed", show ? "true" : "false");
  toggle.setAttribute("aria-label", show ? "隐藏密码" : "显示密码");
});

const existing = await api("/api/v1/auth/me", { allowUnauthorized: true });
if (existing.response.ok) location.replace(next);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.hidden = true;
  const payload = new FormData(form);
  const username = String(payload.get("username") || "").trim();
  const passwordValue = String(payload.get("password") || "");
  setBusy(true);
  try {
    const result = await api("/api/v1/auth/login", {
      method: "POST",
      allowUnauthorized: true,
      body: JSON.stringify({ username, password: passwordValue }),
    });
    if (!result.response.ok) {
      showError(loginMessage(result.data.error));
      return;
    }
    if (result.data.totp_required && result.data.ticket) {
      ticket = String(result.data.ticket);
      form.hidden = true;
      totpForm.hidden = false;
      totpError.hidden = true;
      totpCode.value = "";
      totpCode.focus();
      return;
    }
    location.assign(next);
  } catch {
    showError("网络错误，请重试");
  } finally {
    setBusy(false);
  }
});

totpForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  totpError.hidden = true;
  const code = totpCode.value.trim();
  if (!code) {
    showTotpError("请输入验证码");
    return;
  }
  setTotpBusy(true);
  try {
    const result = await api("/api/v1/auth/totp/verify", {
      method: "POST",
      allowUnauthorized: true,
      body: JSON.stringify({ ticket, code }),
    });
    if (!result.response.ok) {
      const message = String(result.data.error || "验证失败");
      if (result.response.status === 401 && message.includes("过期")) {
        backToPassword("验证已过期，请重新输入密码");
        return;
      }
      showTotpError(loginMessage(message));
      return;
    }
    location.assign(next);
  } catch {
    showTotpError("网络错误，请重试");
  } finally {
    setTotpBusy(false);
  }
});

totpCancel.addEventListener("click", () => backToPassword(""));

function backToPassword(message) {
  ticket = "";
  totpForm.hidden = true;
  totpCode.value = "";
  totpError.hidden = true;
  form.hidden = false;
  if (message) showError(message);
  password.focus();
}

function loginMessage(value) {
  if (value === "用户名或密码错误") return "用户名或密码不正确";
  if (value === "账号已停用") return "该账号已停用，请联系管理员";
  if (value === "验证码不正确") return "验证码或恢复码不正确";
  return value || "登录失败";
}

function showError(message) {
  error.textContent = message;
  error.hidden = false;
}

function showTotpError(message) {
  totpError.textContent = message;
  totpError.hidden = false;
}

function setBusy(busy) {
  submit.disabled = busy;
  for (const field of form.querySelectorAll("input")) field.disabled = busy;
  submit.replaceChildren();
  if (busy) {
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    spinner.setAttribute("aria-hidden", "true");
    submit.append(spinner, document.createTextNode("登录中…"));
    return;
  }
  submit.textContent = label;
}

function setTotpBusy(busy) {
  totpSubmit.disabled = busy;
  totpCode.disabled = busy;
  totpSubmit.textContent = busy ? "验证中…" : "验证并登录";
}
