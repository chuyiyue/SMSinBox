import {
  absoluteTime,
  api,
  formatTime,
  initShell,
  isUnauthorized,
  loadNav,
  logout,
  openModal,
  paintSidebarAvatar,
  paintSidebarProfile,
  passwordScore,
  showNotice,
  toast,
} from "./common.js";
import { ensureDevices, ensureMe, getDevices, getMe, noteMe, refreshDevices } from "./device-store.js";
import { go, registerView } from "./shell.js";
import { initTotpSettings } from "./totp-settings.js";
import { rememberFlash } from "./ui.js";

let viewToken = 0;
let me = null;
let sessions = [];
let systemInfo = null;
let translateEnabled = false;

let accountError;
let accountStatus;
let profileForm;
let profileUsername;
let profileError;
let profileSubmit;
let avatarPreview;
let avatarFile;
let avatarRemove;
let avatarError;
let githubPanel;
let githubError;
let githubStatus;
let githubBound;
let githubAvatar;
let githubLoginName;
let githubUnboundNote;
let githubBind;
let githubUnbind;
let passwordForm;
let passwordCurrent;
let passwordInput;
let passwordError;
let passwordSubmit;
let passwordStrength;
let sessionList;
let sessionsError;
let sessionsStatus;
let revokeOthers;
let translateState;
let translateError;
let translateToggle;
let factVersion;
let factDevices;
let factSessions;
let pageError;
let pageRetry;
let pageRetryButton;

function startView() {
  viewToken += 1;
  const token = viewToken;
  me = null;
  sessions = [];
  systemInfo = null;

  accountError = document.querySelector("#account-error");
  accountStatus = document.querySelector("#account-status");
  profileForm = document.querySelector("#profile-form");
  profileUsername = document.querySelector("#profile-username");
  profileError = document.querySelector("#profile-error");
  profileSubmit = document.querySelector("#profile-submit");
  avatarPreview = document.querySelector("#avatar-preview");
  avatarFile = document.querySelector("#avatar-file");
  avatarRemove = document.querySelector("#avatar-remove");
  avatarError = document.querySelector("#avatar-error");
  githubPanel = document.querySelector("#github-panel");
  githubError = document.querySelector("#github-error");
  githubStatus = document.querySelector("#github-status");
  githubBound = document.querySelector("#github-bound");
  githubAvatar = document.querySelector("#github-avatar");
  githubLoginName = document.querySelector("#github-login-name");
  githubUnboundNote = document.querySelector("#github-unbound-note");
  githubBind = document.querySelector("#github-bind");
  githubUnbind = document.querySelector("#github-unbind");
  passwordForm = document.querySelector("#password-form");
  passwordCurrent = document.querySelector("#password-current");
  passwordInput = document.querySelector("#password");
  passwordError = document.querySelector("#password-error");
  passwordSubmit = document.querySelector("#password-submit");
  passwordStrength = document.querySelector("#password-strength");
  sessionList = document.querySelector("#session-list");
  sessionsError = document.querySelector("#sessions-error");
  sessionsStatus = document.querySelector("#sessions-status");
  revokeOthers = document.querySelector("#revoke-others");
  translateState = document.querySelector("#translate-state");
  translateError = document.querySelector("#translate-error");
  translateToggle = document.querySelector("#translate-toggle");
  factVersion = document.querySelector("#fact-version");
  factDevices = document.querySelector("#fact-devices");
  factSessions = document.querySelector("#fact-sessions");
  pageError = document.querySelector("#page-error");
  pageRetry = document.querySelector("#page-retry");
  pageRetryButton = document.querySelector("#page-retry-button");

  initShell({
    onLogout: () => logout().catch(() => setAccountError("退出失败")),
    onRefresh: () => refreshPage(),
  });
  const cleanupTotp = initTotpSettings();

  profileForm.addEventListener("submit", submitProfile);
  passwordForm.addEventListener("submit", submitPassword);
  passwordInput.addEventListener("input", () => paintPassword(true));
  document.querySelector("#sessions-refresh").addEventListener("click", () => {
    Promise.resolve(loadSessions()).catch((error) => {
      if (isUnauthorized(error)) return;
      setSessionsError("加载会话失败");
    });
  });
  revokeOthers.addEventListener("click", revokeOtherSessions);
  translateToggle.addEventListener("click", () => {
    void toggleTranslate();
  });
  sessionList.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-session-id]") : null;
    if (!button) return;
    const id = button.getAttribute("data-session-id") || "";
    const session = sessions.find((item) => item.id === id);
    if (session) void revokeSession(session);
  });
  pageRetryButton.addEventListener("click", () => {
    Promise.resolve(boot(viewToken)).catch((error) => {
      if (isUnauthorized(error)) return;
      showRetry("加载系统管理信息失败");
    });
  });
  avatarFile.addEventListener("change", () => {
    const file = avatarFile.files?.[0];
    avatarFile.value = "";
    if (file) void uploadAvatar(file);
  });
  avatarRemove.addEventListener("click", () => {
    void removeAvatar();
  });
  githubUnbind.addEventListener("click", () => {
    void unbindGithub();
  });
  reportGithubReturn();

  boot(token).catch((error) => {
    if (token !== viewToken || isUnauthorized(error)) return;
    showRetry("加载系统管理信息失败");
  });

  return () => {
    if (viewToken === token) viewToken += 1;
    cleanupTotp();
  };
}

