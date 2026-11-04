import {
  absoluteTime,
  api,
  formatTime,
  initShell,
  isUnauthorized,
  loadNav,
  logout,
  mountSelect,
  openModal,
  paintSidebarAvatar,
  paintSidebarProfile,
  passwordScore,
  showNotice,
  toast,
} from "./common.js";
import { ensureDevices, ensureMe, getDevices, getMe, noteMe, refreshDevices } from "./device-store.js";
import { t, currentLocale, setLocale } from "./i18n.js";
import { go, registerView } from "./shell.js";
import { initTotpSettings } from "./totp-settings.js";
import { rememberFlash } from "./ui.js";

let viewToken = 0;
let me = null;
let sessions = [];
let systemInfo = null;
let translateEnabled = false;
let versionState = "loading";
let devicesState = "loading";
let sessionsReady = false;
let localeSelect = null;
let localeError = null;

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

function showKeyed(element, key) {
  if (!element) return;
  element.setAttribute("data-i18n", key);
  showNotice(element, t(key));
}

function showRaw(element, message) {
  if (!element) return;
  element.removeAttribute("data-i18n");
  showNotice(element, message);
}

function startView() {
  viewToken += 1;
  const token = viewToken;
  me = null;
  sessions = [];
  systemInfo = null;
  versionState = "loading";
  devicesState = "loading";
  sessionsReady = false;

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
    onLogout: () => logout().catch(() => setAccountError("", "users.logoutFailed")),
    onRefresh: () => refreshPage(),
  });
  const cleanupTotp = initTotpSettings();

  profileForm.addEventListener("submit", submitProfile);
  passwordForm.addEventListener("submit", submitPassword);
  passwordInput.addEventListener("input", () => paintPassword(true));
  document.querySelector("#sessions-refresh").addEventListener("click", () => {
    Promise.resolve(loadSessions()).catch((error) => {
      if (isUnauthorized(error)) return;
      setSessionsError("", "users.sessionsLoadFailed");
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
      showRetry("", "users.pageLoadFailed");
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

  const localeSlot = document.querySelector("#locale-select");
  localeError = document.querySelector("#locale-error");
  localeSelect = mountSelect({
    name: "locale",
    value: currentLocale(),
    ariaLabel: t("users.language"),
    options: [
      { value: "zh-CN", label: "简体中文" },
      { value: "en", label: "English" },
    ],
    onChange: (value) => {
      void saveLocale(value);
    },
  });
  if (localeSlot) localeSlot.append(localeSelect.root);
  paintFacts();

  const onLocale = () => {
    if (localeSelect) {
      localeSelect.value = currentLocale();
      localeSelect.root.querySelector(".select-toggle")?.setAttribute("aria-label", t("users.language"));
    }
    paintFacts();
    if (me) {
      paintTranslate();
      paintAccount();
      if (sessionsReady) renderSessions();
      paintGithub();
      if (passwordInput && passwordError) paintPassword(passwordError.hidden);
    }
    if (profileSubmit?.dataset.busy) profileSubmit.textContent = t("users.saving");
    if (passwordSubmit?.dataset.busy) passwordSubmit.textContent = t("users.saving");
  };
  document.addEventListener("smsinbox:locale", onLocale);

  boot(token).catch((error) => {
    if (token !== viewToken || isUnauthorized(error)) return;
    showRetry("", "users.pageLoadFailed");
  });

  return () => {
    if (viewToken === token) viewToken += 1;
    document.removeEventListener("smsinbox:locale", onLocale);
    cleanupTotp();
  };
}

async function saveLocale(next) {
  showRaw(localeError, "");
  try {
    const result = await api("/api/v1/me/preferences", {
      method: "PATCH",
      body: JSON.stringify({ locale: next }),
    });
    if (!result.response.ok) {
      if (localeSelect) localeSelect.value = currentLocale();
      const message = result.data.error || t("users.localeSaveFailed");
      if (result.data.error) showRaw(localeError, result.data.error);
      else showKeyed(localeError, "users.localeSaveFailed");
      toast(message, { tone: "danger" });
      return;
    }
    const saved = result.data.locale === "en" ? "en" : "zh-CN";
    me = { ...(me || { role: "admin" }), locale: saved };
    noteMe({ locale: saved });
    setLocale(saved);
    if (localeSelect) localeSelect.value = currentLocale();
    toast(t("users.localeSaved"));
  } catch (error) {
    if (isUnauthorized(error)) return;
    if (localeSelect) localeSelect.value = currentLocale();
    showKeyed(localeError, "users.localeSaveFailed");
    toast(t("users.localeSaveFailed"), { tone: "danger" });
  }
}

async function boot(token) {
  showNotice(pageError, "");
  hideRetry();
  const meResult = await ensureMe();
  if (token !== viewToken || meResult?.stale) return;
  const user = meResult.user || null;
  const denied = meResult.status === 403 || (meResult.ok && user?.role !== "admin");
  if (denied) {
    rememberFlash(t("users.adminRequired"));
    go("/", { replace: true });
    return;
  }
  if (!meResult.ok) {
    if (meResult.error) showRetry(meResult.error);
    else showRetry("", "users.accountLoadFailed");
    return;
  }
  me = await loadNav();
  if (token !== viewToken) return;
  paintAccount();
  paintTranslate();
  await Promise.all([loadSessions(), loadDeviceCount(), loadSystemInfo()]);
}

function hideRetry() {
  if (pageRetry) pageRetry.hidden = true;
}

function showRetry(message, key) {
  showRaw(pageError, "");
  if (pageRetry) pageRetry.hidden = false;
  const span = pageRetry?.querySelector("span");
  if (!span) return;
  if (key) {
    span.setAttribute("data-i18n", key);
    span.textContent = t(key);
  } else {
    span.removeAttribute("data-i18n");
    span.textContent = message || "";
  }
}

async function refreshPage() {
  const token = viewToken;
  showNotice(pageError, "");
  await Promise.all([
    loadSessions().catch((error) => {
      if (isUnauthorized(error)) return;
      setSessionsError("", "users.sessionsLoadFailed");
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

function paintFacts() {
  paintVersion();
  paintDevicesFact();
  if (!sessionsReady && factSessions) factSessions.textContent = t("common.loading");
}

function paintVersion() {
  if (!factVersion) return;
  if (versionState === "error") {
    factVersion.textContent = t("users.readFailed");
    return;
  }
  if (versionState !== "ready") {
    factVersion.textContent = t("common.loading");
    return;
  }
  const version = systemInfo && typeof systemInfo.version === "string" ? systemInfo.version.trim() : "";
  factVersion.textContent = version || t("users.unknown");
}

function paintDevicesFact() {
  if (!factDevices) return;
  if (devicesState === "error") {
    factDevices.textContent = t("users.readFailed");
    return;
  }
  if (devicesState !== "ready") {
    factDevices.textContent = t("common.loading");
    return;
  }
  factDevices.textContent = String(getDevices().length);
}

async function loadDeviceCount() {
  try {
    const result = await ensureDevices();
    if (!result?.ok) {
      devicesState = "error";
      paintDevicesFact();
      return;
    }
    devicesState = "ready";
    paintDevicesFact();
  } catch (error) {
    if (isUnauthorized(error)) return;
    devicesState = "error";
    paintDevicesFact();
  }
}

async function refreshDeviceCount(token) {
  try {
    const result = await refreshDevices();
    if (token !== viewToken) return;
    if (!result?.ok) {
      devicesState = "error";
      paintDevicesFact();
      return;
    }
    devicesState = "ready";
    paintDevicesFact();
  } catch (error) {
    if (isUnauthorized(error)) return;
    if (token !== viewToken) return;
    devicesState = "error";
    paintDevicesFact();
  }
}

async function loadSystemInfo() {
  try {
    const result = await api("/api/v1/system/info");
    if (!result.response.ok) {
      versionState = "error";
      paintVersion();
      paintGithub();
      return;
    }
    systemInfo = result.data;
    versionState = "ready";
    paintVersion();
    paintGithub();
  } catch (error) {
    if (isUnauthorized(error)) return;
    versionState = "error";
    paintVersion();
    paintGithub();
  }
}

function paintPassword(silent) {
  const value = passwordInput.value;
  const ok = value.length >= 8 && value.length <= 256;
  passwordStrength.dataset.score = String(passwordScore(value));
  passwordError.hidden = Boolean(silent) || ok;
  passwordError.textContent = ok ? "" : t("users.passwordLength");
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
  profileSubmit.dataset.busy = "1";
  profileSubmit.textContent = t("users.saving");
  try {
    const result = await api("/api/v1/auth/profile", {
      method: "POST",
      body: JSON.stringify({ username }),
    });
    if (!result.response.ok) {
      if (result.data.error) setProfileError(result.data.error);
      else setProfileError("", "users.saveUsernameFailed");
      return;
    }
    const saved = typeof result.data.profile_username === "string" ? result.data.profile_username : username;
    profileUsername.value = saved;
    me = { ...(me || { role: "admin" }), profile_username: saved };
    noteMe({ profile_username: saved });
    paintSidebarProfile(getMe());
    paintAvatarPreview();
    const messageKey = saved ? "users.usernameSaved" : "users.usernameCleared";
    setAccountStatus("", messageKey);
    toast(t(messageKey));
  } catch (error) {
    if (isUnauthorized(error)) return;
    setProfileError("", "users.saveUsernameRetry");
  } finally {
    profileSubmit.disabled = false;
    delete profileSubmit.dataset.busy;
    profileSubmit.textContent = t("users.saveUsername");
  }
}

function setProfileError(message, key) {
  if (key) showKeyed(profileError, key);
  else showRaw(profileError, message);
}

// ─── Custom avatar ───────────────────────────────────────────────────────────

function paintAvatarPreview() {
  if (!avatarPreview) return;
  const profileName =
    me && typeof me.profile_username === "string" ? me.profile_username.trim() : "";
  const name = profileName || (me && (me.username || me.name)) || t("nav.admin");
  paintSidebarAvatar(avatarPreview, name, profileName, me);
  if (avatarRemove) {
    avatarRemove.hidden = !(me && typeof me.avatar_data === "string" && me.avatar_data);
  }
}

function setAvatarError(message, key) {
  if (key) showKeyed(avatarError, key);
  else showRaw(avatarError, message);
}

const AVATAR_DATA_LIMIT = 400 * 1024;

function imageError(key) {
  const error = new Error(t(key));
  error.i18nKey = key;
  return error;
}

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
        image.onerror = () => reject(imageError("users.imageReadFailed"));
        image.src = url;
      });
    }
    const width = source.naturalWidth ?? source.width;
    const height = source.naturalHeight ?? source.height;
    const side = Math.min(width, height);
    if (!side) throw imageError("users.imageReadFailed");
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
    throw imageError("users.imageTooLarge");
  } finally {
    cleanup();
    if (source && typeof source.close === "function") source.close();
  }
}

async function uploadAvatar(file) {
  setAvatarError("");
  if (!file.type.startsWith("image/")) {
    setAvatarError("", "users.chooseImage");
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
      if (result.data.error) setAvatarError(result.data.error);
      else setAvatarError("", "users.avatarUploadFailed");
      return;
    }
    const saved = typeof result.data.avatar_data === "string" ? result.data.avatar_data : dataUrl;
    me = { ...(me || { role: "admin" }), avatar_data: saved };
    noteMe({ avatar_data: saved });
    paintAvatarPreview();
    paintSidebarProfile(getMe());
    setAccountStatus("", "users.avatarUpdated");
    toast(t("users.avatarUpdated"));
  } catch (error) {
    if (isUnauthorized(error)) return;
    if (error && error.i18nKey) setAvatarError("", error.i18nKey);
    else if (error instanceof Error && error.message) setAvatarError(error.message);
    else setAvatarError("", "users.avatarUploadRetry");
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
      if (result.data.error) setAvatarError(result.data.error);
      else setAvatarError("", "users.avatarRemoveFailed");
      return;
    }
    me = { ...(me || { role: "admin" }), avatar_data: null };
    noteMe({ avatar_data: null });
    paintAvatarPreview();
    paintSidebarProfile(getMe());
    toast(t("users.avatarRemoved"));
  } catch (error) {
    if (isUnauthorized(error)) return;
    setAvatarError("", "users.avatarRemoveRetry");
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
  if (state === "bound") toast(t("users.githubBound"));
  else toast(t("users.githubBindFailed"), { tone: "danger" });
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
    title: t("users.githubUnbindTitle"),
    text: t("users.githubUnbindText", { name: login }),
    confirmLabel: t("users.githubUnbind"),
    danger: true,
  });
  if (!confirmed) return;
  setGithubError("");
  setGithubStatus("");
  githubUnbind.disabled = true;
  try {
    const result = await api("/api/v1/auth/github/unbind", { method: "POST", body: "{}" });
    if (!result.response.ok) {
      const message = result.data.error || t("users.unbindFailed");
      if (result.data.error) setGithubError(result.data.error);
      else setGithubError("", "users.unbindFailed");
      toast(message, { tone: "danger" });
      return;
    }
    me = { ...(me || { role: "admin" }), github: null };
    noteMe({ github: null });
    paintGithub();
    paintAvatarPreview();
    paintSidebarProfile(getMe());
    setGithubStatus("", "users.githubUnbound");
    toast(t("users.githubUnbound"));
  } catch (error) {
    if (isUnauthorized(error)) return;
    setGithubError("", "users.githubUnbindRetry");
  } finally {
    githubUnbind.disabled = false;
  }
}

