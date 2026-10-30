import {
  hashPassword,
  randomToken,
  requestIsSecure,
  secretsEqual,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  sessionCookieHeader,
  sha256Hex,
  verifyPassword,
} from "../auth";
import {
  countDevices,
  countNotifyChannels,
  countUsers,
  createSession,
  deleteDevice,
  deleteNotifyChannel,
  deleteSession,
  findNotifyChannel,
  findSessionUser,
  findUserByUsername,
  getMessage,
  insertDevice,
  insertNotifyChannel,
  insertUser,
  isUniqueViolation,
  listDevices,
  listMessages,
  listMessagesSince,
  listNotifyChannels,
  MAX_DEVICES,
  setNotifyChannelEnabled,
  updatePasswordHash,
} from "../db";
import { isCrossSite, json, readCookie, readLimitedBytes } from "../http";
import { logError, logInfo } from "../log";
import { compileLikeQuery } from "../search";
import { channelFromRow, deliverChannels, MAX_NOTIFY_CHANNELS, parseChannelInput, redactConfig } from "../notify";
import { openSmtpSocket } from "../smtp";
import { createInboxStream, resolveCursor, SSE_BATCH } from "../sse";
import type { SessionUser } from "../types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function handleApi(request: Request, env: Env): Promise<Response> {
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
  if (path === "/api/v1/devices") {
    if (method === "GET") return devices(request, env);
    if (method === "POST") return createDevice(request, env);
    return methodNotAllowed("GET, POST");
  }
  const deviceMatch = /^\/api\/v1\/devices\/([^/]+)$/.exec(path);
  if (deviceMatch?.[1]) {
    if (method !== "DELETE") return methodNotAllowed("DELETE");
    return removeDevice(request, env, deviceMatch[1]);
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

  const existing = await findUserByUsername(env.DB, credentials.username);
  const passwordOk = await verifyPassword(credentials.password, existing?.password_hash ?? "");
  const adminOk =
    adminUsername.length > 0 &&
    adminPassword.length > 0 &&
    credentials.username === adminUsername &&
    (await secretsEqual(credentials.password, adminPassword));
  if (!passwordOk && !adminOk) return json({ ok: false, error: "用户名或密码错误" }, 401);

  let user = existing;
  if (adminOk && !user) {
    const createdAt = Date.now();
    const id = crypto.randomUUID();
    try {
      await insertUser(env.DB, {
        id,
        username: adminUsername,
        passwordHash: await hashPassword(credentials.password),
        createdAt,
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    user = await findUserByUsername(env.DB, adminUsername);
  } else if (adminOk && user && !passwordOk) {
    await updatePasswordHash(env.DB, user.id, await hashPassword(credentials.password));
  }
  if (!user) return json({ ok: false, error: "用户名或密码错误" }, 401);

  const token = randomToken();
  const now = Date.now();
  await createSession(env.DB, {
    id: await sha256Hex(token),
    userId: user.id,
    expiresAt: now + SESSION_TTL_SECONDS * 1000,
    createdAt: now,
  });
  const headers = new Headers();
  headers.set("set-cookie", sessionCookieHeader(token, requestIsSecure(request), SESSION_TTL_SECONDS));
  logInfo({ message: "login", user_id: user.id });
  return json({ ok: true, user: { id: user.id, username: user.username } }, 200, headers);
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
  return json({ ok: true, user: { id: user.id, username: user.username } });
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
        });
      } catch (error) {
        logError({
          message: "sse_poll_failed",
          user_id: user.id,
          error: error instanceof Error ? error.message.slice(0, 180) : "unknown",
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
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  return json({
    ok: true,
    messages: result.messages,
    page,
    page_size: pageSize,
    total: result.total,
  });
}

async function detail(request: Request, env: Env, rawId: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const id = decodePart(rawId);
  if (!id || !UUID_RE.test(id)) return json({ ok: false, error: "短信不存在" }, 404);
  const message = await getMessage(env.DB, user.id, id);
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
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  await insertDevice(env.DB, {
    id,
    userId: user.id,
    name: parsed.name,
    tokenHash: await sha256Hex(token),
    secret: parsed.secret,
    createdAt,
  });
  logInfo({ message: "device_created", device_id: id, user_id: user.id, has_secret: parsed.secret !== null });
  return json({
    ok: true,
    token,
    device: {
      id,
      name: parsed.name,
      created_at: createdAt,
      last_seen_at: null,
      has_secret: parsed.secret !== null,
    },
  });
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

async function requireUser(request: Request, env: Env): Promise<SessionUser | Response> {
  if (isCrossSite(request)) return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (!token) return json({ ok: false, error: "未登录" }, 401);
  const sessionHash = await sha256Hex(token);
  const user = await findSessionUser(env.DB, sessionHash);
  if (!user || user.expires_at <= Date.now()) {
    if (user) await deleteSession(env.DB, sessionHash);
    return json({ ok: false, error: "未登录" }, 401);
  }
  return user;
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