async function boot(token) {
  showNotice(pageError, "");
  showNotice(pageRetry, "");
  const meResult = await ensureMe();
  if (token !== viewToken || meResult?.stale) return;
  const user = meResult.user || null;
  const denied = meResult.status === 403 || (meResult.ok && user?.role !== "admin");
  if (denied) {
    rememberFlash("需要管理员权限");
    go("/", { replace: true });
    return;
  }
  if (!meResult.ok) {
    showRetry(meResult.error || "加载账号失败");
    return;
  }
  me = await loadNav();
  if (token !== viewToken) return;
  paintAccount();
  paintTranslate();
  await Promise.all([loadSessions(), loadDeviceCount(), loadSystemInfo()]);
}

async function refreshPage() {
  const token = viewToken;
  showNotice(pageError, "");
  await Promise.all([
    loadSessions().catch((error) => {
      if (isUnauthorized(error)) return;
      setSessionsError("加载会话失败");
    }),
    refreshDeviceCount(token),
    loadSystemInfo(),
  ]);
}

function paintAccount() {
  if (!me) me = { role: "admin" };
  // The profile username is a display nickname (and GitHub handle), never a
  // login credential; the login username itself is shown nowhere.
  profileUsername.value = typeof me.profile_username === "string" ? me.profile_username : "";
  paintAvatarPreview();
}

async function loadDeviceCount() {
  try {
    const result = await ensureDevices();
    if (!result?.ok) {
      factDevices.textContent = "读取失败";
      return;
    }
    factDevices.textContent = String(getDevices().length);
  } catch (error) {
    if (isUnauthorized(error)) return;
    factDevices.textContent = "读取失败";
  }
}

async function refreshDeviceCount(token) {
  try {
    const result = await refreshDevices();
    if (token !== viewToken) return;
    if (!result?.ok) {
      factDevices.textContent = "读取失败";
      return;
    }
    factDevices.textContent = String(getDevices().length);
  } catch (error) {
    if (isUnauthorized(error)) return;
    factDevices.textContent = "读取失败";
  }
}

async function loadSystemInfo() {
  try {
    const result = await api("/api/v1/system/info");
    if (!result.response.ok) {
      factVersion.textContent = "读取失败";
      paintGithub();
      return;
    }
    systemInfo = result.data;
    const version = typeof result.data.version === "string" ? result.data.version.trim() : "";
    factVersion.textContent = version || "未知";
    paintGithub();
  } catch (error) {
    if (isUnauthorized(error)) return;
    factVersion.textContent = "读取失败";
    paintGithub();
  }
}

function paintPassword(silent) {
  const value = passwordInput.value;
  const ok = value.length >= 8 && value.length <= 256;
  passwordStrength.dataset.score = String(passwordScore(value));
  passwordError.hidden = Boolean(silent) || ok;
  passwordError.textContent = ok ? "" : "密码长度需在 8 到 256 之间";
  passwordInput.setAttribute("aria-invalid", !silent && !ok ? "true" : "false");
  return ok;
}

