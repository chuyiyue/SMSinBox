import { api, safeNext, showNotice } from "./common.js";
import { applyI18n, t } from "./i18n.js";
import { takeFlash } from "./ui.js";

applyI18n(document);

const form = document.querySelector("#login-form");
const error = document.querySelector("#login-error");
const username = document.querySelector("#username");
const password = document.querySelector("#password");
const toggle = document.querySelector("#password-toggle");
const submit = document.querySelector("#login-submit");
const totpForm = document.querySelector("#totp-form");
const totpError = document.querySelector("#totp-error");
const totpCode = document.querySelector("#totp-code");
const totpSubmit = document.querySelector("#totp-submit");
const totpCancel = document.querySelector("#totp-cancel");
const alternatives = document.querySelector("#auth-alternatives");
const params = new URLSearchParams(location.search);
const next = safeNext(params.get("next"));
let ticket = "";
let lockedUntil = 0;
let countdownTimer = 0;
let githubEnabled = false;

const flash = takeFlash();
if (flash) showError(flash);

// GitHub OAuth failures come back as /login?error=<code>: show the mapped
// message once, then scrub the parameter so a refresh stays clean.
const GITHUB_ERRORS = {
  github_forbidden: "auth.githubForbidden",
  github_state: "auth.githubState",
  github_exchange: "auth.githubExchange",
};
const oauthError = params.get("error");
if (oauthError && GITHUB_ERRORS[oauthError]) {
  showError(t(GITHUB_ERRORS[oauthError]));
  params.delete("error");
  const query = params.toString();
  history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
}

toggle.addEventListener("click", () => {
  const show = password.type === "password";
  password.type = show ? "text" : "password";
  toggle.setAttribute("aria-pressed", show ? "true" : "false");
  const labelKey = show ? "auth.hidePassword" : "auth.showPassword";
  toggle.setAttribute("data-i18n-attr", `aria-label:${labelKey}`);
  toggle.setAttribute("aria-label", t(labelKey));
});

for (const field of [username, password]) {
  field.addEventListener("input", () => {
    // Typing again clears a plain error banner, but not a running rate limit.
    if (error.dataset.tone === "locked") return;
    delete error.dataset.tone;
    error.hidden = true;
  });
}

try {
  const existing = await api("/api/v1/auth/me", { allowUnauthorized: true });
  if (existing.response.ok) location.replace(next);
} catch {
  // A network hiccup must not stop the password form from working.
}

// The GitHub button appears only when the server reports OAuth configured
// (github_enabled); a missing field or failed read keeps it hidden.
try {
  const config = await api("/api/v1/system/info", { allowUnauthorized: true });
  githubEnabled = Boolean(config.response.ok && config.data.github_enabled);
} catch {
  githubEnabled = false;
}
paintAlternatives();

function paintAlternatives() {
  if (alternatives) alternatives.hidden = !(githubEnabled && !form.hidden);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (Date.now() < lockedUntil) return;
  hideError();
  const usernameValue = username.value.trim();
  if (!usernameValue) {
    showError(t("auth.enterUsername"));
    username.focus();
    return;
  }
  const passwordValue = password.value;
  if (!passwordValue) {
    showError(t("auth.enterPassword"));
    password.focus();
    return;
  }
  setBusy(true);
  try {
    const result = await api("/api/v1/auth/login", {
      method: "POST",
      allowUnauthorized: true,
      body: JSON.stringify({ username: usernameValue, password: passwordValue }),
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
      if (alternatives) alternatives.hidden = true;
      totpForm.hidden = false;
      totpError.hidden = true;
      totpCode.value = "";
      totpCode.focus();
      return;
    }
    location.assign(next);
  } catch {
    showError(t("auth.networkError"));
  } finally {
    setBusy(false);
  }
});

totpForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  totpError.hidden = true;
  const code = totpCode.value.trim();
  if (!code) {
    showTotpError(t("auth.enterCode"));
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
      const message = String(result.data.error || t("auth.verifyFailed"));
      if (result.response.status === 401 && message.includes("过期")) {
        backToPassword(t("auth.codeExpired"));
        return;
      }
      showTotpError(loginMessage(result.response.status, message));
      return;
    }
    location.assign(next);
  } catch {
    showTotpError(t("auth.networkError"));
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
  paintAlternatives();
  if (message) showError(message);
  password.focus();
}

function loginMessage(status, value) {
  // Keep the old wording working in case a proxy still serves the previous worker.
  if (value === "用户名或密码错误") return t("auth.badPassword");
  if (value === "账号已停用") return t("auth.accountDisabled");
  if (value === "验证码不正确") return t("auth.badCode");
  if (value === "跨站请求被拒绝") return t("auth.requestRejected");
  if (status === 403) return t("auth.requestRejected");
  if (status === 401) return t("auth.badPassword");
  return value || t("auth.loginFailed");
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
  showError(t("auth.rateLimited", { wait: waitText(seconds) }));
  submit.disabled = true;
  submit.textContent = t("auth.retryIn", { n: seconds });
}

function waitText(seconds) {
  if (seconds >= 60) {
    const minutes = Math.ceil(seconds / 60);
    return t("auth.waitMinutes", { n: minutes });
  }
  return t("auth.waitSeconds", { n: seconds });
}

function showError(message) {
  showNotice(error, message);
}

function hideError() {
  delete error.dataset.tone;
  error.hidden = true;
  error.textContent = "";
}

function showTotpError(message) {
  showNotice(totpError, message);
}

function setBusy(busy) {
  const locked = Date.now() < lockedUntil;
  submit.disabled = busy || locked;
  username.disabled = busy;
  password.disabled = busy;
  if (busy) {
    submit.replaceChildren();
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    spinner.setAttribute("aria-hidden", "true");
    submit.append(spinner, document.createTextNode(t("auth.signingIn")));
    return;
  }
  if (!locked) submit.textContent = t("auth.signIn");
}

function setTotpBusy(busy) {
  totpSubmit.disabled = busy;
  totpCode.disabled = busy;
  totpSubmit.textContent = busy ? t("auth.verifying") : t("auth.verifySignIn");
}
