import {
  absoluteTime,
  api,
  formatTime,
  initShell,
  isUnauthorized,
  loadNav,
  logout,
  openMenu,
  openModal,
  passwordScore,
  generatePassword,
  showNotice,
  toast,
} from "./common.js";
import { rememberFlash } from "./ui.js";

const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const form = document.querySelector("#user-form");
const errorBox = document.querySelector("#user-error");
const statusBox = document.querySelector("#user-status");
const list = document.querySelector("#users");
const table = document.querySelector("#user-table");
const empty = document.querySelector("#user-empty");
const dialog = document.querySelector("#user-dialog");
const usernameInput = document.querySelector("#new-username");
const passwordInput = document.querySelector("#new-password");
const usernameError = document.querySelector("#username-error");
const passwordError = document.querySelector("#password-error");
const formError = document.querySelector("#user-form-error");
const strength = document.querySelector("#password-strength");
let me = null;
let users = [];

initShell({
  onLogout: () => logout().catch(() => setError("退出失败")),
  onRefresh: () => loadUsers().catch((error) => {
    if (isUnauthorized(error)) return;
    setError("加载用户失败");
  }),
});

document.querySelector("#add-user").addEventListener("click", openCreate);
document.querySelector("#user-cancel").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});
dialog.addEventListener("close", () => document.body.classList.remove("modal-open"));
usernameInput.addEventListener("input", () => paintUsername());
passwordInput.addEventListener("input", () => paintPassword());
document.querySelector("#generate-password").addEventListener("click", () => {
  passwordInput.value = generatePassword();
  passwordInput.type = "text";
  paintPassword();
  passwordInput.focus();
});
form.addEventListener("submit", submitUser);

boot().catch((error) => {
  if (isUnauthorized(error)) return;
  setError("加载用户失败");
});

async function boot() {
  const meResult = await api("/api/v1/auth/me");
  const user = meResult.data.user || null;
  const denied = meResult.response.status === 403 || (meResult.response.ok && user?.role !== "admin");
  if (denied) {
    rememberFlash("需要管理员权限");
    location.assign("/");
    return;
  }
  if (!meResult.response.ok) {
    setError("");
    showUserRetry(meResult.data.error || "加载用户失败", () => boot());
    return;
  }
  me = await loadNav();
  await loadUsers();
}

function openCreate() {
  form.reset();
  passwordInput.type = "password";
  paintUsername(true);
  paintPassword(true);
  showFormError("");
  strength.dataset.score = "0";
  if (!dialog.open) dialog.showModal();
  document.body.classList.add("modal-open");
  usernameInput.focus();
}

function paintUsername(silent) {
  const value = usernameInput.value.trim();
  const ok = USERNAME_RE.test(value);
  usernameError.hidden = Boolean(silent) || ok;
  usernameError.textContent = ok ? "" : value ? "用户名需以字母或数字开头，只能包含字母、数字、. _ -，最长 64。" : "请填写用户名";
  usernameInput.setAttribute("aria-invalid", !silent && !ok ? "true" : "false");
  return ok;
}

function paintPassword(silent) {
  const value = passwordInput.value;
  const ok = value.length >= 8 && value.length <= 256;
  strength.dataset.score = String(passwordScore(value));
  passwordError.hidden = Boolean(silent) || ok;
  passwordError.textContent = ok ? "" : "密码长度需在 8 到 256 之间";
  passwordInput.setAttribute("aria-invalid", !silent && !ok ? "true" : "false");
  return ok;
}

async function submitUser(event) {
  event.preventDefault();
  showFormError("");
  const usernameOk = paintUsername(false);
  const passwordOk = paintPassword(false);
  if (!usernameOk || !passwordOk) return;
  const payload = new FormData(form);
  const button = document.querySelector("#user-submit");
  button.disabled = true;
  const previous = button.textContent;
  button.textContent = "添加中…";
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
      const message = result.data.error || "添加失败";
      showFormError(message);
      toast(message, { tone: "danger" });
      return;
    }
    dialog.close();
    const name = result.data.user?.username || "";
    setStatus(`已添加 ${name}`);
    toast(`已添加 ${name}`);
    await loadUsers();
  } catch (error) {
    if (isUnauthorized(error)) return;
    showFormError("添加失败");
    toast("添加失败", { tone: "danger" });
  } finally {
    button.disabled = false;
    button.textContent = previous;
  }
}

