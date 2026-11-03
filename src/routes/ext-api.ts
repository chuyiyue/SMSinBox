// External REST API under /api/ext/v1 for third-party programs and integrations.
// Authenticated with Bearer token, separate from administrator sessions.

import { resolveContentKey } from "../crypto";
import {
  getExtDevice,
  getExtMessage,
  getLastMessageTimeForDevice,
  getLatestExtOtp,
  listExtDevices,
  listExtMessages,
  listExtOtp,
} from "../db";
import { json } from "../http";
import { compileLikeQuery } from "../search";
import type { MessageView } from "../types";
import { APP_VERSION } from "../version";
import {
  deriveDeviceStatus,
  deviceInScope,
  extError,
  extOk,
  extOkPaged,
  hasPermission,
  requireExtToken,
} from "./ext-auth";

type WaitCtx = { waitUntil(promise: Promise<unknown>): void };

export function formatExtMessage(m: MessageView) {
  return {
    id: m.id,
    device_id: m.device_id,
    device_name: m.device_name,
    from: m.from_number,
    from_number: m.from_number,
    to: m.to_number,
    to_number: m.to_number,
    content: m.content,
    code: m.code,
    received_at: m.received_at,
    created_at: m.created_at,
  };
}

export async function handleExtApi(request: Request, env: Env, _ctx: WaitCtx = { waitUntil() {} }): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        allow: "GET, OPTIONS",
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "Authorization, Content-Type",
      },
    });
  }

  // OpenAPI JSON spec does not require authentication
  if (path === "/api/ext/v1/openapi.json") {
    if (method !== "GET") return extError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
    return json(getOpenApiSpec());
  }

  // All other endpoints require valid Bearer token
  const auth = await requireExtToken(request, env);
  if (auth instanceof Response) return auth;
  const token = auth;

  if (path === "/api/ext/v1/health") {
    if (method !== "GET") return extError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
    return extOk({ status: "ok", version: APP_VERSION, time: Date.now() });
  }

  if (path === "/api/ext/v1/me") {
    if (method !== "GET") return extError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
    return extOk({
      id: token.id,
      name: token.name,
      permissions: token.permissions,
      device_scope: token.device_scope,
      expires_at: token.expires_at,
    });
  }

  if (path === "/api/ext/v1/messages") {
    if (method !== "GET") return extError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
    return handleListMessages(url, env, token);
  }

  const messageMatch = /^\/api\/ext\/v1\/messages\/([^/]+)$/.exec(path);
  if (messageMatch?.[1]) {
    if (method !== "GET") return extError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
    return handleGetMessage(messageMatch[1], env, token);
  }

  if (path === "/api/ext/v1/otp/latest") {
    if (method !== "GET") return extError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
    return handleGetLatestOtp(url, env, token);
  }

  if (path === "/api/ext/v1/otp/search") {
    if (method !== "GET") return extError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
    return handleSearchOtp(url, env, token);
  }

  if (path === "/api/ext/v1/devices") {
    if (method !== "GET") return extError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
    return handleListDevices(env, token);
  }

  const deviceStatusMatch = /^\/api\/ext\/v1\/devices\/([^/]+)\/status$/.exec(path);
  if (deviceStatusMatch?.[1]) {
    if (method !== "GET") return extError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
    return handleGetDeviceStatus(deviceStatusMatch[1], env, token);
  }

  return extError(404, "NOT_FOUND", "Endpoint not found");
}

async function handleListMessages(url: URL, env: Env, token: import("./ext-auth").AuthedToken): Promise<Response> {
  if (!hasPermission(token, "messages:read")) {
    return extError(403, "PERMISSION_DENIED", "Permission messages:read required");
  }

  const limit = parseBoundedInt(url.searchParams.get("limit"), 20, 1, 100);
  const offset = parseBoundedInt(url.searchParams.get("offset"), 0, 0, 1_000_000);
  const deviceId = url.searchParams.get("device_id")?.trim() || null;
  const from = url.searchParams.get("from")?.trim() || null;
  const since = parseTimestamp(url.searchParams.get("since"));
  const until = parseTimestamp(url.searchParams.get("until"));
  const q = url.searchParams.get("q")?.trim() || null;

  if (deviceId && !deviceInScope(token, deviceId)) {
    return extOkPaged([], { limit, offset, total: 0 });
  }

  const like = compileLikeQuery(q);
  if (!like.ok) {
    return extError(400, "BAD_REQUEST", like.error);
  }

  const contentKey = resolveContentKey(env.CONTENT_KEY);
  const result = await listExtMessages(env.DB, {
    userId: token.user_id,
    scopeDeviceIds: token.device_scope,
    deviceId,
    from,
    since,
    until,
    like: like.pattern,
    text: q,
    limit,
    offset,
    contentKey,
  });

  return extOkPaged(result.messages.map(formatExtMessage), { limit, offset, total: result.total });
}

