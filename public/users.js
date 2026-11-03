import {
  absoluteTime,
  api,
  formatTime,
  generatePassword,
  initShell,
  isUnauthorized,
  loadNav,
  logout,
  openModal,
  passwordScore,
  showNotice,
  toast,
} from "./common.js";
import { ensureDevices, ensureMe, getDevices, refreshDevices } from "./device-store.js";
import { go, registerView } from "./shell.js";
import { initTotpSettings } from "./totp-settings.js";
import { rememberFlash } from "./ui.js";

let viewToken = 0;
let me = null;
let sessions = [];

let accountError;
let accountStatus;
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

  accountError = document.querySelector("#account-error");
  accountStatus = document.querySelector("#account-status");
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
  const cleanupSettingsNav = initSettingsNav();
  const cleanupMobileSettingsNav = initMobileSettingsNav();

  passwordForm.addEventListener("submit", submitPassword);
  passwordInput.addEventListener("input", () => paintPassword(true));
  document.querySelector("#generate-password").addEventListener("click", () => {
    passwordInput.value = generatePassword();
    passwordInput.type = "text";
    paintPassword(true);
    passwordInput.focus();
  });
  document.querySelector("#sessions-refresh").addEventListener("click", () => {
    Promise.resolve(loadSessions()).catch((error) => {
      if (isUnauthorized(error)) return;
      setSessionsError("加载会话失败");
    });
  });
  revokeOthers.addEventListener("click", revokeOtherSessions);
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

  boot(token).catch((error) => {
    if (token !== viewToken || isUnauthorized(error)) return;
    showRetry("加载系统管理信息失败");
  });

  return () => {
    if (viewToken === token) viewToken += 1;
    cleanupTotp();
    cleanupSettingsNav();
    cleanupMobileSettingsNav();
  };
}


function initMobileSettingsNav() {
  const settings = document.querySelector(".settings");
  const nav = document.querySelector(".settings-nav");
  const mobileHeader = document.querySelector(".settings-mobile-header");
  const backButton = document.querySelector("#settings-back");
  const sections = [...document.querySelectorAll(".settings-section")];
  if (!settings || !nav || !mobileHeader || !backButton || !sections.length) return () => {};

  const updateView = () => {
    const mobile = window.matchMedia("(max-width: 639px)").matches;
    const activeId = settings.dataset.mobileSection;
    if (!mobile) {
      nav.hidden = false;
      mobileHeader.hidden = true;
      for (const section of sections) {
        section.hidden = false;
        section.classList.remove("is-visible");
      }
      return;
    }

    if (!activeId) {
      nav.hidden = false;
      mobileHeader.hidden = true;
      for (const section of sections) {
        section.hidden = true;
        section.classList.remove("is-visible");
      }
      return;
    }

    nav.hidden = true;
    mobileHeader.hidden = false;
    const target = document.getElementById(activeId);
    const heading = target?.querySelector("h2");
    if (heading) mobileHeader.querySelector("h2").textContent = heading.textContent;
    for (const section of sections) {
      const visible = section.id === activeId;
      section.hidden = !visible;
      section.classList.toggle("is-visible", visible);
    }
  };

  for (const link of nav.querySelectorAll('a[href^="#"]')) {
    link.addEventListener("click", (event) => {
      if (!window.matchMedia("(max-width: 639px)").matches) return;
      event.preventDefault();
      const id = link.getAttribute("href")?.slice(1);
      if (!id) return;
      settings.dataset.mobileSection = id;
      updateView();
    });
  }

  backButton.addEventListener("click", () => {
    delete settings.dataset.mobileSection;
    updateView();
  });

  updateView();
  window.addEventListener("resize", updateView);
  return () => window.removeEventListener("resize", updateView);
}

function initSettingsNav() {
  if (window.matchMedia("(max-width: 639px)").matches) {
    return () => {};
  }
  const nav = document.querySelector(".settings-nav");
  if (!nav) return () => {};
  const links = [...nav.querySelectorAll('a[href^="#"]')];
  const sections = links
    .map((link) => document.querySelector(link.getAttribute("href") || ""))
    .filter((section) => section instanceof HTMLElement);
  if (!links.length) return () => {};
  const activate = (id) => {
    for (const link of links) {
      const active = link.getAttribute("href") === `#${id}`;
      link.classList.toggle("is-active", active);
      if (active) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    }
  };
  activate(sections[0]?.id || "");
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top);
      if (visible[0]) activate(visible[0].target.id);
    },
    { rootMargin: "-24% 0px -68% 0px", threshold: 0 },
  );
  for (const section of sections) observer.observe(section);
  return () => observer.disconnect();
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
  // No username is shown anywhere: there is exactly one administrator.
  if (!me) me = { role: "admin" };
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
      return;
    }
    const version = typeof result.data.version === "string" ? result.data.version.trim() : "";
    factVersion.textContent = version || "未知";
  } catch (error) {
    if (isUnauthorized(error)) return;
    factVersion.textContent = "读取失败";
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