function setGithubError(message, key) {
  if (key) showKeyed(githubError, key);
  else showRaw(githubError, message);
}

function setGithubStatus(message, key) {
  if (key) showKeyed(githubStatus, key);
  else showRaw(githubStatus, message);
}

// ─── SMS translation preference ──────────────────────────────────────────────

// The initial state comes from the /me user object; toggling PATCHes the
// preference and only repaints on success, so a failed save keeps the
// switch exactly as it was.
function paintTranslate() {
  if (!translateState || !translateToggle) return;
  translateEnabled = Boolean(me && me.translate_enabled);
  const stateKey = translateEnabled ? "users.translateOnDetail" : "users.translateOffDetail";
  translateState.setAttribute("data-i18n", stateKey);
  translateState.textContent = t(stateKey);
  translateToggle.disabled = false;
  const toggleKey = translateEnabled ? "users.translateDisable" : "users.translateEnable";
  translateToggle.setAttribute("data-i18n", toggleKey);
  translateToggle.textContent = t(toggleKey);
  translateToggle.className = translateEnabled ? "secondary" : "primary";
}

async function toggleTranslate() {
  const next = !translateEnabled;
  translateToggle.disabled = true;
  showRaw(translateError, "");
  try {
    const result = await api("/api/v1/me/preferences", {
      method: "PATCH",
      body: JSON.stringify({ translate_enabled: next }),
    });
    if (!result.response.ok) {
      const message = result.data.error || t("users.translateSaveFailed");
      if (result.data.error) showRaw(translateError, result.data.error);
      else showKeyed(translateError, "users.translateSaveFailed");
      toast(message, { tone: "danger" });
      return;
    }
    translateEnabled =
      typeof result.data.translate_enabled === "boolean" ? result.data.translate_enabled : next;
    me = { ...(me || { role: "admin" }), translate_enabled: translateEnabled };
    noteMe({ translate_enabled: translateEnabled });
    paintTranslate();
    const messageKey = translateEnabled ? "users.translateEnabled" : "users.translateDisabled";
    toast(t(messageKey));
  } catch (error) {
    if (isUnauthorized(error)) return;
    showKeyed(translateError, "users.translateSaveRetry");
    toast(t("users.translateSaveRetry"), { tone: "danger" });
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
    setAccountError("", "auth.passwordRequired");
    passwordCurrent.focus();
    return;
  }
  if (currentPassword === passwordInput.value) {
    setAccountError("", "users.passwordSame");
    return;
  }
  passwordSubmit.disabled = true;
  passwordSubmit.dataset.busy = "1";
  passwordSubmit.textContent = t("users.saving");
  try {
    const result = await api("/api/v1/auth/password", {
      method: "POST",
      body: JSON.stringify({ current_password: currentPassword, password: passwordInput.value }),
      allowUnauthorized: true,
    });
    if (!result.response.ok) {
      if (result.data.error) setAccountError(result.data.error);
      else setAccountError("", "users.passwordChangeFailed");
      return;
    }
    passwordCurrent.value = "";
    passwordInput.value = "";
    passwordInput.type = "password";
    passwordStrength.dataset.score = "0";
    rememberFlash(t("users.passwordUpdated"));
    location.assign("/login.html");
  } catch (error) {
    if (isUnauthorized(error)) return;
    setAccountError("", "users.passwordChangeRetry");
  } finally {
    passwordSubmit.disabled = false;
    delete passwordSubmit.dataset.busy;
    passwordSubmit.textContent = t("users.savePassword");
  }
}

