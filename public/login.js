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
let lockedUntil = 0;
let countdownTimer = 0;

const flash = takeFlash();
if (flash) showError(flash);

toggle.addEventListener("click", () => {
  const show = password.type === "password";
  password.type = show ? "text" : "password";
  toggle.setAttribute("aria-pressed", show ? "true" : "false");
  toggle.setAttribute("aria-label", show ? "隐藏密码" : "显示密码");
});

password.addEventListener("input", () => {
  // Typing again clears a plain error banner, but not a running rate limit.
  if (error.dataset.tone === "locked") return;
  delete error.dataset.tone;
  error.hidden = true;
});

try {
  const existing = await api("/api/v1/auth/me", { allowUnauthorized: true });
  if (existing.response.ok) location.replace(next);
} catch {
  // A network hiccup must not stop the password form from working.
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (Date.now() < lockedUntil) return;
  hideError();
  const passwordValue = password.value;
  if (!passwordValue) {
    showError("请输入密码");
    password.focus();
    return;
  }
  setBusy(true);
  try {
    const result = await api("/api/v1/auth/login", {
      method: "POST",
      allowUnauthorized: true,
      body: JSON.stringify({ password: passwordValue }),
    });
    if (result.response.status === 429) {
      startCountdown(retryAfterSeconds(result.response.headers.get("retry-after")));
      return;
    }
    if (!result.response.ok) {
      showError(loginMessage(result.response.status, result.data.error));
      password.select();
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
      showTotpError(loginMessage(result.response.status, message));
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

function loginMessage(status, value) {
  // Keep the old wording working in case a proxy still serves the previous worker.
  if (value === "用户名或密码错误") return "密码不正确";
  if (value === "账号已停用") return "该账号已停用";
  if (value === "验证码不正确") return "验证码或恢复码不正确";
  if (value === "跨站请求被拒绝") return "请求被拒绝，请刷新页面后重试";
  if (status === 403) return "请求被拒绝，请刷新页面后重试";
  if (status === 401) return "密码不正确";
  return value || "登录失败";
}

function retryAfterSeconds(header) {
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, 60 * 60);
  return 60;
}

function startCountdown(seconds) {
  window.clearInterval(countdownTimer);
  countdownTimer = 0;
  lockedUntil = Date.now() + seconds * 1000;
  error.dataset.tone = "locked";
  paintCountdown(seconds);
  setBusy(false);
  countdownTimer = window.setInterval(() => {
    const left = Math.ceil((lockedUntil - Date.now()) / 1000);
    if (left <= 0) {
      window.clearInterval(countdownTimer);
      countdownTimer = 0;
      lockedUntil = 0;
      hideError();
      setBusy(false);
      password.focus();
      return;
    }
    paintCountdown(left);
  }, 1000);
}

function paintCountdown(seconds) {
  showError(`尝试次数过多，请 ${waitText(seconds)}后再试`);
  submit.disabled = true;
  submit.textContent = `${seconds} 秒后可重试`;
}

function waitText(seconds) {
  if (seconds >= 60) {
    const minutes = Math.ceil(seconds / 60);
    return `${minutes} 分钟`;
  }
  return `${seconds} 秒`;
}

function showError(message) {
  error.textContent = message;
  error.hidden = false;
}

function hideError() {
  delete error.dataset.tone;
  error.hidden = true;
  error.textContent = "";
}

function showTotpError(message) {
  totpError.textContent = message;
  totpError.hidden = false;
}

function setBusy(busy) {
  const locked = Date.now() < lockedUntil;
  submit.disabled = busy || locked;
  password.disabled = busy;
  if (busy) {
    submit.replaceChildren();
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    spinner.setAttribute("aria-hidden", "true");
    submit.append(spinner, document.createTextNode("登录中…"));
    return;
  }
  if (!locked) submit.textContent = label;
}

function setTotpBusy(busy) {
  totpSubmit.disabled = busy;
  totpCode.disabled = busy;
  totpSubmit.textContent = busy ? "验证中…" : "验证并登录";
}
