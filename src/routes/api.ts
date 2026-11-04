import { pickDesignatedUser } from "../admin-user";
import {
  bytesToBase64Url,
  hashPassword,
  requestIsSecure,
  secretsEqual,
  SESSION_COOKIE,
  sessionCookieHeader,
  sha256Hex,
  verifyPassword,
} from "../auth";
import { decryptString, ENCRYPTED_PREFIX, resolveContentKey, revealCode, sealMessage, sealString } from "../crypto";
import {
  accountPasswordLimited,
  clearAccountPasswordFailures,
  clearLoginFailures,
  countDevices,
  countNotifyChannels,
  deleteApiToken,
  deleteDevice,
  deleteNotifyChannel,
  deleteOtherUserSessions,
  deleteSession,
  deleteUserSessionById,
  deleteUserSessions,
  deleteUserTotpTickets,
  ensureAdmin,
  findDeviceForUser,
  findMessageByHash,
  findNotifyChannel,
  findOwnedDevice,
  findTotpUser,
  findUserRecordById,
  getMessage,
  getProfileUsername,
  insertApiToken,
  insertDevice,
  insertMessage,
  insertNotifyChannel,
  insertUser,
  isUniqueViolation,
  countPinnedDevices,
  createDeviceGroup,
  deleteDeviceGroup,
  isDevicePinned,
  listApiTokens,
  listDeviceGroups,
  renameApiToken,
  renameDeviceGroup,
  setDeviceGroup,
  setDevicePinned,
  listDevices,
  listMessages,
  listMessagesSince,
  listNotifyChannels,
  listUserRecords,
  listUserSessions,
  LOGIN_FAILURE_LIMIT,
  LOGIN_IP_FAILURE_LIMIT,
  loginAttemptCount,
  loginRateKey,
  loginRetryAfterSeconds,
  MAX_DEVICES,
  MAX_PINNED_DEVICES,
  mergeIntoAdmin,
  pushState,
  recordAccountPasswordFailure,
  recordLoginFailure,
  replaceDevicePushToken,
  revokeDevicePush,
  rotateApiToken,
  setNotifyChannelEnabled,
  setProfileUsername,
  touchDevice,
  updateDeviceName,
  updateApiTokenDisabled,
  updateApiTokenRevoked,
  updatePasswordHash,
} from "../db";
import { dedupHash } from "../dedup";
import { recognizeCode } from "../code-recognition";
import { clientAddress, isCrossSite, json, readCookie, readLimitedBytes, rejectsSensitiveWrite } from "../http";
import { errorText, logError, logInfo } from "../log";
import { issueSession, publicUser, requireSensitiveUser, requireUser } from "../session";
import {
  authMeExtras,
  deleteAvatar,
  githubCallback,
  githubConfig,
  githubStart,
  githubUnbind,
  uploadAvatar,
} from "./github";
import { parseUserAgent } from "../user-agent";
import {
  beginTotpSetup,
  disableTotp,
  enableTotpHandler,
  regenerateRecoveryCodes,
  startTotpChallenge,
  totpStatus,
  verifyTotpLogin,
} from "./totp";
import {
  channelFromRow,
  deliverChannels,
  MAX_NOTIFY_CHANNELS,
  notifyStoredSms,
  parseChannelInput,
  redactConfig,
  scheduleNotify,
} from "../notify";
import { newDeviceTokenId, resolveDeviceJwtSecret, signDeviceToken } from "../device-jwt";
import { buildRawPayload } from "../parse";
import { compileLikeQuery } from "../search";
import { buildShortcut, shortcutFilename, type ShortcutVariant } from "../shortcut";
import { buildTestSms } from "./sms";
import { openSmtpSocket } from "../smtp";
import { createInboxStream, resolveCursor, SSE_BATCH } from "../sse";
import type { UserRecord } from "../types";
import type { ApiTokenView } from "../types";
import { EXT_PERMISSIONS, type ExtPermission, tokenRecordToView } from "./ext-auth";
import { APP_VERSION } from "../version";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_ID_RE = /^[0-9a-f]{64}$/;

type WaitCtx = { waitUntil(promise: Promise<unknown>): void };