async function handleGetMessage(messageId: string, env: Env, token: import("./ext-auth").AuthedToken): Promise<Response> {
  if (!hasPermission(token, "messages:read")) {
    return extError(403, "PERMISSION_DENIED", "Permission messages:read required");
  }

  const contentKey = resolveContentKey(env.CONTENT_KEY);
  const message = await getExtMessage(env.DB, token.user_id, messageId, token.device_scope, contentKey);
  if (!message) {
    return extError(404, "NOT_FOUND", "Message not found");
  }

  return extOk(formatExtMessage(message));
}

async function handleGetLatestOtp(url: URL, env: Env, token: import("./ext-auth").AuthedToken): Promise<Response> {
  if (!hasPermission(token, "otp:read")) {
    return extError(403, "PERMISSION_DENIED", "Permission otp:read required");
  }

  const deviceId = url.searchParams.get("device_id")?.trim() || null;
  const from = url.searchParams.get("from")?.trim() || null;
  const since = parseTimestamp(url.searchParams.get("since"));

  if (deviceId && !deviceInScope(token, deviceId)) {
    return extOk(null);
  }

  const contentKey = resolveContentKey(env.CONTENT_KEY);
  const message = await getLatestExtOtp(env.DB, {
    userId: token.user_id,
    scopeDeviceIds: token.device_scope,
    deviceId,
    from,
    since,
    contentKey,
  });

  if (!message || !message.code) {
    return extOk(null);
  }

  return extOk({
    id: message.id,
    code: message.code,
    from: message.from_number,
    content: message.content,
    device_id: message.device_id,
    device_name: message.device_name,
    received_at: message.received_at,
    code_source: "regex",
    code_status: "recognized",
  });
}

async function handleSearchOtp(url: URL, env: Env, token: import("./ext-auth").AuthedToken): Promise<Response> {
  if (!hasPermission(token, "otp:read")) {
    return extError(403, "PERMISSION_DENIED", "Permission otp:read required");
  }

  const limit = parseBoundedInt(url.searchParams.get("limit"), 20, 1, 100);
  const offset = parseBoundedInt(url.searchParams.get("offset"), 0, 0, 1_000_000);
  const deviceId = url.searchParams.get("device_id")?.trim() || null;
  const from = url.searchParams.get("from")?.trim() || null;
  const since = parseTimestamp(url.searchParams.get("since"));
  const until = parseTimestamp(url.searchParams.get("until"));

  if (deviceId && !deviceInScope(token, deviceId)) {
    return extOkPaged([], { limit, offset, total: 0 });
  }

  const contentKey = resolveContentKey(env.CONTENT_KEY);
  const result = await listExtOtp(env.DB, {
    userId: token.user_id,
    scopeDeviceIds: token.device_scope,
    deviceId,
    from,
    since,
    until,
    limit,
    offset,
    contentKey,
  });

  const items = result.messages.map((m) => ({
    id: m.id,
    code: m.code,
    from: m.from_number,
    content: m.content,
    device_id: m.device_id,
    device_name: m.device_name,
    received_at: m.received_at,
    code_source: m.code ? "regex" : null,
    code_status: m.code ? "recognized" : "none",
  }));

  return extOkPaged(items, { limit, offset, total: result.total });
}

async function handleListDevices(env: Env, token: import("./ext-auth").AuthedToken): Promise<Response> {
  if (!hasPermission(token, "devices:read")) {
    return extError(403, "PERMISSION_DENIED", "Permission devices:read required");
  }

  const rows = await listExtDevices(env.DB, token.user_id, token.device_scope);
  const now = Date.now();
  const devices = rows.map((d) => ({
    id: d.id,
    name: d.name,
    platform: d.platform,
    created_at: d.created_at,
    last_seen_at: d.last_seen_at,
    status: deriveDeviceStatus(d.last_seen_at, now),
  }));

  return extOk(devices);
}

