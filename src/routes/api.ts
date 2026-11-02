import {
  bytesToBase64Url,
  hashPassword,
  randomToken,
  requestIsSecure,
  secretsEqual,
  SESSION_COOKIE,
  sessionCookieHeader,
  sha256Hex,
  verifyPassword,
} from "../auth";
import { resolveContentKey, revealCode, sealMessage } from "../crypto";
import {
  accountPasswordLimited,
  clearAccountPasswordFailures,
  clearLoginFailures,
  countDevices,
  countNotifyChannels,
  countUsers,
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
  findUserByUsername,
  findUserRecordById,
  getMessage,
  insertDevice,
  insertMessage,
  insertNotifyChannel,
  insertUser,
  isUniqueViolation,
  listDevices,
  listMessages,
  listMessagesSince,
  listNotifyChannels,
  listUserSessions,
  LOGIN_FAILURE_LIMIT,
  LOGIN_IP_FAILURE_LIMIT,
  loginAttemptCount,
  loginRateKey,
  loginRetryAfterSeconds,
  MAX_DEVICES,
  mergeIntoAdmin,
  pushState,
  recordAccountPasswordFailure,
  recordLoginFailure,
  replaceDevicePushToken,
  revokeDevicePush,
  setNotifyChannelEnabled,
  touchDevice,
  updatePasswordHash,
  updateUsername,
} from "../db";
import { dedupHash } from "../dedup";
import { extractCode } from "../extract";
import { clientAddress, isCrossSite, json, readCookie, readLimitedBytes, rejectsSensitiveWrite } from "../http";
import { errorText, logError, logInfo } from "../log";
import { issueSession, publicUser, requireUser } from "../session";
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
import { buildRawPayload } from "../parse";
import { compileLikeQuery } from "../search";
import { buildShortcut, shortcutFilename, type ShortcutVariant } from "../shortcut";
import { buildTestSms } from "./sms";
import { openSmtpSocket } from "../smtp";
import { createInboxStream, resolveCursor, SSE_BATCH } from "../sse";
import type { UserRecord } from "../types";
import { APP_VERSION } from "../version";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
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
  if (path === "/api/v1/auth/username") {
    if (method !== "POST") return methodNotAllowed("POST");
    return changeUsername(request, env);
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
  const deviceMatch = /^\/api\/v1\/devices\/([^/]+)$/.exec(path);
  if (deviceMatch?.[1]) {
    if (method !== "DELETE") return methodNotAllowed("DELETE");
    return removeDevice(request, env, deviceMatch[1]);
  }
  if (path === "/api/v1/system/info") {
    if (method !== "GET") return methodNotAllowed("GET");
    return systemInfo(request, env);
  }
  if (path === "/api/v1/users" || /^\/api\/v1\/users\/[^/]+$/.test(path)) {
    return json({ ok: false, error: "用户管理已关闭" }, 410);
  }
  return json({ ok: false, error: "未找到" }, 404);
}