export async function handleApi(request: Request, env: Env, ctx: WaitCtx = { waitUntil() {} }): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") return new Response(null, { status: 204, headers: { allow: "GET, POST, DELETE" } });

  if (path === "/api/v1/auth/login") {
    if (method !== "POST") return methodNotAllowed("POST");
    return login(request, env);
  }
  if (path === "/api/v1/auth/logout") {
    if (method !== "POST") return methodNotAllowed("POST");
    return logout(request, env);
  }
  if (path === "/api/v1/auth/me") {
    if (method !== "GET") return methodNotAllowed("GET");
    return me(request, env);
  }
  if (path === "/api/v1/auth/profile") {
    if (method !== "POST") return methodNotAllowed("POST");
    return updateProfile(request, env);
  }
  if (path === "/api/v1/auth/config") {
    if (method !== "GET") return methodNotAllowed("GET");
    return githubConfig(env);
  }
  if (path === "/api/v1/auth/github/start") {
    if (method !== "GET") return methodNotAllowed("GET");
    return githubStart(request, env);
  }
  if (path === "/api/v1/auth/github/callback") {
    if (method !== "GET") return methodNotAllowed("GET");
    return githubCallback(request, env);
  }
  if (path === "/api/v1/auth/github/unbind") {
    if (method !== "POST") return methodNotAllowed("POST");
    return githubUnbind(request, env);
  }
  if (path === "/api/v1/auth/avatar") {
    if (method === "POST") return uploadAvatar(request, env);
    if (method === "DELETE") return deleteAvatar(request, env);
    return methodNotAllowed("POST, DELETE");
  }
  if (path === "/api/v1/auth/password") {
    if (method !== "POST") return methodNotAllowed("POST");
    return changePassword(request, env);
  }
  if (path === "/api/v1/auth/sessions") {
    if (method !== "GET") return methodNotAllowed("GET");
    return sessions(request, env);
  }
  if (path === "/api/v1/auth/sessions/revoke-others") {
    if (method !== "POST") return methodNotAllowed("POST");
    return revokeOtherSessions(request, env);
  }
  const sessionMatch = /^\/api\/v1\/auth\/sessions\/([^/]+)$/.exec(path);
  if (sessionMatch?.[1]) {
    if (method !== "DELETE") return methodNotAllowed("DELETE");
    return revokeSession(request, env, sessionMatch[1]);
  }
  if (path === "/api/v1/auth/totp") {
    if (method !== "GET") return methodNotAllowed("GET");
    return totpStatus(request, env);
  }
  if (path === "/api/v1/auth/totp/setup") {
    if (method !== "POST") return methodNotAllowed("POST");
    return beginTotpSetup(request, env);
  }
  if (path === "/api/v1/auth/totp/enable") {
    if (method !== "POST") return methodNotAllowed("POST");
    return enableTotpHandler(request, env);
  }
  if (path === "/api/v1/auth/totp/disable") {
    if (method !== "POST") return methodNotAllowed("POST");
    return disableTotp(request, env);
  }
  if (path === "/api/v1/auth/totp/recovery") {
    if (method !== "POST") return methodNotAllowed("POST");
    return regenerateRecoveryCodes(request, env);
  }
  if (path === "/api/v1/auth/totp/verify") {
    if (method !== "POST") return methodNotAllowed("POST");
    return verifyTotpLogin(request, env);
  }
  if (path === "/api/v1/events") {
    if (method !== "GET") return methodNotAllowed("GET");
    return events(request, env, url);
  }
  if (path === "/api/v1/messages") {
    if (method !== "GET") return methodNotAllowed("GET");
    return list(request, env, url);
  }
  const messageMatch = /^\/api\/v1\/messages\/([^/]+)$/.exec(path);
  if (messageMatch?.[1]) {
    if (method !== "GET") return methodNotAllowed("GET");
    return detail(request, env, messageMatch[1]);
  }
  if (path === "/api/v1/notifications") {
    if (method === "GET") return listNotifications(request, env);
    if (method === "POST") return createNotification(request, env);
    return methodNotAllowed("GET, POST");
  }
  const notifyTest = /^\/api\/v1\/notifications\/([^/]+)\/test$/.exec(path);
  if (notifyTest?.[1]) {
    if (method !== "POST") return methodNotAllowed("POST");
    return testNotification(request, env, notifyTest[1]);
  }
  const notifyItem = /^\/api\/v1\/notifications\/([^/]+)$/.exec(path);
  if (notifyItem?.[1]) {
    if (method === "DELETE") return removeNotification(request, env, notifyItem[1]);
    if (method === "POST") return setNotificationEnabled(request, env, notifyItem[1]);
    return methodNotAllowed("POST, DELETE");
  }
  if (path === "/api/v1/ios/shortcut") {
    if (method !== "GET") return methodNotAllowed("GET");
    return iosShortcut(request, env, url);
  }
  if (path === "/api/v1/devices") {
    if (method === "GET") return devices(request, env);
    if (method === "POST") return createDevice(request, env);
    return methodNotAllowed("GET, POST");
  }
  const deviceTest = /^\/api\/v1\/devices\/([^/]+)\/test$/.exec(path);
  if (deviceTest?.[1]) {
    if (method !== "POST") return methodNotAllowed("POST");
    return testDevice(request, env, ctx, deviceTest[1]);
  }
  const devicePush = /^\/api\/v1\/devices\/([^/]+)\/push$/.exec(path);
  if (devicePush?.[1]) {
    if (method !== "POST") return methodNotAllowed("POST");
    return updateDevicePush(request, env, devicePush[1]);
  }
  const devicePin = /^\/api\/v1\/devices\/([^/]+)\/(pin|unpin)$/.exec(path);
  if (devicePin?.[1]) {
    if (method !== "POST") return methodNotAllowed("POST");
    return setDevicePin(request, env, devicePin[1], devicePin[2] === "pin");
  }
  if (path === "/api/v1/device-groups") {
    if (method === "GET") return deviceGroups(request, env);
    if (method === "POST") return createDeviceGroupEndpoint(request, env);
    return methodNotAllowed("GET, POST");
  }
  const deviceGroupMatch = /^\/api\/v1\/device-groups\/([^/]+)$/.exec(path);
  if (deviceGroupMatch?.[1]) {
    if (method === "PATCH") return renameDeviceGroupEndpoint(request, env, deviceGroupMatch[1]);
    if (method !== "DELETE") return methodNotAllowed("DELETE, PATCH");
    return removeDeviceGroup(request, env, deviceGroupMatch[1]);
  }
  const deviceMatch = /^\/api\/v1\/devices\/([^/]+)$/.exec(path);
  if (deviceMatch?.[1]) {
    if (method === "PATCH") return renameDevice(request, env, deviceMatch[1]);
    if (method !== "DELETE") return methodNotAllowed("DELETE, PATCH");
    return removeDevice(request, env, deviceMatch[1]);
  }
  if (path === "/api/v1/api-tokens") {
    if (method === "GET") return apiTokens(request, env);
    if (method === "POST") return createApiToken(request, env);
    return methodNotAllowed("GET, POST");
  }
  const tokenDisableMatch = /^\/api\/v1\/api-tokens\/([^/]+)\/disable$/.exec(path);
  if (tokenDisableMatch?.[1]) {
    if (method !== "POST") return methodNotAllowed("POST");
    return disableApiTokenEndpoint(request, env, tokenDisableMatch[1]);
  }
  const tokenEnableMatch = /^\/api\/v1\/api-tokens\/([^/]+)\/enable$/.exec(path);
  if (tokenEnableMatch?.[1]) {
    if (method !== "POST") return methodNotAllowed("POST");
    return enableApiTokenEndpoint(request, env, tokenEnableMatch[1]);
  }
  const tokenRevokeMatch = /^\/api\/v1\/api-tokens\/([^/]+)\/revoke$/.exec(path);
  if (tokenRevokeMatch?.[1]) {
    if (method !== "POST") return methodNotAllowed("POST");
    return revokeApiTokenEndpoint(request, env, tokenRevokeMatch[1]);
  }
  const tokenRotateMatch = /^\/api\/v1\/api-tokens\/([^/]+)\/rotate$/.exec(path);
  if (tokenRotateMatch?.[1]) {
    if (method !== "POST") return methodNotAllowed("POST");
    return rotateApiTokenEndpoint(request, env, tokenRotateMatch[1]);
  }
  const tokenDeleteMatch = /^\/api\/v1\/api-tokens\/([^/]+)$/.exec(path);
  if (tokenDeleteMatch?.[1]) {
    if (method === "PATCH") return renameApiTokenEndpoint(request, env, tokenDeleteMatch[1]);
    if (method !== "DELETE") return methodNotAllowed("DELETE, PATCH");
    return deleteApiTokenEndpoint(request, env, tokenDeleteMatch[1]);
  }
  if (path === "/api/v1/system/info") {
    if (method !== "GET") return methodNotAllowed("GET");
    return systemInfo(request, env);
  }
  if (/^\/api\/v1\/users(\/|$)/.test(path)) {
    return json({ ok: false, error: "用户管理已关闭" }, 410);
  }
  return json({ ok: false, error: "未找到" }, 404);
}