async function loadSessions() {
  const token = viewToken;
  const result = await api("/api/v1/auth/sessions");
  if (token !== viewToken) return;
  if (!result.response.ok) {
    if (result.data.error) setSessionsError(result.data.error);
    else setSessionsError("", "users.sessionsLoadFailed");
    return;
  }
  setSessionsError("");
  sessions = Array.isArray(result.data.sessions) ? result.data.sessions : [];
  sessionsReady = true;
  renderSessions();
}

function renderSessions() {
  sessionList.replaceChildren();
  factSessions.textContent = String(sessions.length);
  if (sessions.length === 0) {
    const empty = document.createElement("li");
    empty.className = "session-empty";
    empty.textContent = t("users.noSessions");
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
  label.textContent = session.current ? t("users.currentSession") : t("users.loginSession");
  title.append(label);
  if (session.current) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = t("users.currentBadge");
    title.append(badge);
  }

  const meta = document.createElement("p");
  meta.className = "subtle";
  const createdAt = Number(session.created_at);
  const expiresAt = Number(session.expires_at);
  const parts = [];
  if (Number.isFinite(createdAt) && createdAt > 0) {
    parts.push(t("users.signedInAt", { time: formatTime(createdAt) }));
  }
  if (Number.isFinite(expiresAt) && expiresAt > 0) {
    parts.push(t("users.expiresAt", { time: formatTime(expiresAt) }));
  }
  const agent = [session.browser, session.os, session.device]
    .filter((value) => typeof value === "string" && value)
    .join(" · ");
  if (agent) parts.push(agent);
  if (session.ip) parts.push(t("users.ip", { ip: session.ip }));
  if (!parts.length) parts.push(t("users.sessionTimeUnknown"));
  meta.textContent = parts.join(" · ");
  const detail = [];
  if (Number.isFinite(createdAt) && createdAt > 0) detail.push(t("users.signedInAbsolute", { time: absoluteTime(createdAt) }));
  if (Number.isFinite(expiresAt) && expiresAt > 0) detail.push(t("users.expiresAbsolute", { time: absoluteTime(expiresAt) }));
  if (detail.length) meta.title = detail.join("\n");
  main.append(title, meta);

  const action = document.createElement("button");
  action.type = "button";
  action.className = session.current ? "secondary" : "ghost";
  action.dataset.sessionId = session.id;
  action.textContent = session.current ? t("users.logoutThis") : t("users.revoke");
  action.setAttribute("aria-label", session.current ? t("users.logoutCurrentAria") : t("users.revokeThisAria"));

  row.append(main, action);
  return row;
}