async function submitProfile(event) {
  event.preventDefault();
  setAccountError("");
  setAccountStatus("");
  setProfileError("");
  const username = profileUsername.value.trim();
  profileSubmit.disabled = true;
  const previous = profileSubmit.textContent;
  profileSubmit.textContent = "保存中…";
  try {
    const result = await api("/api/v1/auth/profile", {
      method: "POST",
      body: JSON.stringify({ username }),
    });
    if (!result.response.ok) {
      setProfileError(result.data.error || "保存用户名失败");
      return;
    }
    const saved = typeof result.data.profile_username === "string" ? result.data.profile_username : username;
    profileUsername.value = saved;
    me = { ...(me || { role: "admin" }), profile_username: saved };
    noteMe({ profile_username: saved });
    paintSidebarProfile(getMe());
    paintAvatarPreview();
    const message = saved ? "用户名已保存" : "用户名已清除";
    setAccountStatus(message);
    toast(message);
  } catch (error) {
    if (isUnauthorized(error)) return;
    setProfileError("保存用户名失败，请重试");
  } finally {
    profileSubmit.disabled = false;
    profileSubmit.textContent = previous;
  }
}

function setProfileError(message) {
  profileError.hidden = !message;
  profileError.textContent = message;
}

// ─── Custom avatar ───────────────────────────────────────────────────────────

function paintAvatarPreview() {
  if (!avatarPreview) return;
  const profileUsername =
    me && typeof me.profile_username === "string" ? me.profile_username.trim() : "";
  const name = profileUsername || (me && (me.username || me.name)) || "管理员";
  paintSidebarAvatar(avatarPreview, name, profileUsername, me);
  if (avatarRemove) {
    avatarRemove.hidden = !(me && typeof me.avatar_data === "string" && me.avatar_data);
  }
}

function setAvatarError(message) {
  avatarError.hidden = !message;
  avatarError.textContent = message;
}

const AVATAR_DATA_LIMIT = 400 * 1024;

// Center-crop to a square and shrink to at most 128×128; if the exported
// data URL is still too large, step down in size and quality until it fits.
// Decoding prefers createImageBitmap: an <img> fed with a blob: URL is
// subject to the page's CSP, the bitmap decoder is not.
async function fileToAvatarDataUrl(file) {
  let source = null;
  let cleanup = () => {};
  try {
    if (typeof createImageBitmap === "function") {
      try {
        source = await createImageBitmap(file);
      } catch {
        source = null;
      }
    }
    if (!source) {
      const url = URL.createObjectURL(file);
      cleanup = () => URL.revokeObjectURL(url);
      source = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("图片读取失败，请换一张试试"));
        image.src = url;
      });
    }
    const width = source.naturalWidth ?? source.width;
    const height = source.naturalHeight ?? source.height;
    const side = Math.min(width, height);
    if (!side) throw new Error("图片读取失败，请换一张试试");
    const sx = (width - side) / 2;
    const sy = (height - side) / 2;
    for (const size of [128, 96, 64]) {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(source, sx, sy, side, side, 0, 0, size, size);
      for (const quality of [0.85, 0.7, 0.55]) {
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        if (dataUrl.length <= AVATAR_DATA_LIMIT) return dataUrl;
      }
    }
    throw new Error("图片压缩后仍过大，请换一张更小的图片");
  } finally {
    cleanup();
    if (source && typeof source.close === "function") source.close();
  }
}

async function uploadAvatar(file) {
  setAvatarError("");
  if (!file.type.startsWith("image/")) {
    setAvatarError("请选择图片文件");
    return;
  }
  avatarFile.disabled = true;
  try {
    const dataUrl = await fileToAvatarDataUrl(file);
    const result = await api("/api/v1/auth/avatar", {
      method: "POST",
      body: JSON.stringify({ image: dataUrl }),
    });
    if (!result.response.ok) {
      setAvatarError(result.data.error || "头像上传失败");
      return;
    }
    const saved = typeof result.data.avatar_data === "string" ? result.data.avatar_data : dataUrl;
    me = { ...(me || { role: "admin" }), avatar_data: saved };
    noteMe({ avatar_data: saved });
    paintAvatarPreview();
    paintSidebarProfile(getMe());
    setAccountStatus("头像已更新");
    toast("头像已更新");
  } catch (error) {
    if (isUnauthorized(error)) return;
    setAvatarError(error instanceof Error && error.message ? error.message : "头像上传失败，请重试");
  } finally {
    avatarFile.disabled = false;
  }
}