async function login(request: Request, env: Env): Promise<Response> {
  if (isCrossSite(request)) return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  const body = await readJson(request);
  if (!body.ok) return body.response;
  // Username fields from older clients are intentionally ignored; there is
  // exactly one administrator and only the password decides the login.
  const password = readLoginPassword(body.value);
  if (password === null) return json({ ok: false, error: "请填写密码" }, 400);

  const now = Date.now();
  // The account key is stable even before the user row is resolved, so failed
  // passwords cannot reset the window by omitting or changing a username.
  const userKey = await loginRateKey("user", "admin");
  const ip = clientAddress(request);
  const ipKey = ip ? await loginRateKey("ip", ip) : null;
  if (await loginIsLimited(env, userKey, ipKey, now)) return loginLimited(now);

  const users = await listUserRecords(env.DB);
  const adminPassword = env.ADMIN_PASSWORD ?? "";
  const hasEnvPassword = adminPassword.length > 0;
  if (users.length === 0) {
    if (!hasEnvPassword) {
      return json({ ok: false, error: "尚未配置管理员密码。请设置 ADMIN_PASSWORD。" }, 503);
    }
    const envPasswordOk = await secretsEqual(password, adminPassword);
    if (!envPasswordOk) {
      await recordLoginFailure(env.DB, userKey, now);
      if (ipKey) await recordLoginFailure(env.DB, ipKey, now);
      return json({ ok: false, error: "密码错误" }, 401);
    }
    const created = await bootstrapAdmin(env, password);
    if (!created) return json({ ok: false, error: "无法创建管理员，请重试" }, 500);
    await finishLogin(env, created, { userKey, ipKey, now });
    return issueSessionFor(request, env, created);
  }

  // Only one row is the administrator. ADMIN_USERNAME is no longer a login
  // field; it survives as a read-only hint for selecting that row while
  // production databases still contain pre-merge rows.
  const designated = pickDesignatedUser(users, env.ADMIN_USERNAME?.trim() ?? "");
  if (!designated) {
    return json(
      {
        ok: false,
        error: "存在多个账号，无法确定管理员。请先只保留一个 users 行，或用 ADMIN_USERNAME 指向现有管理员。",
      },
      409,
    );
  }

  const rowPasswordOk = await verifyPassword(password, designated.password_hash);
  const envPasswordOk = hasEnvPassword && (await secretsEqual(password, adminPassword));
  if (!rowPasswordOk && !envPasswordOk) {
    await recordLoginFailure(env.DB, userKey, now);
    if (ipKey) await recordLoginFailure(env.DB, ipKey, now);
    // A password that belongs to another pre-merge row gets a clear refusal
    // instead of looking like a typo. Other rows never become a login path.
    const other = await findMatchingUser(users, password, designated.id);
    if (!other) return json({ ok: false, error: "密码错误" }, 401);
    return json(
      { ok: false, error: other.disabled_at != null ? "账号已停用" : "仅管理员可以登录" },
      401,
    );
  }

  let user = designated;
  if (envPasswordOk) {
    // ADMIN_PASSWORD stays a recovery path: a successful env-password login
    // writes that password back into the row so later UI changes win, and can
    // revive the surviving row if it was disabled or demoted.
    if (!rowPasswordOk) {
      const hash = await hashPassword(password);
      await updatePasswordHash(env.DB, user.id, hash);
      user = { ...user, password_hash: hash };
    }
    if (user.role !== "admin" || user.disabled_at != null) {
      await ensureAdmin(env.DB, user.id);
      user = { ...user, role: "admin", disabled_at: null };
    }
  } else if (user.disabled_at != null) {
    return json({ ok: false, error: "账号已停用" }, 401);
  } else if (user.role !== "admin") {
    return json({ ok: false, error: "仅管理员可以登录" }, 401);
  }

  await clearLoginFailures(env.DB, userKey, now);
  if (ipKey) await clearLoginFailures(env.DB, ipKey, now);

  await finishLogin(env, user, { userKey, ipKey, now });
  return issueSessionFor(request, env, user);
}

async function findMatchingUser(
  users: UserRecord[],
  password: string,
  designatedId: string,
): Promise<UserRecord | null> {
  for (const candidate of users) {
    if (candidate.id === designatedId) continue;
    if (await verifyPassword(password, candidate.password_hash)) return candidate;
  }
  return null;
}

async function bootstrapAdmin(env: Env, password: string): Promise<UserRecord | null> {
  const username = env.ADMIN_USERNAME?.trim() || "admin";
  const createdAt = Date.now();
  const user: UserRecord = {
    id: crypto.randomUUID(),
    username,
    password_hash: await hashPassword(password),
    role: "admin",
    disabled_at: null,
    created_at: createdAt,
  };
  try {
    await insertUser(env.DB, {
      id: user.id,
      username: user.username,
      passwordHash: user.password_hash,
      role: "admin",
      createdAt,
    });
    return user;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const again = await listUserRecords(env.DB);
    return pickDesignatedUser(again, username) ?? again[0] ?? null;
  }
}

async function finishLogin(
  env: Env,
  user: UserRecord,
  budget: { userKey: string; ipKey: string | null; now: number },
): Promise<void> {
  await clearLoginFailures(env.DB, budget.userKey, budget.now);
  if (budget.ipKey) await clearLoginFailures(env.DB, budget.ipKey, budget.now);
  // Claim any devices/channels still attached to stale user rows, then remove
  // those rows and sessions. Messages are never touched here.
  await mergeIntoAdmin(env.DB, user);
}

// Session issuance stays in one place so the bootstrap path and the normal
// path cannot drift apart (including the TOTP challenge).
async function issueSessionFor(request: Request, env: Env, user: UserRecord): Promise<Response> {
  const totp = await findTotpUser(env.DB, user.id);
  logInfo({ message: "login", user_id: user.id });
  if (totp?.totp_enabled_at != null && totp.totp_secret != null) {
    return startTotpChallenge(env, user);
  }
  return issueSession(request, env, { ...user, totp_enabled_at: totp?.totp_enabled_at ?? null });
}

async function logout(request: Request, env: Env): Promise<Response> {
  if (isCrossSite(request)) return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (token) await deleteSession(env.DB, await sha256Hex(token));
  const headers = new Headers();
  headers.set("set-cookie", sessionCookieHeader("", requestIsSecure(request), 0));
  return json({ ok: true }, 200, headers);
}

async function me(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const profileUsername = await getProfileUsername(env.DB);
  const extras = await authMeExtras(env.DB);
  return json({ ok: true, user: { ...publicUser(user), profile_username: profileUsername, ...extras } });
}

async function updateProfile(request: Request, env: Env): Promise<Response> {
  const user = await requireSensitiveUser(request, env);
  if (user instanceof Response) return user;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const parsed = readProfileUsername(body.value);
  if ("error" in parsed) return json({ ok: false, error: parsed.error }, 400);
  await setProfileUsername(env.DB, parsed.username);
  logInfo({ message: "profile_username_updated", user_id: user.id });
  return json({ ok: true, profile_username: parsed.username });
}

async function systemInfo(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  return json({ ok: true, version: APP_VERSION, runtime: "Cloudflare Workers + D1" });
}