async function revokeSession(session) {
  const confirmed = await openModal({
    title: session.current ? t("users.logoutCurrentTitle") : t("users.revokeThisTitle"),
    text: session.current ? t("users.logoutCurrentText") : t("users.revokeThisText"),
    confirmLabel: session.current ? t("users.logOut") : t("users.revoke"),
  });
  if (!confirmed) return;
  setSessionsError("");
  setSessionsStatus("");
  try {
    const result = await api(`/api/v1/auth/sessions/${session.id}`, { method: "DELETE" });
    if (!result.response.ok) {
      const message = result.data.error || t("users.revokeFailed");
      if (result.data.error) setSessionsError(result.data.error);
      else setSessionsError("", "users.revokeFailed");
      toast(message, { tone: "danger" });
      return;
    }
    if (session.current) {
      rememberFlash(t("users.currentRevoked"));
      location.assign("/login.html");
      return;
    }
    setSessionsStatus("", "users.sessionRevoked");
    toast(t("users.sessionRevoked"));
    await loadSessions();
  } catch (error) {
    if (isUnauthorized(error)) return;
    setSessionsError("", "users.revokeRetry");
  }
}

async function revokeOtherSessions() {
  const confirmed = await openModal({
    title: t("users.revokeOthersTitle"),
    text: t("users.revokeOthersText"),
    confirmLabel: t("users.revokeOthers"),
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
      const message = result.data.error || t("users.revokeOthersFailed");
      if (result.data.error) setSessionsError(result.data.error);
      else setSessionsError("", "users.revokeOthersFailed");
      toast(message, { tone: "danger" });
      return;
    }
    setSessionsStatus("", "users.othersRevoked");
    toast(t("users.othersRevoked"));
    await loadSessions();
  } catch (error) {
    if (isUnauthorized(error)) return;
    setSessionsError("", "users.revokeOthersRetry");
  } finally {
    revokeOthers.disabled = !sessions.some((session) => !session.current);
  }
}

function setAccountError(message, key) {
  if (key) showKeyed(accountError, key);
  else showRaw(accountError, message);
}

function setAccountStatus(message, key) {
  if (key) showKeyed(accountStatus, key);
  else showRaw(accountStatus, message);
}

function setSessionsError(message, key) {
  if (key) showKeyed(sessionsError, key);
  else showRaw(sessionsError, message);
}

function setSessionsStatus(message, key) {
  if (key) showKeyed(sessionsStatus, key);
  else showRaw(sessionsStatus, message);
}

registerView("/users.html", startView);