async function removeAvatar() {
  setAvatarError("");
  avatarRemove.disabled = true;
  try {
    const result = await api("/api/v1/auth/avatar", { method: "DELETE" });
    if (!result.response.ok) {
      setAvatarError(result.data.error || "移除头像失败");
      return;
    }
    me = { ...(me || { role: "admin" }), avatar_data: null };
    noteMe({ avatar_data: null });
    paintAvatarPreview();
    paintSidebarProfile(getMe());
    toast("已移除自定义头像");
  } catch (error) {
    if (isUnauthorized(error)) return;
    setAvatarError("移除头像失败，请重试");
  } finally {
    avatarRemove.disabled = false;
  }
}

// ─── GitHub login binding ────────────────────────────────────────────────────

// The OAuth callback returns to /users?github=bound|error: toast once and
// scrub the parameter so a refresh does not repeat it.
function reportGithubReturn() {
  const query = new URLSearchParams(location.search);
  const state = query.get("github");
  if (state !== "bound" && state !== "error") return;
  if (state === "bound") toast("GitHub 已绑定");
  else toast("GitHub 绑定失败，请重试", { tone: "danger" });
  query.delete("github");
  const rest = query.toString();
  history.replaceState(null, "", `${location.pathname}${rest ? `?${rest}` : ""}${location.hash}`);
}

function paintGithub() {
  if (!githubPanel) return;
  // The whole section exists only when the server has GitHub OAuth
  // configured; older workers simply omit github_enabled.
  const enabled = Boolean(systemInfo && systemInfo.github_enabled);
  githubPanel.hidden = !enabled;
  if (!enabled) return;
  const github = me && me.github && typeof me.github === "object" ? me.github : null;
  const login = github && typeof github.login === "string" ? github.login : "";
  githubBound.hidden = !login;
  githubUnboundNote.hidden = Boolean(login);
  githubBind.hidden = Boolean(login);
  githubUnbind.hidden = !login;
  if (login) {
    githubLoginName.textContent = login;
    const avatarUrl = typeof github.avatar_url === "string" ? github.avatar_url : "";
    githubAvatar.hidden = !avatarUrl;
    if (avatarUrl) githubAvatar.src = avatarUrl;
  }
}

async function unbindGithub() {
  const login =
    me && me.github && typeof me.github.login === "string" ? me.github.login : "GitHub";
  const confirmed = await openModal({
    title: "解绑 GitHub？",
    text: `解绑后将不能再用 GitHub 账号（${login}）登录本系统，密码登录不受影响。`,
    confirmLabel: "解绑",
    danger: true,
  });
  if (!confirmed) return;
  setGithubError("");
  setGithubStatus("");
  githubUnbind.disabled = true;
  try {
    const result = await api("/api/v1/auth/github/unbind", { method: "POST", body: "{}" });
    if (!result.response.ok) {
      const message = result.data.error || "解绑失败";
      setGithubError(message);
      toast(message, { tone: "danger" });
      return;
    }
    me = { ...(me || { role: "admin" }), github: null };
    noteMe({ github: null });
    paintGithub();
    paintAvatarPreview();
    paintSidebarProfile(getMe());
    setGithubStatus("已解绑 GitHub");
    toast("已解绑 GitHub");
  } catch (error) {
    if (isUnauthorized(error)) return;
    setGithubError("解绑失败，请重试");
  } finally {
    githubUnbind.disabled = false;
  }
}

function setGithubError(message) {
  showNotice(githubError, message);
}

function setGithubStatus(message) {
  showNotice(githubStatus, message);
}

// ─── SMS translation preference ──────────────────────────────────────────────