async function changePassword(request: Request, env: Env): Promise<Response> {
  const user = await requireSensitiveUser(request, env);
  if (user instanceof Response) return user;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const parsed = readPasswordChange(body.value);
  if ("error" in parsed) return json({ ok: false, error: parsed.error }, 400);
  const check = await checkCurrentPassword(env, user.id, parsed.currentPassword);
  if (check.status !== "ok") return passwordCheckResponse(check.status);
  if (parsed.password === parsed.currentPassword) {
    return json({ ok: false, error: "新密码不能与当前密码相同" }, 400);
  }
  await updatePasswordHash(env.DB, user.id, await hashPassword(parsed.password));
  await deleteUserSessions(env.DB, user.id);
  await deleteUserTotpTickets(env.DB, user.id);
  logInfo({ message: "password_changed", user_id: user.id });
  const headers = new Headers();
  headers.set("set-cookie", sessionCookieHeader("", requestIsSecure(request), 0));
  return json({ ok: true }, 200, headers);
}

async function sessions(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const now = Date.now();
  const rows = await listUserSessions(env.DB, user.id, now);
  return json({
    ok: true,
    sessions: rows.map((row) => {
      const info = parseUserAgent(row.user_agent);
      return {
        id: row.id,
        created_at: row.created_at,
        expires_at: row.expires_at,
        current: row.id === user.session_id,
        browser: info.browser,
        os: info.os,
        device: info.device,
        ip: row.ip ?? null,
      };
    }),
  });
}

async function revokeOtherSessions(request: Request, env: Env): Promise<Response> {
  const user = await requireSensitiveUser(request, env);
  if (user instanceof Response) return user;
  const bytes = await readLimitedBytes(request, 8 * 1024);
  if (bytes === null) return json({ ok: false, error: "请求体过大" }, 413);
  await deleteOtherUserSessions(env.DB, user.id, user.session_id);
  logInfo({ message: "sessions_revoked", user_id: user.id });
  return json({ ok: true });
}

async function revokeSession(request: Request, env: Env, rawId: string): Promise<Response> {
  const user = await requireSensitiveUser(request, env);
  if (user instanceof Response) return user;
  const id = decodePart(rawId)?.toLowerCase() ?? "";
  if (!SESSION_ID_RE.test(id)) return json({ ok: false, error: "会话编号无效" }, 400);
  const removed = await deleteUserSessionById(env.DB, user.id, id);
  if (!removed) return json({ ok: false, error: "会话不存在" }, 404);
  logInfo({ message: "session_revoked", user_id: user.id });
  if (id !== user.session_id) return json({ ok: true });
  const headers = new Headers();
  headers.set("set-cookie", sessionCookieHeader("", requestIsSecure(request), 0));
  return json({ ok: true }, 200, headers);
}

async function events(request: Request, env: Env, url: URL): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const cursor = resolveCursor(request.headers.get("last-event-id"), url.searchParams.get("cursor"), Date.now());
  const stream = createInboxStream({
    cursor,
    signal: request.signal,
    poll: async (current) => {
      try {
        return await listMessagesSince(env.DB, {
          userId: user.id,
          createdAt: current.createdAt,
          id: current.id,
          limit: SSE_BATCH,
          contentKey: resolveContentKey(env.CONTENT_KEY),
        });
      } catch (error) {
        logError({
          message: "sse_poll_failed",
          user_id: user.id,
          error: errorText(error),
        });
        throw error;
      }
    },
  });
  return sseResponse(stream);
}

async function list(request: Request, env: Env, url: URL): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;

  const deviceId = url.searchParams.get("device_id")?.trim() ?? "";
  if (deviceId && !UUID_RE.test(deviceId)) return json({ ok: false, error: "设备编号无效" }, 400);
  const from = url.searchParams.get("from")?.trim() ?? "";
  if (from.length > 80) return json({ ok: false, error: "号码过长" }, 400);
  const sinceRaw = url.searchParams.get("since");
  let since: number | null = null;
  if (sinceRaw !== null) {
    const normalized = sinceRaw.trim();
    if (!/^\d+$/.test(normalized)) return json({ ok: false, error: "since 参数无效" }, 400);
    const parsed = Number(normalized);
    if (!Number.isSafeInteger(parsed) || parsed < 0) return json({ ok: false, error: "since 参数无效" }, 400);
    since = parsed;
  }
  const like = compileLikeQuery(url.searchParams.get("q"));
  if (!like.ok) return json({ ok: false, error: like.error }, 400);

  const page = boundedInt(url.searchParams.get("page"), 1, 500);
  const pageSize = boundedInt(url.searchParams.get("page_size"), 20, 50);
  const result = await listMessages(env.DB, {
    userId: user.id,
    deviceId: deviceId || null,
    from: from || null,
    since,
    like: like.pattern,
    text: like.pattern ? (url.searchParams.get("q")?.trim() ?? null) : null,
    limit: pageSize,
    offset: (page - 1) * pageSize,
    contentKey: resolveContentKey(env.CONTENT_KEY),
  });
  return json({
    ok: true,
    messages: result.messages,
    page,
    page_size: pageSize,
    total: result.total,
    search_truncated: result.searchTruncated,
  });
}

async function detail(request: Request, env: Env, rawId: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const id = decodePart(rawId);
  if (!id || !UUID_RE.test(id)) return json({ ok: false, error: "短信不存在" }, 404);
  const message = await getMessage(env.DB, user.id, id, resolveContentKey(env.CONTENT_KEY));
  if (!message) return json({ ok: false, error: "短信不存在" }, 404);
  return json({ ok: true, message });
}

// Stored secrets (device push tokens, API tokens) are kept so the owner
// can view them at any time: sealed with CONTENT_KEY when one is
// configured, as-is otherwise (the database is the owner's own; the hash
// remains the auth source).
async function sealSecret(env: Env, token: string): Promise<string> {
  const key = resolveContentKey(env.CONTENT_KEY);
  if (key.state === "on") return (await sealString(key, token)) ?? token;
  return token;
}

async function revealSecret(env: Env, stored: string | null | undefined): Promise<string | null> {
  if (!stored) return null;
  if (!stored.startsWith(ENCRYPTED_PREFIX)) return stored;
  const key = resolveContentKey(env.CONTENT_KEY);
  if (key.state !== "on") return null;
  return decryptString(key.raw, stored);
}

async function devices(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const origin = new URL(request.url).origin;
  const list = await listDevices(env.DB, user.id, resolveContentKey(env.CONTENT_KEY));
  for (const device of list) {
    if (device.push_url) device.push_url = `${origin}${device.push_url}`;
  }
  return json({ ok: true, devices: list });
}