async function handleGetDeviceStatus(deviceId: string, env: Env, token: import("./ext-auth").AuthedToken): Promise<Response> {
  if (!hasPermission(token, "devices:status")) {
    return extError(403, "PERMISSION_DENIED", "Permission devices:status required");
  }

  const device = await getExtDevice(env.DB, token.user_id, deviceId, token.device_scope);
  if (!device) {
    return extError(404, "NOT_FOUND", "Device not found");
  }

  const lastMessageAt = await getLastMessageTimeForDevice(env.DB, deviceId);
  const now = Date.now();

  return extOk({
    id: device.id,
    name: device.name,
    platform: device.platform,
    last_seen_at: device.last_seen_at,
    status: deriveDeviceStatus(device.last_seen_at, now),
    last_message_at: lastMessageAt,
  });
}

function parseBoundedInt(val: string | null, fallback: number, min: number, max: number): number {
  if (!val) return fallback;
  const parsed = Number(val);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function parseTimestamp(val: string | null): number | null {
  if (!val) return null;
  const parsed = Number(val);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

export function getOpenApiSpec(): Record<string, unknown> {
  return {
    openapi: "3.0.3",
    info: {
      title: "SMSinBox External API",
      version: APP_VERSION,
      description: "Read-only external REST API for SMS messages, verification codes (OTP), and device status.",
    },
    servers: [
      {
        url: "/api/ext/v1",
        description: "External API v1",
      },
    ],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "API Token generated in Admin Console (format: smsx_...)",
        },
      },
    },
    paths: {
      "/health": {
        get: {
          summary: "Connectivity check",
          description: "Verify that the API is online and the token is valid.",
          responses: {
            "200": { description: "API is healthy" },
            "401": { description: "Unauthorized" },
          },
        },
      },
      "/me": {
        get: {
          summary: "Current token details",
          description: "Get permissions, device scope, and expiry of the calling token.",
          responses: {
            "200": { description: "Token information" },
            "401": { description: "Unauthorized" },
          },
        },
      },
      "/messages": {
        get: {
          summary: "List SMS messages",
          description: "List SMS messages with pagination and optional filters.",
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", default: 20, maximum: 100 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
            { name: "device_id", in: "query", schema: { type: "string" } },
            { name: "from", in: "query", schema: { type: "string" } },
            { name: "since", in: "query", schema: { type: "integer" } },
            { name: "until", in: "query", schema: { type: "integer" } },
            { name: "q", in: "query", schema: { type: "string" } },
          ],
          responses: {
            "200": { description: "Paginated message list" },
            "403": { description: "Permission messages:read required" },
          },
        },
      },
      "/messages/{id}": {
        get: {
          summary: "Get single message",
          description: "Get details of an SMS message by ID.",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Message details" },
            "404": { description: "Message not found or out of scope" },
          },
        },
      },
      "/otp/latest": {
        get: {
          summary: "Get latest OTP",
          description: "Get the latest SMS verification code matching optional filters.",
          parameters: [
            { name: "device_id", in: "query", schema: { type: "string" } },
            { name: "from", in: "query", schema: { type: "string" } },
            { name: "since", in: "query", schema: { type: "integer" } },
          ],
          responses: {
            "200": { description: "Latest OTP message or null if none found" },
            "403": { description: "Permission otp:read required" },
          },
        },
      },
      "/otp/search": {
        get: {
          summary: "Search OTP messages",
          description: "Search messages containing verification codes.",
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", default: 20, maximum: 100 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
            { name: "device_id", in: "query", schema: { type: "string" } },
            { name: "from", in: "query", schema: { type: "string" } },
            { name: "since", in: "query", schema: { type: "integer" } },
            { name: "until", in: "query", schema: { type: "integer" } },
          ],
          responses: {
            "200": { description: "Paginated OTP list" },
            "403": { description: "Permission otp:read required" },
          },
        },
      },
      "/devices": {
        get: {
          summary: "List authorized devices",
          description: "List devices within authorized scope and their derived status.",
          responses: {
            "200": { description: "Device list" },
            "403": { description: "Permission devices:read required" },
          },
        },
      },
      "/devices/{id}/status": {
        get: {
          summary: "Get single device status",
          description: "Get device online status and timestamp of the latest received message.",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Device status" },
            "404": { description: "Device not found or out of scope" },
          },
        },
      },
    },
  };
}