async function loadUsers() {
  const result = await api("/api/v1/users");
  if (!result.response.ok) {
    if (result.response.status === 403) {
      rememberFlash("需要管理员权限");
      location.assign("/");
      return;
    }
    const message = result.data.error || "加载用户失败";
    if (!list.children.length) {
      setError("");
      showUserRetry(message, () => loadUsers());
      return;
    }
    setError(message);
    return;
  }
  setError("");
  users = result.data.users || [];
  list.replaceChildren();
  const none = users.length === 0;
  table.hidden = none;
  empty.hidden = !none;
  if (none) fillEmptyUsers();
  for (const user of users) list.append(renderUser(user));
}

function fillEmptyUsers() {
  empty.replaceChildren();
  const title = document.createElement("h2");
  title.className = "empty-title";
  title.textContent = "还没有用户";
  const text = document.createElement("p");
  text.textContent = "管理员可以在这里添加能登录的账号。";
  empty.append(title, text);
}

function renderUser(user) {
  const limits = access(user);
  const row = document.createElement("tr");
  const name = document.createElement("td");
  name.dataset.label = "用户名";
  name.textContent = user.username;
  if (limits.self) {
    const you = document.createElement("span");
    you.className = "badge you";
    you.textContent = "你";
    name.append(you);
  }
  const role = document.createElement("td");
  role.dataset.label = "角色";
  const roleBadge = document.createElement("span");
  roleBadge.className = user.role === "admin" ? "badge admin" : "badge";
  roleBadge.textContent = user.role === "admin" ? "管理员" : "普通用户";
  role.append(roleBadge);
  const state = document.createElement("td");
  state.dataset.label = "状态";
  state.textContent = user.disabled_at ? "已停用" : "正常";
  const created = document.createElement("td");
  created.dataset.label = "创建时间";
  const time = document.createElement("time");
  const createdAt = Number(user.created_at);
  time.textContent = formatTime(createdAt);
  if (Number.isFinite(createdAt)) {
    time.dateTime = new Date(createdAt).toISOString();
    time.title = absoluteTime(createdAt);
  }
  created.append(time);
  const action = document.createElement("td");
  action.dataset.label = "操作";
  const menu = document.createElement("button");
  menu.type = "button";
  menu.className = "ghost icon-btn";
  menu.setAttribute("aria-label", `${user.username} 的操作`);
  menu.textContent = "⋯";
  menu.addEventListener("click", () => openMenu(menu, menuItems(user, limits)));
  action.append(menu);
  row.append(name, role, state, created, action);
  return row;
}

function menuItems(user, limits) {
  const items = [];
  if (user.role === "admin") {
    items.push({
      label: "取消管理员",
      disabled: limits.demote.disabled,
      reason: limits.demote.reason,
      onSelect: () => patchUser(user, { role: "member" }, "取消管理员"),
    });
  } else {
    items.push({ label: "设为管理员", onSelect: () => patchUser(user, { role: "admin" }, "设为管理员") });
  }
  items.push({ label: "重置密码", onSelect: () => resetPassword(user) });
  if (user.disabled_at) {
    items.push({ label: "启用", onSelect: () => patchUser(user, { disabled: false }, "启用") });
  } else {
    items.push({
      label: "停用",
      disabled: limits.disable.disabled,
      reason: limits.disable.reason,
      onSelect: () => disableUser(user),
    });
  }
  items.push({
    label: "删除",
    danger: true,
    disabled: limits.remove.disabled,
    reason: limits.remove.reason,
    onSelect: () => deleteUser(user),
  });
  return items;
}

function access(user) {
  const self = Boolean(me && user.id === me.id);
  const enabledAdmins = users.filter((item) => item.role === "admin" && !item.disabled_at).length;
  const adminRoles = users.filter((item) => item.role === "admin").length;
  const lastEnabled = user.role === "admin" && !user.disabled_at && enabledAdmins <= 1;
  const soleAdmin = user.role === "admin" && adminRoles <= 1;
  return {
    self,
    disable: self
      ? { disabled: true, reason: "不能停用自己" }
      : lastEnabled
        ? { disabled: true, reason: "不能停用最后一位管理员" }
        : { disabled: false, reason: "" },
    demote: lastEnabled
      ? { disabled: true, reason: "不能取消最后一位管理员" }
      : { disabled: false, reason: "" },
    remove: self
      ? { disabled: true, reason: "不能删除自己" }
      : lastEnabled || soleAdmin
        ? { disabled: true, reason: "不能删除最后一位管理员" }
        : { disabled: false, reason: "" },
  };
}