async function createDevice(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const parsed = readDeviceBody(body.value);
  if ("error" in parsed) return json({ ok: false, error: parsed.error }, 400);
  if ((await countDevices(env.DB, user.id)) >= MAX_DEVICES) {
    return json({ ok: false, error: "设备数量已达上限" }, 400);
  }

  const secret = resolveDeviceJwtSecret(env);
  if (!secret) {
    return json(
      {
        ok: false,
        error: "设备认证尚未配置。请先设置 DEVICE_JWT_SECRET（至少 16 个字符），再添加设备。",
      },
      503,
    );
  }

  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const version = 0;
  const issued = await signDeviceToken({
    secret,
    deviceId: id,
    version,
    tokenId: newDeviceTokenId(),
    now: createdAt,
  });
  const pushToken = newPushToken();
  await insertDevice(env.DB, {
    id,
    userId: user.id,
    name: parsed.name,
    platform: parsed.platform,
    tokenHash: issued.tokenHash,
    tokenVersion: version,
    pushTokenHash: await sha256Hex(pushToken),
    pushSecretStored: await sealSecret(env, pushToken),
    createdAt,
  });
  logInfo({ message: "device_created", device_id: id, user_id: user.id, platform: parsed.platform, auth: "jwt" });
  return json({
    ok: true,
    // One-time credential. Per-device HMAC signing is gone; auth is the
    // system-signed JWT or the push link.
    token: issued.token,
    token_type: "Bearer",
    token_expires_at: issued.expiresAt,
    push_url: ingestUrl(request, pushToken),
    device: {
      id,
      name: parsed.name,
      platform: parsed.platform,
      created_at: createdAt,
      last_seen_at: null,
      pinned_at: null,
      group_id: null,
      push: "active" as const,
    },
  });
}

async function updateDevicePush(request: Request, env: Env, rawId: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const action = readPushAction(body.value);
  if (typeof action !== "string") return json({ ok: false, error: action.error }, 400);
  const id = decodePart(rawId);
  if (!id || !UUID_RE.test(id)) return json({ ok: false, error: "设备不存在" }, 404);
  const device = await findOwnedDevice(env.DB, user.id, id);
  if (!device) return json({ ok: false, error: "设备不存在" }, 404);
  const state = pushState(device.push_token_hash, device.push_revoked_at);

  if (action === "revoke") {
    if (state !== "active") {
      return json({ ok: false, error: state === "none" ? "还没有推送链接" : "推送链接已经撤销" }, 409);
    }
    const revoked = await revokeDevicePush(env.DB, user.id, id, Date.now());
    if (!revoked) return json({ ok: false, error: "推送链接已经撤销" }, 409);
    logInfo({ message: "device_push_revoked", device_id: id, user_id: user.id });
    return json({ ok: true, device: { id, push: "revoked" } });
  }

  if (action === "issue" && state === "active") {
    return json({ ok: false, error: "推送链接仍有效，请改用轮换" }, 409);
  }
  if (action === "rotate" && state === "none") {
    return json({ ok: false, error: "还没有推送链接" }, 409);
  }

  const pushToken = newPushToken();
  const updated = await replaceDevicePushToken(
    env.DB,
    user.id,
    id,
    await sha256Hex(pushToken),
    action,
    await sealSecret(env, pushToken),
  );
  if (!updated) return json({ ok: false, error: "推送链接状态已变化" }, 409);
  logInfo({ message: "device_push_issued", device_id: id, user_id: user.id, action });
  return json({
    ok: true,
    push_url: ingestUrl(request, pushToken),
    device: { id, push: "active" },
  });
}

function newPushToken(): string {
  // 32 lowercase hex characters (a hyphenless UUID, 128 bits of entropy):
  // no prefix and no base64url symbols — some devices/apps reject "_"/"-"
  // in the ingest URL (Roye, 2026-11-04). Legacy psh_ tokens keep working
  // until rotated; see PUSH_TOKEN_PATTERN in routes/sms.ts.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function ingestUrl(request: Request, pushToken: string): string {
  return `${new URL(request.url).origin}/api/v1/ingest/${pushToken}`;
}

function readPushAction(value: unknown): "issue" | "rotate" | "revoke" | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "请求体无效" };
  const action = (value as Record<string, unknown>).action;
  if (action === "issue" || action === "rotate" || action === "revoke") return action;
  return { error: "请指定 issue、rotate 或 revoke" };
}

async function listNotifications(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const channels = [];
  for (const row of await listNotifyChannels(env.DB, user.id)) {
    const channel = channelFromRow(row);
    if (!channel) continue;
    channels.push(presentChannel(channel));
  }
  return json({ ok: true, channels });
}

async function createNotification(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const parsed = parseChannelInput(body.value);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);
  if ((await countNotifyChannels(env.DB, user.id)) >= MAX_NOTIFY_CHANNELS) {
    return json({ ok: false, error: "推送渠道已达上限" }, 400);
  }
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  await insertNotifyChannel(env.DB, {
    id,
    userId: user.id,
    kind: parsed.kind,
    config: JSON.stringify(parsed.config),
    enabled: 1,
    createdAt,
  });
  logInfo({ message: "notify_channel_created", channel_id: id, user_id: user.id, kind: parsed.kind });
  return json({
    ok: true,
    channel: presentChannel({
      id,
      kind: parsed.kind,
      config: parsed.config,
      enabled: true,
      createdAt,
    }),
  });
}

async function removeNotification(request: Request, env: Env, rawId: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const id = decodePart(rawId);
  if (!id || !UUID_RE.test(id)) return json({ ok: false, error: "渠道不存在" }, 404);
  const removed = await deleteNotifyChannel(env.DB, user.id, id);
  if (!removed) return json({ ok: false, error: "渠道不存在" }, 404);
  logInfo({ message: "notify_channel_deleted", channel_id: id, user_id: user.id });
  return json({ ok: true });
}

async function setNotificationEnabled(request: Request, env: Env, rawId: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const id = decodePart(rawId);
  if (!id || !UUID_RE.test(id)) return json({ ok: false, error: "渠道不存在" }, 404);
  const body = await readJson(request);
  if (!body.ok) return body.response;
  if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) {
    return json({ ok: false, error: "请求体无效" }, 400);
  }
  const enabled = (body.value as Record<string, unknown>).enabled;
  if (typeof enabled !== "boolean") return json({ ok: false, error: "请指定是否启用" }, 400);
  const updated = await setNotifyChannelEnabled(env.DB, user.id, id, enabled);
  if (!updated) return json({ ok: false, error: "渠道不存在" }, 404);
  return json({ ok: true, enabled });
}

async function testNotification(request: Request, env: Env, rawId: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const id = decodePart(rawId);
  if (!id || !UUID_RE.test(id)) return json({ ok: false, error: "渠道不存在" }, 404);
  const row = await findNotifyChannel(env.DB, user.id, id);
  const channel = row ? channelFromRow(row) : null;
  if (!channel) return json({ ok: false, error: "渠道不存在" }, 404);
  const [result] = await deliverChannels(
    [channel],
    { title: "SMSinBox 测试", text: "这是一条测试通知，不包含短信内容。" },
    { fetch, openSmtp: openSmtpSocket },
  );
  if (!result?.ok) return json({ ok: false, error: result?.error || "发送失败" }, 502);
  return json({ ok: true });
}

function presentChannel(channel: {
  id: string;
  kind: Parameters<typeof redactConfig>[0];
  config: Parameters<typeof redactConfig>[1];
  enabled: boolean;
  createdAt: number;
}) {
  return {
    id: channel.id,
    kind: channel.kind,
    enabled: channel.enabled,
    created_at: channel.createdAt,
    config: redactConfig(channel.kind, channel.config),
  };
}