// The initial state comes from the /me user object; toggling PATCHes the
// preference and only repaints on success, so a failed save keeps the
// switch exactly as it was.
function paintTranslate() {
  translateEnabled = Boolean(me && me.translate_enabled);
  translateState.textContent = translateEnabled
    ? "已开启：新收到的非简体中文短信会自动翻译成简体中文。"
    : "未开启：短信只显示原文。";
  translateToggle.disabled = false;
  translateToggle.textContent = translateEnabled ? "关闭短信翻译" : "开启短信翻译";
  translateToggle.className = translateEnabled ? "secondary" : "primary";
}

async function toggleTranslate() {
  const next = !translateEnabled;
  translateToggle.disabled = true;
  showNotice(translateError, "");
  try {
    const result = await api("/api/v1/me/preferences", {
      method: "PATCH",
      body: JSON.stringify({ translate_enabled: next }),
    });
    if (!result.response.ok) {
      const message = result.data.error || "保存翻译设置失败";
      showNotice(translateError, message);
      toast(message, { tone: "danger" });
      return;
    }
    translateEnabled =
      typeof result.data.translate_enabled === "boolean" ? result.data.translate_enabled : next;
    me = { ...(me || { role: "admin" }), translate_enabled: translateEnabled };
    noteMe({ translate_enabled: translateEnabled });
    paintTranslate();
    toast(translateEnabled ? "已开启短信翻译" : "已关闭短信翻译");
  } catch (error) {
    if (isUnauthorized(error)) return;
    showNotice(translateError, "保存翻译设置失败，请重试");
    toast("保存翻译设置失败，请重试", { tone: "danger" });
  } finally {
    translateToggle.disabled = false;
  }
}

async function submitPassword(event) {
  event.preventDefault();
  setAccountError("");
  setAccountStatus("");
  const passwordOk = paintPassword(false);
  const currentPassword = passwordCurrent.value;
  if (!passwordOk) return;
  if (!currentPassword) {
    setAccountError("请填写当前密码");
    passwordCurrent.focus();
    return;
  }
  if (currentPassword === passwordInput.value) {
    setAccountError("新密码不能与当前密码相同");
    return;
  }
  passwordSubmit.disabled = true;
  const previous = passwordSubmit.textContent;
  passwordSubmit.textContent = "保存中…";
  try {
    const result = await api("/api/v1/auth/password", {
      method: "POST",
      body: JSON.stringify({ current_password: currentPassword, password: passwordInput.value }),
      allowUnauthorized: true,
    });
    if (!result.response.ok) {
      setAccountError(result.data.error || "改密码失败");
      return;
    }
    passwordCurrent.value = "";
    passwordInput.value = "";
    passwordInput.type = "password";
    passwordStrength.dataset.score = "0";
    rememberFlash("密码已更新，请用新密码重新登录");
    location.assign("/login.html");
  } catch (error) {
    if (isUnauthorized(error)) return;
    setAccountError("改密码失败，请重试");
  } finally {
    passwordSubmit.disabled = false;
    passwordSubmit.textContent = previous;
  }
}

async function loadSessions() {
  const token = viewToken;
  const result = await api("/api/v1/auth/sessions");
  if (token !== viewToken) return;
  if (!result.response.ok) {
    const message = result.data.error || "加载会话失败";
    setSessionsError(message);
    return;
  }
  setSessionsError("");
  sessions = Array.isArray(result.data.sessions) ? result.data.sessions : [];
  renderSessions();
}

function renderSessions() {
  sessionList.replaceChildren();
  factSessions.textContent = String(sessions.length);
  if (sessions.length === 0) {
    const empty = document.createElement("li");
    empty.className = "session-empty";
    empty.textContent = "没有有效的登录会话。";
    sessionList.append(empty);
    revokeOthers.disabled = true;
    return;
  }
  for (const session of sessions) sessionList.append(renderSession(session));
  revokeOthers.disabled = !sessions.some((session) => !session.current);
}