async function disableUser(user) {
  const confirmed = await openModal({
    title: `停用「${user.username}」？`,
    text: "该用户的会话将立即失效。",
    confirmLabel: "停用",
  });
  if (!confirmed) return;
  await patchUser(user, { disabled: true }, "停用");
}

async function deleteUser(user) {
  const confirmed = await openModal({
    title: `删除用户「${user.username}」？`,
    text: "将同时删除该用户的所有设备、短信和推送渠道，无法恢复。",
    confirmLabel: "删除",
    danger: true,
    dismissible: false,
    requireText: user.username,
  });
  if (!confirmed) return;
  setError("");
  try {
    const deleted = await api(`/api/v1/users/${user.id}`, { method: "DELETE" });
    if (!deleted.response.ok) {
      const message = deleted.data.error || "删除失败";
      setError(message);
      toast(message, { tone: "danger" });
      return;
    }
    setStatus(`已删除 ${user.username}`);
    toast(`已删除 ${user.username}`);
    await loadUsers();
  } catch (error) {
    if (isUnauthorized(error)) return;
    setError("删除失败");
    toast("删除失败", { tone: "danger" });
  }
}

async function resetPassword(user) {
  const body = document.createElement("div");
  body.className = "stack";
  const label = document.createElement("label");
  label.append("新密码");
  const input = document.createElement("input");
  input.type = "password";
  input.autocomplete = "new-password";
  input.maxLength = 256;
  label.append(input);
  const meter = document.createElement("div");
  meter.className = "strength";
  meter.dataset.score = "0";
  meter.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 4; index += 1) meter.append(document.createElement("i"));
  const generate = document.createElement("button");
  generate.type = "button";
  generate.className = "ghost";
  generate.textContent = "生成强密码";
  const paint = () => {
    meter.dataset.score = String(passwordScore(input.value));
  };
  input.addEventListener("input", paint);
  generate.addEventListener("click", () => {
    input.value = generatePassword();
    input.type = "text";
    paint();
    input.focus();
  });
  body.append(label, meter, generate);
  const confirmed = await openModal({
    title: `重置「${user.username}」的密码`,
    text: "8 到 256 位。保存后，该用户需要用新密码登录。",
    body,
    confirmLabel: "保存",
    beforeClose: () => {
      if (input.value.length < 8 || input.value.length > 256) return "密码长度需在 8 到 256 之间";
      return "";
    },
  });
  if (!confirmed) return;
  await patchUser(user, { password: input.value }, "重置密码");
}

async function patchUser(user, body, label) {
  setError("");
  try {
    const result = await api(`/api/v1/users/${user.id}`, { method: "POST", body: JSON.stringify(body) });
    if (!result.response.ok) {
      const message = result.data.error || `${label}失败`;
      setError(message);
      toast(message, { tone: "danger" });
      return;
    }
    if (body.password) {
      const message = "该用户需使用新密码登录。";
      if (me && user.id === me.id) {
        rememberFlash(message);
        location.assign("/login.html");
        return;
      }
      setStatus(message);
      toast(message);
    } else {
      const message = `已更新 ${user.username}`;
      setStatus(message);
      toast(message);
    }
    await loadUsers();
  } catch (error) {
    if (isUnauthorized(error)) return;
    setError(`${label}失败`);
    toast(`${label}失败`, { tone: "danger" });
  }
}

function showUserRetry(message, again) {
  empty.hidden = false;
  table.hidden = true;
  empty.replaceChildren();
  const title = document.createElement("p");
  title.textContent = message;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary";
  button.textContent = "重试";
  button.addEventListener("click", () => {
    Promise.resolve(again()).catch((error) => {
      if (isUnauthorized(error)) return;
      setError("加载用户失败");
    });
  });
  empty.append(title, button);
}

function showFormError(message) {
  formError.hidden = !message;
  formError.textContent = message || "";
}

function setError(message) {
  showNotice(errorBox, message);
}

function setStatus(message) {
  showNotice(statusBox, message);
}
