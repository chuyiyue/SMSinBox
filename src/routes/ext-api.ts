// External REST API under /api/ext/v1 for third-party programs and integrations.
// Authenticated with Bearer token, separate from administrator sessions.

import { resolveContentKey } from "../crypto";
import {
  findDeviceGroup,
  getExtDevice,
  getExtDevicePush,
  getExtMessage,
  getLastMessageTimeForDevice,
  getLatestExtOtp,
  listExtDevices,
  listExtMessages,
  listExtOtp,
  setDeviceGroup,
} from "../db";
import { json } from "../http";
import { compileLikeQuery } from "../search";
import type { MessageView } from "../types";
import { APP_VERSION } from "../version";
import { createDeviceForUser, rotateDevicePushForUser } from "./api";
import {
  deriveDeviceStatus,
  deviceInScope,
  extError,
  extOk,
  extOkPaged,
  hasPermission,
  requireExtToken,
  type AuthedToken,
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
        allow: "GET, POST, OPTIONS",
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
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
    if (method === "GET") return handleListDevices(env, token);
    if (method === "POST") return handleCreateDevice(request, env, token);
    return extError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
  }

  const deviceStatusMatch = /^\/api\/ext\/v1\/devices\/([^/]+)\/status$/.exec(path);
  if (deviceStatusMatch?.[1]) {
    if (method !== "GET") return extError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
    return handleGetDeviceStatus(deviceStatusMatch[1], env, token);
  }

  const devicePushUrlMatch = /^\/api\/ext\/v1\/devices\/([^/]+)\/push-url$/.exec(path);
  if (devicePushUrlMatch?.[1]) {
    if (method !== "GET") return extError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
    return handleGetDevicePushUrl(devicePushUrlMatch[1], request, env, token);
  }

  const devicePushRotateMatch = /^\/api\/ext\/v1\/devices\/([^/]+)\/push-url\/rotate$/.exec(path);
  if (devicePushRotateMatch?.[1]) {
    if (method !== "POST") return extError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
    return handleRotateDevicePushUrl(devicePushRotateMatch[1], request, env, token);
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
    code_source: message.code_source,
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
    code_source: m.code_source,
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

async function handleCreateDevice(request: Request, env: Env, token: AuthedToken): Promise<Response> {
  if (!hasPermission(token, "devices:create")) {
    return extError(403, "PERMISSION_DENIED", "Permission devices:create required");
  }

  let bodyValue: unknown;
  try {
    bodyValue = await request.json();
  } catch {
    return extError(400, "BAD_REQUEST", "Request body must be valid JSON");
  }
  if (!bodyValue || typeof bodyValue !== "object" || Array.isArray(bodyValue)) {
    return extError(400, "BAD_REQUEST", "Request body must be a JSON object");
  }
  const record = bodyValue as Record<string, unknown>;

  // `type` is accepted as an alias for `platform`; validation itself is
  // the shared console one inside createDeviceForUser.
  const normalized: Record<string, unknown> = { ...record };
  if (normalized.platform === undefined && typeof record.type === "string") {
    normalized.platform = record.type;
  }

  // group_id is optional; when given it must name one of the owner's
  // groups (checked up front so a bad id never leaves a stray device).
  let groupId: string | null = null;
  if (typeof record.group_id === "string" && record.group_id.trim()) {
    groupId = record.group_id.trim();
    const group = await findDeviceGroup(env.DB, token.user_id, groupId);
    if (!group) {
      return extError(400, "BAD_REQUEST", "Device group not found");
    }
  } else if (record.group_id !== undefined && record.group_id !== null) {
    return extError(400, "BAD_REQUEST", "group_id must be a string");
  }

  const created = await createDeviceForUser(env, token.user_id, normalized);
  if (!created.ok) {
    if (created.status === 503) {
      return extError(503, "NOT_CONFIGURED", created.error);
    }
    return extError(400, "BAD_REQUEST", created.error);
  }

  // Creation is allowed even when the token's device scope is limited:
  // the new device is NOT silently added to the scope, so later
  // push-url reads/rotations for it still go through scope checks.
  let appliedGroupId: string | null = null;
  if (groupId) {
    appliedGroupId = (await setDeviceGroup(env.DB, token.user_id, created.id, groupId)) ? groupId : null;
  }

  const origin = new URL(request.url).origin;
  return extOk({
    device: {
      id: created.id,
      name: created.name,
      platform: created.platform,
      created_at: created.createdAt,
      last_seen_at: null,
      group_id: appliedGroupId,
      push: "active",
    },
    // Issued once at creation, exactly like the console flow.
    push_url: `${origin}/api/v1/ingest/${created.pushToken}`,
    token: created.token,
    token_type: "Bearer",
    token_expires_at: created.tokenExpiresAt,
  });
}

async function handleGetDevicePushUrl(
  deviceId: string,
  request: Request,
  env: Env,
  token: AuthedToken,
): Promise<Response> {
  if (!hasPermission(token, "devices:push")) {
    return extError(403, "PERMISSION_DENIED", "Permission devices:push required");
  }

  const contentKey = resolveContentKey(env.CONTENT_KEY);
  const row = await getExtDevicePush(env.DB, token.user_id, deviceId, token.device_scope, contentKey);
  if (!row) {
    // Missing and out-of-scope devices are indistinguishable on purpose.
    return extError(404, "NOT_FOUND", "Device not found");
  }
  if (row.push === "none") {
    return extError(409, "PUSH_NOT_ISSUED", "This device has no push URL yet");
  }
  if (row.push === "revoked") {
    return extError(409, "PUSH_REVOKED", "The push URL for this device has been revoked");
  }
  if (!row.pushUrl) {
    // Active link whose plaintext was never stored (legacy device): the
    // console shows the same state and offers rotation as the way out.
    return extError(409, "PUSH_URL_NOT_STORED", "The push URL for this device is not stored; rotate it to reveal a new one");
  }

  const origin = new URL(request.url).origin;
  return extOk({
    id: row.id,
    name: row.name,
    push: "active",
    push_url: `${origin}${row.pushUrl}`,
  });
}

async function handleRotateDevicePushUrl(
  deviceId: string,
  request: Request,
  env: Env,
  token: AuthedToken,
): Promise<Response> {
  if (!hasPermission(token, "devices:push")) {
    return extError(403, "PERMISSION_DENIED", "Permission devices:push required");
  }

  // Scope gate first, with the same not-found semantics as every other
  // device endpoint, so rotation cannot probe devices outside the scope.
  const device = await getExtDevice(env.DB, token.user_id, deviceId, token.device_scope);
  if (!device) {
    return extError(404, "NOT_FOUND", "Device not found");
  }

  const rotated = await rotateDevicePushForUser(env, token.user_id, deviceId);
  if (!rotated.ok) {
    if (rotated.reason === "no_push") {
      return extError(409, "PUSH_NOT_ISSUED", "This device has no push URL to rotate");
    }
    if (rotated.reason === "not_found") {
      return extError(404, "NOT_FOUND", "Device not found");
    }
    return extError(409, "CONFLICT", "Push URL state changed; please retry");
  }

  const origin = new URL(request.url).origin;
  return extOk({
    id: deviceId,
    push: "active",
    push_url: `${origin}/api/v1/ingest/${rotated.pushToken}`,
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
      description:
        "External REST API for SMS messages, verification codes (OTP), and devices: reads and status for every token, plus device creation and push-URL management for tokens holding the devices:create / devices:push permissions",
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
          description: "Verify that the API is online and the token is valid",
          responses: {
            "200": { description: "API is healthy" },
            "401": { description: "Unauthorized" },
          },
        },
      },
      "/me": {
        get: {
          summary: "Current token details",
          description: "Get permissions, device scope, and expiry of the calling token",
          responses: {
            "200": { description: "Token information" },
            "401": { description: "Unauthorized" },
          },
        },
      },
      "/messages": {
        get: {
          summary: "List SMS messages",
          description: "List SMS messages with pagination and optional filters",
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
          description: "Get details of an SMS message by ID",
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
          description: "Get the latest SMS verification code matching optional filters",
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
          description: "Search messages containing verification codes",
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
          description: "List devices within authorized scope and their derived status",
          responses: {
            "200": { description: "Device list" },
            "403": { description: "Permission devices:read required" },
          },
        },
        post: {
          summary: "Create a device",
          description:
            "Create a device for the token owner (same validation as the console). The response carries the new device and its full push_url, issued once at creation",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name"],
                  properties: {
                    name: { type: "string", description: "Device name, 1-64 characters" },
                    platform: { type: "string", description: "Platform/type, e.g. android, ios, openwrt (default other)" },
                    type: { type: "string", description: "Alias for platform" },
                    group_id: { type: "string", description: "Optional device group ID owned by the token owner" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Created device with push_url" },
            "400": { description: "Validation failed" },
            "403": { description: "Permission devices:create required" },
          },
        },
      },
      "/devices/{id}/status": {
        get: {
          summary: "Get single device status",
          description: "Get device online status and timestamp of the latest received message",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Device status" },
            "404": { description: "Device not found or out of scope" },
          },
        },
      },
      "/devices/{id}/push-url": {
        get: {
          summary: "Get a device's push URL",
          description:
            "Return the full push URL of a device inside the token scope, rebuilt from the stored secret. Devices whose link was never stored (legacy) answer 409 PUSH_URL_NOT_STORED",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Full push URL" },
            "403": { description: "Permission devices:push required" },
            "404": { description: "Device not found or out of scope" },
            "409": { description: "No live push URL (never issued, revoked, or not stored)" },
          },
        },
      },
      "/devices/{id}/push-url/rotate": {
        post: {
          summary: "Rotate a device's push URL",
          description: "Issue a new push URL for the device; the old URL stops working immediately",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "New push URL" },
            "403": { description: "Permission devices:push required" },
            "404": { description: "Device not found or out of scope" },
            "409": { description: "Device has no push URL to rotate" },
          },
        },
      },
    },
  };
}