function renderSession(session) {
  const row = document.createElement("li");
  row.className = session.current ? "session-row is-current" : "session-row";

  const main = document.createElement("div");
  main.className = "session-main";
  const title = document.createElement("div");
  title.className = "session-title";
  const label = document.createElement("strong");
  label.textContent = session.current ? "当前会话" : "登录会话";
  title.append(label);
  if (session.current) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "当前";
    title.append(badge);
  }

  const meta = document.createElement("p");
  meta.className = "subtle";
  const createdAt = Number(session.created_at);
  const expiresAt = Number(session.expires_at);
  const parts = [];
  if (Number.isFinite(createdAt) && createdAt > 0) {
    parts.push(`登录于 ${formatTime(createdAt)}`);
  }
  if (Number.isFinite(expiresAt) && expiresAt > 0) {
    parts.push(`有效期至 ${formatTime(expiresAt)}`);
  }
  const agent = [session.browser, session.os, session.device]
    .filter((value) => typeof value === "string" && value)
    .join(" · ");
  if (agent) parts.push(agent);
  if (session.ip) parts.push(`IP ${session.ip}`);
  if (!parts.length) parts.push("会话时间未知");
  meta.textContent = parts.join(" · ");
  const detail = [];
  if (Number.isFinite(createdAt) && createdAt > 0) detail.push(`登录：${absoluteTime(createdAt)}`);
  if (Number.isFinite(expiresAt) && expiresAt > 0) detail.push(`过期：${absoluteTime(expiresAt)}`);
  if (detail.length) meta.title = detail.join("\n");
  main.append(title, meta);

  const action = document.createElement("button");
  action.type = "button";
  action.className = session.current ? "secondary" : "ghost";
  action.dataset.sessionId = session.id;
  action.textContent = session.current ? "退出此会话" : "撤销";
  action.setAttribute("aria-label", session.current ? "退出当前会话" : "撤销这个会话");

  row.append(main, action);
  return row;
}

async function revokeSession(session) {
  const confirmed = await openModal({
    title: session.current ? "退出当前会话？" : "撤销这个会话？",
    text: session.current
      ? "撤销后这个浏览器需要重新登录。"
      : "撤销后，对应浏览器需要重新登录。",
    confirmLabel: session.current ? "退出" : "撤销",
  });
  if (!confirmed) return;
  setSessionsError("");
  setSessionsStatus("");
  try {
    const result = await api(`/api/v1/auth/sessions/${session.id}`, { method: "DELETE" });
    if (!result.response.ok) {
      const message = result.data.error || "撤销会话失败";
      setSessionsError(message);
      toast(message, { tone: "danger" });
      return;
    }
    if (session.current) {
      rememberFlash("当前会话已撤销，请重新登录");
      location.assign("/login.html");
      return;
    }
    setSessionsStatus("已撤销这个会话");
    toast("已撤销这个会话");
    await loadSessions();
  } catch (error) {
    if (isUnauthorized(error)) return;
    setSessionsError("撤销会话失败，请重试");
  }
}

async function revokeOtherSessions() {
  const confirmed = await openModal({
    title: "撤销其它会话？",
    text: "当前会话会保留，其它浏览器需要重新登录。",
    confirmLabel: "撤销其它会话",
  });
  if (!confirmed) return;
  revokeOthers.disabled = true;
  setSessionsError("");
  setSessionsStatus("");
  try {
    const result = await api("/api/v1/auth/sessions/revoke-others", {
      method: "POST",
      body: "{}",
    });
    if (!result.response.ok) {
      const message = result.data.error || "撤销其它会话失败";
      setSessionsError(message);
      toast(message, { tone: "danger" });
      return;
    }
    setSessionsStatus("已撤销其它会话");
    toast("已撤销其它会话");
    await loadSessions();
  } catch (error) {
    if (isUnauthorized(error)) return;
    setSessionsError("撤销其它会话失败，请重试");
  } finally {
    revokeOthers.disabled = !sessions.some((session) => !session.current);
  }
}

function showRetry(message) {
  showNotice(pageError, "");
  pageRetry.hidden = false;
  const span = pageRetry.querySelector("span");
  if (span) span.textContent = message;
}

function setAccountError(message) {
  showNotice(accountError, message);
}

function setAccountStatus(message) {
  showNotice(accountStatus, message);
}

function setSessionsError(message) {
  showNotice(sessionsError, message);
}

function setSessionsStatus(message) {
  showNotice(sessionsStatus, message);
}

registerView("/users.html", startView);
