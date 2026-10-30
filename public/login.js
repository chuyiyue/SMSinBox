import { api, safeNext } from "./common.js";

const form = document.querySelector("#login-form");
const error = document.querySelector("#login-error");
const next = safeNext(new URLSearchParams(location.search).get("next"));

const existing = await api("/api/v1/auth/me", { allowUnauthorized: true });
if (existing.response.ok) location.replace(next);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = form.querySelector("button");
  button.disabled = true;
  error.hidden = true;
  const payload = new FormData(form);
  try {
    const result = await api("/api/v1/auth/login", {
      method: "POST",
      allowUnauthorized: true,
      body: JSON.stringify({
        username: payload.get("username"),
        password: payload.get("password"),
      }),
    });
    if (!result.response.ok) {
      error.textContent = result.data.error || "登录失败";
      error.hidden = false;
      return;
    }
    location.assign(next);
  } catch {
    error.textContent = "网络错误，请重试";
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
});
