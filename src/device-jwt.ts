// System-signed device credentials.
//
// New devices receive an HS256 JWT whose signing key never leaves the Worker.
// The token is not a session cookie and is only accepted on the SMS ingest
// route. `devices.token_hash` stores SHA-256(jti) for the *current* token, and
// `devices.token_version` is embedded in the claim set. Deleting a device, or
// bumping its token_version / replacing token_hash, makes every older JWT
// unusable immediately.
//
// Legacy devices created before this module keep their random Bearer token
// (hashed in the same column). That path stays in src/routes/sms.ts for the
// migration window.

import { base64UrlToBytes, bytesToBase64Url, equalBytes, sha256Hex } from "./auth";
import { readSchemaMeta, writeSchemaMeta } from "./db";

export const DEVICE_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;
const JWT_ALG = "HS256";
const JWT_AUDIENCE = "smsinbox-device";
const HEADER = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ alg: JWT_ALG, typ: "JWT" })));

export interface DeviceTokenClaims {
  /** Device id. */
  sub: string;
  /** Credential generation; must equal devices.token_version. */
  ver: number;
  /** Unique token id; only its SHA-256 is stored. */
  jti: string;
  iat: number;
  exp: number;
  aud: typeof JWT_AUDIENCE;
}

export type DeviceTokenResult =
  | { ok: true; claims: DeviceTokenClaims }
  | { ok: false; error: string };

// Persisted only when DEVICE_JWT_SECRET is absent. Production sets the secret,
// so this row is a local/dev fallback and is never derived from CONTENT_KEY
// or the admin password.
export const DEVICE_JWT_META_KEY = "device_jwt_secret";

// DEVICE_JWT_SECRET (>= 16 characters) wins. Otherwise reuse the value stored
// in schema_meta, or generate 32 random bytes, store them, and return that.
export async function resolveDeviceJwtSecret(env: Env): Promise<string> {
  const explicit = env.DEVICE_JWT_SECRET?.trim() ?? "";
  if (explicit.length >= 16) return explicit;
  const stored = (await readSchemaMeta(env.DB, DEVICE_JWT_META_KEY))?.trim() ?? "";
  if (stored.length >= 16) return stored;
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const generated = bytesToBase64Url(bytes);
  await writeSchemaMeta(env.DB, DEVICE_JWT_META_KEY, generated);
  return generated;
}

export function looksLikeDeviceJwt(token: string): boolean {
  return token.startsWith("eyJ") && token.split(".").length === 3;
}

export function newDeviceTokenId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function signDeviceToken(input: {
  secret: string;
  deviceId: string;
  version: number;
  tokenId: string;
  now: number;
}): Promise<{ token: string; expiresAt: number; tokenHash: string }> {
  const issuedAt = Math.floor(input.now / 1000);
  const expiresAt = issuedAt + DEVICE_TOKEN_TTL_SECONDS;
  const claims: DeviceTokenClaims = {
    sub: input.deviceId,
    ver: input.version,
    jti: input.tokenId,
    iat: issuedAt,
    exp: expiresAt,
    aud: JWT_AUDIENCE,
  };
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = await sign(`${HEADER}.${payload}`, input.secret);
  return {
    token: `${HEADER}.${payload}.${signature}`,
    expiresAt: expiresAt * 1000,
    tokenHash: await sha256Hex(input.tokenId),
  };
}

export async function verifyDeviceToken(
  token: string,
  secret: string,
  now: number,
): Promise<DeviceTokenResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, error: "设备 token 无效" };
  const [header, payload, provided] = parts as [string, string, string];

  const headerValue = decodeJson(header);
  if (!headerValue || headerValue.alg !== JWT_ALG) return { ok: false, error: "设备 token 无效" };

  const expected = await sign(`${header}.${payload}`, secret);
  const providedBytes = base64UrlToBytes(provided);
  const expectedBytes = base64UrlToBytes(expected);
  if (!providedBytes || !expectedBytes || !equalBytes(expectedBytes, providedBytes)) {
    return { ok: false, error: "设备 token 无效" };
  }

  const claims = decodeJson(payload);
  if (!claims) return { ok: false, error: "设备 token 无效" };
  if (
    typeof claims.sub !== "string" ||
    claims.sub.length === 0 ||
    claims.sub.length > 64 ||
    typeof claims.jti !== "string" ||
    claims.jti.length === 0 ||
    claims.jti.length > 128 ||
    typeof claims.ver !== "number" ||
    !Number.isInteger(claims.ver) ||
    claims.ver < 0 ||
    typeof claims.exp !== "number" ||
    claims.aud !== JWT_AUDIENCE
  ) {
    return { ok: false, error: "设备 token 无效" };
  }
  if (claims.exp * 1000 <= now) return { ok: false, error: "设备 token 已过期" };
  return { ok: true, claims: claims as unknown as DeviceTokenClaims };
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

function decodeJson(value: string): Record<string, unknown> | null {
  const bytes = base64UrlToBytes(value);
  if (!bytes) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
