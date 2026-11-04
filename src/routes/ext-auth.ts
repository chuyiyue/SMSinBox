// Shared authentication and authorization for external API (REST + MCP).
// Both endpoints use Bearer tokens with the same permission/scope logic.

import { readBearer, sha256Hex } from "../auth";
import {
  consumeRateLimit,
  findApiTokenByHash,
  touchApiTokenLastUsed,
} from "../db";
import { json } from "../http";
import type { ApiTokenRecord, ApiTokenView } from "../types";

export type ExtPermission = "messages:read" | "otp:read" | "devices:read" | "devices:status";

export const EXT_PERMISSIONS: ExtPermission[] = ["messages:read", "otp:read", "devices:read", "devices:status"];

export interface AuthedToken {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  permissions: ExtPermission[];
  // device_scope: empty array means ALL devices are authorized
  device_scope: string[];
  expires_at: number | null;
}

/** Rate limit for external API tokens: 120 requests per minute per token. */
export const EXT_RATE_LIMIT = 120;

/**
 * Threshold for determining whether a device is considered "online".
 * A device is "online" if its last_seen_at timestamp is within the last 15 minutes (900,000 ms).
 * If last_seen_at is set but older than 15 minutes, it is "offline".
 * If last_seen_at is null, it is "unseen".
 */
export const DEVICE_ONLINE_THRESHOLD_MS = 15 * 60 * 1000;

export type DeviceStatus = "online" | "offline" | "unseen";

export function deriveDeviceStatus(lastSeenAt: number | null, now = Date.now()): DeviceStatus {
  if (lastSeenAt == null) return "unseen";
  return now - lastSeenAt < DEVICE_ONLINE_THRESHOLD_MS ? "online" : "offline";
}

/**
 * Authenticate an incoming request using Bearer token.
 * Returns AuthedToken on success, or a Response (error) on failure.
 * Also rate-limits (120/min per token) and updates last_used_at on success.
 */
export async function requireExtToken(request: Request, env: Env): Promise<AuthedToken | Response> {
  const authHeader = request.headers.get("Authorization");
  const plaintext = readBearer(authHeader);
  if (!plaintext) {
    return extError(401, "UNAUTHENTICATED", "Bearer token required");
  }

  const tokenHash = await sha256Hex(plaintext);
  const record = await findApiTokenByHash(env.DB, tokenHash);

  if (!record) {
    return extError(401, "TOKEN_INVALID", "Token not found");
  }
  if (record.revoked_at != null) {
    return extError(401, "TOKEN_REVOKED", "Token has been revoked");
  }
  if (record.disabled_at != null) {
    return extError(401, "TOKEN_DISABLED", "Token is disabled");
  }
  if (record.expires_at != null && record.expires_at < Date.now()) {
    return extError(401, "TOKEN_EXPIRED", "Token has expired");
  }

  // Rate limit by token hash, prefixed with "ext:" to avoid collisions with device tokens
  const rateLimitKey = `ext:${tokenHash}`;
  const count = await consumeRateLimit(env.DB, rateLimitKey, Date.now());
  if (count > EXT_RATE_LIMIT) {
    return extError(429, "RATE_LIMITED", "Too many requests, please slow down");
  }

  // Update last_used_at directly on every request.
  // One DB write per external request provides immediate freshness with no in-memory state loss.
  await touchApiTokenLastUsed(env.DB, record.id, Date.now());

  const permissions = safeParseJsonArray(record.permissions) as ExtPermission[];
  const deviceScope = safeParseJsonArray(record.device_scope);

  return {
    id: record.id,
    user_id: record.user_id,
    name: record.name,
    token_hash: tokenHash,
    permissions,
    device_scope: deviceScope,
    expires_at: record.expires_at,
  };
}

export function hasPermission(token: AuthedToken, perm: ExtPermission): boolean {
  return token.permissions.includes(perm);
}

/**
 * Returns true if the token authorizes access to the given device.
 * Empty scope means all devices are allowed.
 */
export function deviceInScope(token: AuthedToken, deviceId: string): boolean {
  if (token.device_scope.length === 0) return true;
  return token.device_scope.includes(deviceId);
}

export function extError(status: number, code: string, message: string): Response {
  return json({ ok: false, error: { code, message } }, status);
}

export function extOk(data: unknown): Response {
  return json({ ok: true, data });
}

export function extOkPaged(data: unknown[], page: { limit: number; offset: number; total: number }): Response {
  return json({ ok: true, data, page });
}

export function safeParseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
    return [];
  } catch {
    return [];
  }
}

export function tokenRecordToView(row: ApiTokenRecord, now = Date.now()): ApiTokenView {
  const permissions = safeParseJsonArray(row.permissions);
  const device_scope = safeParseJsonArray(row.device_scope);
  let status: ApiTokenView["status"] = "active";
  if (row.revoked_at != null) {
    status = "revoked";
  } else if (row.disabled_at != null) {
    status = "disabled";
  } else if (row.expires_at != null && row.expires_at < now) {
    status = "expired";
  }
  return {
    id: row.id,
    name: row.name,
    token_prefix: row.token_prefix,
    token: null,
    permissions,
    device_scope,
    expires_at: row.expires_at,
    disabled_at: row.disabled_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    status,
  };
}