async function login(request: Request, env: Env): Promise<Response> {
  if (isCrossSite(request)) return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const credentials = readCredentials(body.value);
  if (!credentials) return json({ ok: false, error: "请填写用户名和密码" }, 400);

  const adminUsername = env.ADMIN_USERNAME?.trim() ?? "";
  const adminPassword = env.ADMIN_PASSWORD ?? "";
  if (!adminUsername || !adminPassword) {
    if ((await countUsers(env.DB)) === 0) {
      return json(
        { ok: false, error: "尚未配置管理员账号。请设置 ADMIN_USERNAME 和 ADMIN_PASSWORD。" },
        503,
      );
    }
  }

  const now = Date.now();
  const userKey = await loginRateKey("user", credentials.username);
  const ip = clientAddress(request);
  const ipKey = ip ? await loginRateKey("ip", ip) : null;
  if (await loginIsLimited(env, userKey, ipKey, now)) return loginLimited(now);

  const existing = await findUserByUsername(env.DB, credentials.username);
  const passwordOk = await verifyPassword(credentials.password, existing?.password_hash ?? "");
  const adminOk =
    adminUsername.length > 0 &&
    adminPassword.length > 0 &&
    credentials.username === adminUsername &&
    (await secretsEqual(credentials.password, adminPassword));
  if (!passwordOk && !adminOk) {
    await recordLoginFailure(env.DB, userKey, now);
    if (ipKey) await recordLoginFailure(env.DB, ipKey, now);
    return json({ ok: false, error: "用户名或密码错误" }, 401);
  }

  let user = existing;
  if (adminOk && !user) {
    if ((await countUsers(env.DB)) > 0) {
      return json(
        { ok: false, error: "已有账号，不会再创建管理员。请把 ADMIN_USERNAME 设成现有管理员的用户名。" },
        409,
      );
    }
    const createdAt = Date.now();
    const id = crypto.randomUUID();
    try {
      await insertUser(env.DB, {
        id,
        username: adminUsername,
        passwordHash: await hashPassword(credentials.password),
        role: "admin",
        createdAt,
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    user = await findUserByUsername(env.DB, adminUsername);
  } else if (adminOk && user) {
    if (!passwordOk) await updatePasswordHash(env.DB, user.id, await hashPassword(credentials.password));
    if (user.role !== "admin" || user.disabled_at != null) {
      await ensureAdmin(env.DB, user.id);
      user = await findUserByUsername(env.DB, adminUsername);
    }
  }
  if (!user) return json({ ok: false, error: "用户名或密码错误" }, 401);
  if (user.disabled_at != null) return json({ ok: false, error: "账号已停用" }, 401);
  if (user.role !== "admin") return json({ ok: false, error: "仅管理员可以登录" }, 401);
  if (adminUsername && user.username !== adminUsername) {
    const designated = await findUserByUsername(env.DB, adminUsername);
    if (designated) return json({ ok: false, error: "仅管理员可以登录" }, 401);
  } else if (adminUsername && user.username === adminUsername) {
    await mergeIntoAdmin(env.DB, user);
  }

  await clearLoginFailures(env.DB, userKey, now);
  if (ipKey) await clearLoginFailures(env.DB, ipKey, now);

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
  return json({ ok: true, user: publicUser(user) });
}

async function systemInfo(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  return json({ ok: true, version: APP_VERSION, runtime: "Cloudflare Workers + D1" });
}

async function changeUsername(request: Request, env: Env): Promise<Response> {
  const user = await requireSensitiveUser(request, env);
  if (user instanceof Response) return user;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const parsed = readUsernameChange(body.value);
  if ("error" in parsed) return json({ ok: false, error: parsed.error }, 400);
  const check = await checkCurrentPassword(env, user.id, parsed.currentPassword);
  if (check.status !== "ok") return passwordCheckResponse(check.status);
  if (parsed.username === check.user.username) return json({ ok: true, user: publicUser(check.user) });
  try {
    await updateUsername(env.DB, user.id, parsed.username);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return json({ ok: false, error: "用户名已被占用" }, 409);
  }
  logInfo({ message: "username_changed", user_id: user.id });
  return json({ ok: true, user: publicUser({ ...check.user, username: parsed.username }) });
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
    sessions: rows.map((row) => ({
      id: row.id,
      created_at: row.created_at,
      expires_at: row.expires_at,
      current: row.id === user.session_id,
    })),
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
  const like = compileLikeQuery(url.searchParams.get("q"));
  if (!like.ok) return json({ ok: false, error: like.error }, 400);

  const page = boundedInt(url.searchParams.get("page"), 1, 500);
  const pageSize = boundedInt(url.searchParams.get("page_size"), 20, 50);
  const result = await listMessages(env.DB, {
    userId: user.id,
    deviceId: deviceId || null,
    from: from || null,
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

async function devices(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  return json({ ok: true, devices: await listDevices(env.DB, user.id) });
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

  const token = randomToken();
  const pushToken = newPushToken();
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  await insertDevice(env.DB, {
    id,
    userId: user.id,
    name: parsed.name,
    tokenHash: await sha256Hex(token),
    pushTokenHash: await sha256Hex(pushToken),
    secret: parsed.secret,
    createdAt,
  });
  logInfo({ message: "device_created", device_id: id, user_id: user.id, has_secret: parsed.secret !== null });
  return json({
    ok: true,
    token,
    push_url: ingestUrl(request, pushToken),
    device: {
      id,
      name: parsed.name,
      created_at: createdAt,
      last_seen_at: null,
      has_secret: parsed.secret !== null,
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
  const updated = await replaceDevicePushToken(env.DB, user.id, id, await sha256Hex(pushToken), action);
  if (!updated) return json({ ok: false, error: "推送链接状态已变化" }, 409);
  logInfo({ message: "device_push_issued", device_id: id, user_id: user.id, action });
  return json({
    ok: true,
    push_url: ingestUrl(request, pushToken),
    device: { id, push: "active" },
  });
}

function newPushToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `psh_${bytesToBase64Url(bytes)}`;
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
  kind: "telegram" | "wecom" | "bark" | "email";
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
  const code = extractCode(content);
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
  logInfo({ message: "sms_test_stored", device_id: device.id, message_id: messageId, has_code: code !== null });
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

async function requireSensitiveUser(request: Request, env: Env) {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  if (rejectsSensitiveWrite(request)) return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  return user;
}

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

function readCredentials(value: unknown): { username: string; password: string } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.username !== "string" || typeof record.password !== "string") return null;
  const username = record.username.trim();
  if (!username || username.length > 64 || record.password.length === 0 || record.password.length > 256) {
    return null;
  }
  return { username, password: record.password };
}

function readCurrentPassword(record: Record<string, unknown>): string | { error: string } {
  if (typeof record.current_password !== "string" || record.current_password.length === 0) {
    return { error: "请填写当前密码" };
  }
  if (record.current_password.length > 256) return { error: "当前密码需要 1 到 256 个字符" };
  return record.current_password;
}

function readUsernameChange(value: unknown): { currentPassword: string; username: string } | { error: string } {
  if (!value || typeof value !== "object") return { error: "请求体无效" };
  const record = value as Record<string, unknown>;
  const currentPassword = readCurrentPassword(record);
  if (typeof currentPassword !== "string") return currentPassword;
  if (typeof record.username !== "string") return { error: "请填写用户名" };
  const username = record.username.trim();
  if (!USERNAME_RE.test(username)) {
    return { error: "用户名需以字母或数字开头，只能包含字母、数字、. _ -，最长 64" };
  }
  return { currentPassword, username };
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

function readDeviceBody(value: unknown): { name: string; secret: string | null } | { error: string } {
  if (!value || typeof value !== "object") return { error: "请求体无效" };
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string") return { error: "请填写设备名称" };
  const name = record.name.trim();
  if (!name || name.length > 64 || /[\u0000-\u001f]/.test(name)) return { error: "设备名称需要 1 到 64 个字符" };
  if (record.secret === undefined || record.secret === null || record.secret === "") {
    return { name, secret: null };
  }
  if (typeof record.secret !== "string") return { error: "签名密钥无效" };
  const secret = record.secret.trim();
  if (secret.length < 8 || secret.length > 256) return { error: "签名密钥需要 8 到 256 个字符" };
  return { name, secret };
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