async function iosShortcut(request: Request, env: Env, url: URL): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const raw = url.searchParams.get("variant") ?? "all";
  if (raw !== "all" && raw !== "code") return json({ ok: false, error: "未知的快捷指令版本" }, 400);
  const variant: ShortcutVariant = raw;
  const filename = shortcutFilename(variant);
  const body = variant === "code" ? buildShortcut("code", `${url.origin}/api/v1/sms`) : buildShortcut("all");
  return new Response(body, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="${filename}"`,
      "content-type": "application/octet-stream",
      "x-content-type-options": "nosniff",
    },
  });
}

async function testDevice(request: Request, env: Env, ctx: WaitCtx, rawId: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const id = decodePart(rawId);
  if (!id || !UUID_RE.test(id)) return json({ ok: false, error: "设备不存在" }, 404);
  const device = await findDeviceForUser(env.DB, user.id, id);
  if (!device) return json({ ok: false, error: "设备不存在" }, 404);

  const contentKey = resolveContentKey(env.CONTENT_KEY);
  if (contentKey.state === "invalid") return json({ ok: false, error: "内容加密密钥无效" }, 500);

  const now = Date.now();
  const nonce = crypto.randomUUID().slice(0, 8);
  const content = buildTestSms(nonce);
  const from = "SMSinBox";
  const recognized = await recognizeCode(env, content);
  const code = recognized.code;
  const contentHash = await dedupHash({ deviceId: device.id, from, content, receivedAt: now });
  const sealed = await sealMessage(contentKey, {
    content,
    code,
    rawPayload: buildRawPayload(content, {
      from,
      to: "",
      content,
      deviceName: device.name,
      sim: "",
      receivedAt: now,
      receivedAtSource: "server",
    }),
  });
  if ("error" in sealed) return json({ ok: false, error: "内容加密密钥无效" }, 500);

  const messageId = crypto.randomUUID();
  try {
    await insertMessage(env.DB, {
      id: messageId,
      deviceId: device.id,
      from,
      to: "",
      content: sealed.content,
      contentHash,
      code: sealed.code,
      codeSource: recognized.source,
      rawPayload: sealed.rawPayload,
      receivedAt: now,
      createdAt: now,
      encrypted: sealed.encrypted,
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing = await findMessageByHash(env.DB, contentHash);
    if (!existing) throw error;
    const revealed = await revealCode(contentKey, existing.code, existing.encrypted === 1);
    await touchDevice(env.DB, device.id, now);
    return json({ ok: true, id: existing.id, code: revealed, duplicate: true });
  }

  await touchDevice(env.DB, device.id, now);
  logInfo({
    message: "sms_test_stored",
    device_id: device.id,
    message_id: messageId,
    has_code: code !== null,
    code_source: recognized.source,
  });
  scheduleNotify(ctx, () =>
    notifyStoredSms(env, user.id, {
      from,
      content,
      code,
      deviceName: device.name,
      receivedAt: now,
    }),
  );
  return json({ ok: true, id: messageId, code });
}

async function renameDevice(request: Request, env: Env, rawId: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const id = decodePart(rawId);
  if (!id || !UUID_RE.test(id)) return json({ ok: false, error: "设备不存在" }, 404);
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const record =
    body.value && typeof body.value === "object" && !Array.isArray(body.value)
      ? (body.value as Record<string, unknown>)
      : {};
  // The same PATCH carries the rename and/or the group assignment; at
  // least one of the two must be present.
  const hasName = "name" in record;
  const hasGroup = "group_id" in record;
  if (!hasName && !hasGroup) return json({ ok: false, error: "没有要更新的内容" }, 400);
  let name: string | undefined;
  if (hasName) {
    name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) {
      return json({ ok: false, error: "设备名称需要 1 到 64 个字符" }, 400);
    }
    const renamed = await updateDeviceName(env.DB, user.id, id, name);
    if (!renamed) return json({ ok: false, error: "设备不存在" }, 404);
    logInfo({ message: "device_renamed", device_id: id, user_id: user.id });
  }
  let groupId: string | null | undefined;
  if (hasGroup) {
    const rawGroup = record.group_id;
    if (rawGroup !== null && typeof rawGroup !== "string") {
      return json({ ok: false, error: "分组无效" }, 400);
    }
    groupId = rawGroup === null ? null : decodePart(rawGroup);
    if (groupId !== null && !UUID_RE.test(groupId)) {
      return json({ ok: false, error: "分组无效" }, 400);
    }
    const grouped = await setDeviceGroup(env.DB, user.id, id, groupId);
    if (!grouped) return json({ ok: false, error: "设备或分组不存在" }, 404);
    logInfo({ message: "device_group_set", device_id: id, user_id: user.id, group_id: groupId });
  }
  return json({ ok: true, id, ...(name !== undefined ? { name } : {}), ...(groupId !== undefined ? { group_id: groupId } : {}) });
}

async function setDevicePin(request: Request, env: Env, rawId: string, pin: boolean): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const id = decodePart(rawId);
  if (!id || !UUID_RE.test(id)) return json({ ok: false, error: "设备不存在" }, 404);
  if (pin) {
    const already = await isDevicePinned(env.DB, user.id, id);
    if (!already) {
      const owned = await findOwnedDevice(env.DB, user.id, id);
      if (!owned) return json({ ok: false, error: "设备不存在" }, 404);
      const count = await countPinnedDevices(env.DB, user.id);
      if (count >= MAX_PINNED_DEVICES) {
        return json({ ok: false, error: `侧边栏最多置顶 ${MAX_PINNED_DEVICES} 台设备` }, 400);
      }
    }
  }
  const updated = await setDevicePinned(env.DB, user.id, id, pin ? Date.now() : null);
  if (!updated) return json({ ok: false, error: "设备不存在" }, 404);
  logInfo({ message: pin ? "device_pinned" : "device_unpinned", device_id: id, user_id: user.id });
  return json({ ok: true, id, pinned: pin });
}

async function deviceGroups(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const groups = await listDeviceGroups(env.DB, user.id);
  return json({ ok: true, groups });
}

function readGroupName(value: unknown): string | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "请求体无效" };
  const raw = (value as Record<string, unknown>).name;
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name || name.length > 32 || /[\u0000-\u001f\u007f]/.test(name)) {
    return { error: "分组名称需要 1 到 32 个字符" };
  }
  return name;
}

async function createDeviceGroupEndpoint(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const parsed = readGroupName(body.value);
  if (typeof parsed !== "string") return json({ ok: false, error: parsed.error }, 400);
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  await createDeviceGroup(env.DB, { id, userId: user.id, name: parsed, createdAt });
  logInfo({ message: "device_group_created", group_id: id, user_id: user.id });
  return json({ ok: true, group: { id, name: parsed, created_at: createdAt, device_count: 0 } });
}

async function renameDeviceGroupEndpoint(request: Request, env: Env, rawId: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const id = decodePart(rawId);
  if (!id || !UUID_RE.test(id)) return json({ ok: false, error: "分组不存在" }, 404);
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const parsed = readGroupName(body.value);
  if (typeof parsed !== "string") return json({ ok: false, error: parsed.error }, 400);
  const renamed = await renameDeviceGroup(env.DB, user.id, id, parsed);
  if (!renamed) return json({ ok: false, error: "分组不存在" }, 404);
  logInfo({ message: "device_group_renamed", group_id: id, user_id: user.id });
  return json({ ok: true, id, name: parsed });
}

async function removeDeviceGroup(request: Request, env: Env, rawId: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const id = decodePart(rawId);
  if (!id || !UUID_RE.test(id)) return json({ ok: false, error: "分组不存在" }, 404);
  const removed = await deleteDeviceGroup(env.DB, user.id, id);
  if (!removed) return json({ ok: false, error: "分组不存在" }, 404);
  logInfo({ message: "device_group_deleted", group_id: id, user_id: user.id });
  return json({ ok: true, id });
}

async function removeDevice(request: Request, env: Env, rawId: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const id = decodePart(rawId);
  if (!id || !UUID_RE.test(id)) return json({ ok: false, error: "设备不存在" }, 404);
  const removed = await deleteDevice(env.DB, user.id, id);
  if (!removed) return json({ ok: false, error: "设备不存在" }, 404);
  logInfo({ message: "device_deleted", device_id: id, user_id: user.id });
  return json({ ok: true });
}

type PasswordCheck = "ok" | "bad" | "limited" | "missing";

async function loginIsLimited(env: Env, userKey: string, ipKey: string | null, now: number): Promise<boolean> {
  if ((await loginAttemptCount(env.DB, userKey, now)) >= LOGIN_FAILURE_LIMIT) return true;
  if (!ipKey) return false;
  return (await loginAttemptCount(env.DB, ipKey, now)) >= LOGIN_IP_FAILURE_LIMIT;
}

function loginLimited(now: number): Response {
  return json({ ok: false, error: "登录尝试过多，请稍后再试" }, 429, {
    "retry-after": String(loginRetryAfterSeconds(now)),
  });
}

async function checkCurrentPassword(env: Env, userId: string, password: string): Promise<
  { status: "ok"; user: UserRecord } | { status: Exclude<PasswordCheck, "ok"> }
> {
  const now = Date.now();
  if (await accountPasswordLimited(env.DB, userId, now)) return { status: "limited" };
  const record = await findUserRecordById(env.DB, userId);
  if (!record) return { status: "missing" };
  if (!(await verifyPassword(password, record.password_hash))) {
    await recordAccountPasswordFailure(env.DB, userId, now);
    return { status: "bad" };
  }
  await clearAccountPasswordFailures(env.DB, userId, now);
  return { status: "ok", user: record };
}

function passwordCheckResponse(status: Exclude<PasswordCheck, "ok">): Response {
  if (status === "limited") {
    return json({ ok: false, error: "尝试过多，请稍后再试" }, 429, {
      "retry-after": String(loginRetryAfterSeconds(Date.now())),
    });
  }
  if (status === "missing") return json({ ok: false, error: "未登录" }, 401);
  return json({ ok: false, error: "当前密码不正确" }, 401);
}

async function readJson(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const bytes = await readLimitedBytes(request, 8 * 1024);
  if (bytes === null) return { ok: false, response: json({ ok: false, error: "请求体过大" }, 413) };
  if (bytes.byteLength === 0) return { ok: false, response: json({ ok: false, error: "请求体为空" }, 400) };
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  } catch {
    return { ok: false, response: json({ ok: false, error: "JSON 无法解析" }, 400) };
  }
}

function readLoginPassword(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const password = (value as Record<string, unknown>).password;
  if (typeof password !== "string") return null;
  if (password.length === 0 || password.length > 256) return null;
  return password;
}

function readCurrentPassword(record: Record<string, unknown>): string | { error: string } {
  if (typeof record.current_password !== "string" || record.current_password.length === 0) {
    return { error: "请填写当前密码" };
  }
  if (record.current_password.length > 256) return { error: "当前密码需要 1 到 256 个字符" };
  return record.current_password;
}

function readPasswordChange(value: unknown): { currentPassword: string; password: string } | { error: string } {
  if (!value || typeof value !== "object") return { error: "请求体无效" };
  const record = value as Record<string, unknown>;
  const currentPassword = readCurrentPassword(record);
  if (typeof currentPassword !== "string") return currentPassword;
  if (typeof record.password !== "string" || record.password.length === 0) {
    return { error: "请填写新密码" };
  }
  if (record.password.length < 8 || record.password.length > 256) {
    return { error: "新密码需要 8 到 256 个字符" };
  }
  return { currentPassword, password: record.password };
}

// The profile username is a display nickname only; it never takes part
// in login. The sidebar avatar resolves it in layers — a GitHub photo
// when the name happens to be a GitHub handle, a generated avatar for
// any other name — so no GitHub syntax is imposed here.
function readProfileUsername(value: unknown): { username: string } | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "请求体无效" };
  const raw = (value as Record<string, unknown>).username;
  if (typeof raw !== "string") return { error: "请填写用户名" };
  const username = raw.trim();
  if (username === "") return { username: "" };
  if (username.length > 39 || /[\u0000-\u001f\u007f]/.test(username)) {
    return { error: "用户名需为 1 到 39 个字符" };
  }
  return { username };
}

const PLATFORMS = new Set(["ios", "android", "other"]);

function readDeviceBody(value: unknown): { name: string; platform: string } | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "请求体无效" };
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string") return { error: "请填写设备名称" };
  const name = record.name.trim();
  if (!name || name.length > 64 || /[\u0000-\u001f]/.test(name)) return { error: "设备名称需要 1 到 64 个字符" };
  return { name, platform: readPlatform(record.platform) };
}

function readPlatform(value: unknown): string {
  if (value === undefined || value === null) return "other";
  if (typeof value !== "string") return "other";
  const normalized = value.trim().toLowerCase();
  if (!normalized) return "other";
  if (normalized === "iphone" || normalized === "ipad" || normalized === "apple") return "ios";
  if (PLATFORMS.has(normalized)) return normalized;
  return /^[a-z0-9_-]{1,16}$/.test(normalized) ? normalized : "other";
}

function boundedInt(value: string | null, fallback: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function decodePart(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function methodNotAllowed(allow: string): Response {
  return json({ ok: false, error: "方法不允许" }, 405, { allow });
}

function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  const headers = new Headers();
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-cache, no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-accel-buffering", "no");
  headers.set("referrer-policy", "same-origin");
  headers.set("cross-origin-resource-policy", "same-origin");
  return new Response(stream, { status: 200, headers });
}

// ─── API Tokens (Admin) ──────────────────────────────────────────────────────

async function apiTokens(request: Request, env: Env): Promise<Response> {
  const auth = await requireUser(request, env);
  if (auth instanceof Response) return auth;
  const rows = await listApiTokens(env.DB, auth.id);
  const tokens = await Promise.all(
    rows.map(async (row) => {
      const view = tokenRecordToView(row);
      // The owner's list shows the full token (0013); revoked tokens had
      // their stored copy cleared at revoke time.
      if (row.revoked_at == null) view.token = await revealSecret(env, row.token_enc);
      return view;
    }),
  );
  return json({ ok: true, tokens });
}

async function createApiToken(request: Request, env: Env): Promise<Response> {
  if (rejectsSensitiveWrite(request)) return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  const auth = await requireUser(request, env);
  if (auth instanceof Response) return auth;
  const body = await readJson(request);
  if (!body.ok) return body.response;

  const input = body.value as Record<string, unknown>;
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 80 || /[\u0000-\u001f]/.test(name)) {
    return json({ ok: false, error: "请填写 1 到 80 个字符的 Token 名称" }, 400);
  }

  // Parse permissions
  const rawPerms = Array.isArray(input?.permissions) ? input.permissions : [];
  const permissions = rawPerms.filter((p): p is ExtPermission =>
    typeof p === "string" && (EXT_PERMISSIONS as readonly string[]).includes(p),
  );
  if (permissions.length === 0) {
    return json({ ok: false, error: "请至少选择一项有效权限" }, 400);
  }

  // Parse device_scope (empty array = all devices)
  let deviceScope: string[] = [];
  if (Array.isArray(input?.device_scope)) {
    deviceScope = input.device_scope.filter((d): d is string => typeof d === "string" && d.trim().length > 0);
  }

  // Parse expiry: support expires_in_days (number) or expires_at (timestamp)
  let expiresAt: number | null = null;
  if (typeof input?.expires_in_days === "number" && input.expires_in_days > 0) {
    expiresAt = Date.now() + Math.floor(input.expires_in_days * 24 * 60 * 60 * 1000);
  } else if (typeof input?.expires_at === "number" && input.expires_at > Date.now()) {
    expiresAt = Math.floor(input.expires_at);
  }

  // Generate random token with smsx_ prefix
  const randomBytes = crypto.getRandomValues(new Uint8Array(24));
  const plaintext = `smsx_${bytesToBase64Url(randomBytes)}`;
  const tokenPrefix = `${plaintext.slice(0, 10)}...`;
  const tokenHash = await sha256Hex(plaintext);
  const id = crypto.randomUUID();
  const createdAt = Date.now();

  await insertApiToken(env.DB, {
    id,
    userId: auth.id,
    name,
    tokenHash,
    tokenPrefix,
    tokenEnc: await sealSecret(env, plaintext),
    permissions: JSON.stringify(permissions),
    deviceScope: JSON.stringify(deviceScope),
    expiresAt,
    createdAt,
  });

  logInfo({
    message: "api_token_created",
    token_id: id,
    user_id: auth.id,
    name,
  });

  const record: ApiTokenView = {
    id,
    name,
    token_prefix: tokenPrefix,
    token: plaintext,
    permissions,
    device_scope: deviceScope,
    expires_at: expiresAt,
    disabled_at: null,
    revoked_at: null,
    created_at: createdAt,
    last_used_at: null,
    status: "active",
  };

  return json({ ok: true, token: plaintext, record });
}

async function disableApiTokenEndpoint(request: Request, env: Env, id: string): Promise<Response> {
  if (rejectsSensitiveWrite(request)) return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  const auth = await requireUser(request, env);
  if (auth instanceof Response) return auth;
  const updated = await updateApiTokenDisabled(env.DB, auth.id, id, Date.now());
  if (!updated) return json({ ok: false, error: "未找到 Token" }, 404);
  logInfo({ message: "api_token_disabled", token_id: id, user_id: auth.id });
  return json({ ok: true });
}

async function enableApiTokenEndpoint(request: Request, env: Env, id: string): Promise<Response> {
  if (rejectsSensitiveWrite(request)) return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  const auth = await requireUser(request, env);
  if (auth instanceof Response) return auth;
  const updated = await updateApiTokenDisabled(env.DB, auth.id, id, null);
  if (!updated) return json({ ok: false, error: "未找到 Token" }, 404);
  logInfo({ message: "api_token_enabled", token_id: id, user_id: auth.id });
  return json({ ok: true });
}

async function revokeApiTokenEndpoint(request: Request, env: Env, id: string): Promise<Response> {
  if (rejectsSensitiveWrite(request)) return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  const auth = await requireUser(request, env);
  if (auth instanceof Response) return auth;
  const updated = await updateApiTokenRevoked(env.DB, auth.id, id, Date.now());
  if (!updated) return json({ ok: false, error: "未找到 Token" }, 404);
  logInfo({ message: "api_token_revoked", token_id: id, user_id: auth.id });
  return json({ ok: true });
}

// Rotation supersedes revocation in the UI (Roye, 2026-11-04): the token
// row keeps its identity and permissions, only the secret is replaced.
async function rotateApiTokenEndpoint(request: Request, env: Env, id: string): Promise<Response> {
  if (rejectsSensitiveWrite(request)) return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  const auth = await requireUser(request, env);
  if (auth instanceof Response) return auth;
  const randomBytes = crypto.getRandomValues(new Uint8Array(24));
  const plaintext = `smsx_${bytesToBase64Url(randomBytes)}`;
  const tokenPrefix = `${plaintext.slice(0, 10)}...`;
  const updated = await rotateApiToken(env.DB, auth.id, id, {
    tokenHash: await sha256Hex(plaintext),
    tokenPrefix,
    tokenEnc: await sealSecret(env, plaintext),
  });
  if (!updated) return json({ ok: false, error: "未找到 Token" }, 404);
  logInfo({ message: "api_token_rotated", token_id: id, user_id: auth.id });
  return json({ ok: true, token: plaintext });
}

async function deleteApiTokenEndpoint(request: Request, env: Env, id: string): Promise<Response> {
  if (rejectsSensitiveWrite(request)) return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  const auth = await requireUser(request, env);
  if (auth instanceof Response) return auth;
  const deleted = await deleteApiToken(env.DB, auth.id, id);
  if (!deleted) return json({ ok: false, error: "未找到 Token" }, 404);
  logInfo({ message: "api_token_deleted", token_id: id, user_id: auth.id });
  return json({ ok: true });
}

async function renameApiTokenEndpoint(request: Request, env: Env, rawId: string): Promise<Response> {
  if (rejectsSensitiveWrite(request)) return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  const auth = await requireUser(request, env);
  if (auth instanceof Response) return auth;
  const id = decodePart(rawId);
  if (!id || !UUID_RE.test(id)) return json({ ok: false, error: "未找到 Token" }, 404);
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const raw = (body.value as { name?: unknown } | null)?.name;
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) {
    return json({ ok: false, error: "Token 名称需要 1 到 64 个字符" }, 400);
  }
  const updated = await renameApiToken(env.DB, auth.id, id, name);
  if (!updated) return json({ ok: false, error: "未找到 Token" }, 404);
  logInfo({ message: "api_token_renamed", token_id: id, user_id: auth.id });
  return json({ ok: true, id, name });
}

