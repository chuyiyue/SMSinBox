import { api, safeNext } from "./common.js";
import { takeFlash } from "./ui.js";

const form = document.querySelector("#login-form");
const error = document.querySelector("#login-error");
const password = document.querySelector("#password");
const toggle = document.querySelector("#password-toggle");
const submit = document.querySelector("#login-submit");
const next = safeNext(new URLSearchParams(location.search).get("next"));
const label = "登录";

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
  const password = String(payload.get("password") || "");
  setBusy(true);
  try {
    const result = await api("/api/v1/auth/login", {
      method: "POST",
      allowUnauthorized: true,
      body: JSON.stringify({ username, password }),
    });
    if (!result.response.ok) {
      showError(loginMessage(result.data.error));
      return;
    }
    location.assign(next);
  } catch {
    showError("网络错误，请重试");
  } finally {
    setBusy(false);
  }
});

function loginMessage(value) {
  if (value === "用户名或密码错误") return "用户名或密码不正确";
  if (value === "账号已停用") return "该账号已停用，请联系管理员";
  return value || "登录失败";
}

function showError(message) {
  error.textContent = message;
  error.hidden = false;
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
