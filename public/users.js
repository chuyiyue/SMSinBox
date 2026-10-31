import { api, formatTime, loadNav, logout } from "./common.js";

const form = document.querySelector("#user-form");
const errorBox = document.querySelector("#user-error");
const statusBox = document.querySelector("#user-status");
const list = document.querySelector("#users");

document.querySelector("#logout").addEventListener("click", () => {
  logout().catch(() => setError("退出失败"));
});

let me = null;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setError("");
  const payload = new FormData(form);
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    const result = await api("/api/v1/users", {
      method: "POST",
      body: JSON.stringify({
        username: String(payload.get("username") || "").trim(),
        password: String(payload.get("password") || ""),
        role: String(payload.get("role") || "member"),
      }),
    });
    if (!result.response.ok) {
      setError(result.data.error || "添加失败");
      return;
    }
    form.reset();
    setStatus(`已添加 ${result.data.user?.username || ""}`);
    await loadUsers();
  } catch (error) {
    if (error instanceof Error && error.message === "unauthorized") return;
    setError("添加失败");
  } finally {
    button.disabled = false;
  }
});

boot().catch((error) => {
  if (error instanceof Error && error.message === "unauthorized") return;
  setError("加载用户失败");
});

async function boot() {
  me = await loadNav();
  await loadUsers();
}

async function loadUsers() {
  const result = await api("/api/v1/users");
  list.replaceChildren();
  if (!result.response.ok) {
    setError(result.data.error || "加载用户失败");
    return;
  }
  const rows = result.data.users || [];
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "还没有用户。";
    list.append(empty);
    return;
  }
  for (const user of rows) list.append(renderUser(user));
}

function renderUser(user) {
  const row = document.createElement("article");
  row.className = "device";
  const text = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = user.username;
  const meta = document.createElement("p");
  meta.className = "subtle";
  const role = user.role === "admin" ? "管理员" : "普通用户";
  const state = user.disabled_at ? "已停用" : "正常";
  const self = me && user.id === me.id ? " · 这是你自己" : "";
  meta.textContent = `${role} · ${state} · 创建于 ${formatTime(user.created_at)}${self}`;
  text.append(title, meta);

  const actions = document.createElement("div");
  actions.className = "actions";
  if (!self) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "secondary";
    toggle.textContent = user.disabled_at ? "启用" : "停用";
    toggle.addEventListener("click", () => patchUser(user, { disabled: !user.disabled_at }, toggle.textContent));
    actions.append(toggle);
  }
  const roleButton = document.createElement("button");
  roleButton.type = "button";
  roleButton.className = "secondary";
  roleButton.textContent = user.role === "admin" ? "取消管理员" : "设为管理员";
  roleButton.addEventListener("click", () =>
    patchUser(user, { role: user.role === "admin" ? "member" : "admin" }, roleButton.textContent),
  );
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "secondary";
  reset.textContent = "重置密码";
  reset.addEventListener("click", async () => {
    const password = window.prompt(`为「${user.username}」设置新密码（8 到 256 位）`);
    if (!password) return;
    await patchUser(user, { password }, "重置密码");
  });
  actions.append(roleButton, reset);
  if (!self) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "删除";
    remove.addEventListener("click", async () => {
      if (!window.confirm(`删除「${user.username}」及其设备、短信和推送渠道？`)) return;
      const deleted = await api(`/api/v1/users/${user.id}`, { method: "DELETE" });
      if (!deleted.response.ok) {
        setError(deleted.data.error || "删除失败");
        return;
      }
      setStatus(`已删除 ${user.username}`);
      await loadUsers();
    });
    actions.append(remove);
  }
  row.append(text, actions);
  return row;
}

async function patchUser(user, body, label) {
  setError("");
  try {
    const result = await api(`/api/v1/users/${user.id}`, { method: "POST", body: JSON.stringify(body) });
    if (!result.response.ok) {
      setError(result.data.error || `${label}失败`);
      return;
    }
    setStatus(body.password ? "密码已更新。如果改的是自己的密码，请重新登录。" : `已更新 ${user.username}`);
    await loadUsers();
  } catch (error) {
    if (error instanceof Error && error.message === "unauthorized") return;
    setError(`${label}失败`);
  }
}

function setError(message) {
  errorBox.hidden = !message;
  errorBox.textContent = message;
}

function setStatus(message) {
  statusBox.hidden = !message;
  statusBox.textContent = message;
}
