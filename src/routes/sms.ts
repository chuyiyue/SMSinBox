import {
  readBearer,
  secretsEqual,
  sha256Hex,
  verifyHmacSignature,
} from "../auth";
import {
  looksLikeDeviceJwt,
  resolveDeviceJwtSecret,
  verifyDeviceToken,
} from "../device-jwt";
import { resolveContentKey, revealCode, sealMessage } from "../crypto";
import { dedupHash } from "../dedup";
import {
  consumeRateLimit,
  findDeviceById,
  findDeviceByPushTokenHash,
  findDeviceByTokenHash,
  findMessageByHash,
  insertMessage,
  isUniqueViolation,
  RATE_LIMIT_PER_MINUTE,
  touchDevice,
} from "../db";
import { extractCode } from "../extract";
import { json, MAX_BODY_BYTES, readLimitedBytes } from "../http";
import { logInfo } from "../log";
import { notifyStoredSms, scheduleNotify } from "../notify";
import { buildRawPayload, parseSmsPayload } from "../parse";
import type { DeviceRecord } from "../types";

const INGEST_PREFIX = "/api/v1/ingest/";
const PUSH_TOKEN_PATTERN = /^psh_[A-Za-z0-9_-]+$/;

export function buildTestSms(nonce: string): string {
  return `SMSinBox 测试短信。验证码 654321。序号 ${nonce}`;
}

// Reject before hashing. The charset is the psh_ prefix plus base64url, and the
// length cap matches readBearer so a huge path never becomes a SHA-256 input.
export function readIngestSecret(pathname: string): string | null {
  if (!pathname.startsWith(INGEST_PREFIX)) return null;
  const raw = pathname.slice(INGEST_PREFIX.length);
  if (!raw || raw.includes("/")) return null;
  let secret: string;
  try {
    secret = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (secret.length < 16 || secret.length > 256 || !PUSH_TOKEN_PATTERN.test(secret)) return null;
  return secret;
}

export async function handleSms(
  request: Request,
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
): Promise<Response> {
  const bytes = await readLimitedBytes(request, MAX_BODY_BYTES);
  if (bytes === null) return json({ ok: false, error: "请求体过大" }, 413);

  const token = readBearer(request.headers.get("authorization"));
  if (!token) return json({ ok: false, error: "缺少设备 token" }, 401);

  const now = Date.now();
  const auth = await authenticateDevice(request, env, token, bytes, now);
  if (auth instanceof Response) return auth;
  return storeSms(request, env, ctx, auth.device, bytes, auth.rateKey, now);
}

type DeviceAuth = { device: DeviceRecord; rateKey: string; mode: "jwt" | "legacy" };

// Two credentials coexist during the migration window:
//   - system-signed JWT (new devices; no per-device secret, no HMAC)
//   - legacy random Bearer token plus optional per-device HMAC secret
// The JWT path is checked first. A device row is the source of truth, so
// deleting the device (or changing token_version/token_hash) revokes it.
async function authenticateDevice(
  request: Request,
  env: Env,
  token: string,
  body: Uint8Array,
  now: number,
): Promise<DeviceAuth | Response> {
  const signature = request.headers.get("x-signature");
  const timestamp = request.headers.get("x-timestamp");

  if (looksLikeDeviceJwt(token)) {
    const secret = resolveDeviceJwtSecret(env);
    if (!secret) return json({ ok: false, error: "设备认证尚未配置，请联系管理员" }, 503);
    const verified = await verifyDeviceToken(token, secret, now);
    if (!verified.ok) return json({ ok: false, error: verified.error }, 401);
    const device = await findDeviceById(env.DB, verified.claims.sub);
    if (!device || device.token_version !== verified.claims.ver) {
      return json({ ok: false, error: "设备 token 无效" }, 401);
    }
    const tokenHash = await sha256Hex(verified.claims.jti);
    if (!(await secretsEqual(tokenHash, device.token_hash))) {
      return json({ ok: false, error: "设备 token 已撤销" }, 401);
    }
    if (signature || timestamp) {
      return json({ ok: false, error: "该设备使用系统 JWT，不需要签名" }, 401);
    }
    // Rate limits use the stored credential hash, the same value deleteDevice
    // clears, so a deleted device cannot leave a live window behind. A fresh
    // jti (token rotation) naturally starts a fresh window.
    return { device, rateKey: tokenHash, mode: "jwt" };
  }

  const tokenHash = await sha256Hex(token);
  const device = await findDeviceByTokenHash(env.DB, tokenHash);
  if (!device) return json({ ok: false, error: "设备 token 无效" }, 401);

  // Legacy compatibility: only devices that still store a secret enforce HMAC.
  // New devices never do, so a misplaced signature is rejected loudly.
  if (device.secret) {
    if (!signature || !timestamp) return json({ ok: false, error: "该设备要求 HMAC 签名" }, 401);
    const valid = await verifyHmacSignature({
      secret: device.secret,
      timestamp,
      body,
      signature,
      now,
    });
    if (!valid) return json({ ok: false, error: "签名无效" }, 401);
  } else if (signature || timestamp) {
    return json({ ok: false, error: "该设备未启用签名" }, 401);
  }
  return { device, rateKey: tokenHash, mode: "legacy" };
}

export async function handleIngest(
  request: Request,
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
): Promise<Response> {
  const bytes = await readLimitedBytes(request, MAX_BODY_BYTES);
  if (bytes === null) return json({ ok: false, error: "请求体过大" }, 413);

  // The path is the only credential. Authorization is ignored so a foreign
  // Bearer cannot choose a different device. HMAC stays on the Bearer route.
  const secret = readIngestSecret(new URL(request.url).pathname);
  if (!secret) return json({ ok: false, error: "推送链接无效" }, 401);
  const tokenHash = await sha256Hex(secret);
  const device = await findDeviceByPushTokenHash(env.DB, tokenHash);
  if (!device) return json({ ok: false, error: "推送链接无效" }, 401);
  if (device.push_revoked_at != null) return json({ ok: false, error: "推送链接已撤销" }, 401);

  return storeSms(request, env, ctx, device, bytes, tokenHash, Date.now());
}

async function storeSms(
  request: Request,
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  device: DeviceRecord,
  bytes: Uint8Array,
  rateKey: string,
  now: number,
): Promise<Response> {
  const hits = await consumeRateLimit(env.DB, rateKey, now);
  if (hits > RATE_LIMIT_PER_MINUTE) {
    return json({ ok: false, error: "请求过于频繁" }, 429, { "retry-after": "60" });
  }

  const bodyText = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes);
  const parsed = parseSmsPayload(request.headers.get("content-type"), bodyText, now);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);
  const contentHash = await dedupHash({
    deviceId: device.id,
    from: parsed.sms.from,
    content: parsed.sms.content,
    receivedAt: parsed.sms.receivedAt,
  });
  const contentKey = resolveContentKey(env.CONTENT_KEY);
  const duplicate = await duplicateResponse(env, device.id, contentHash, now, contentKey);
  if (duplicate) return duplicate;

  const code = extractCode(parsed.sms.content);
  const sealed = await sealMessage(contentKey, {
    content: parsed.sms.content,
    code,
    rawPayload: buildRawPayload(bodyText, parsed.sms),
  });
  if ("error" in sealed) return json({ ok: false, error: "内容加密密钥无效" }, 500);
  const id = crypto.randomUUID();
  try {
    await insertMessage(env.DB, {
      id,
      deviceId: device.id,
      from: parsed.sms.from,
      to: parsed.sms.to,
      content: sealed.content,
      contentHash,
      code: sealed.code,
      rawPayload: sealed.rawPayload,
      receivedAt: parsed.sms.receivedAt,
      createdAt: now,
      encrypted: sealed.encrypted,
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await duplicateResponse(env, device.id, contentHash, now, contentKey);
    if (raced) return raced;
    throw error;
  }

  await touchDevice(env.DB, device.id, now);
  logInfo({ message: "sms_stored", device_id: device.id, message_id: id, has_code: code !== null });
  scheduleNotify(ctx, () =>
    notifyStoredSms(env, device.user_id, {
      from: parsed.sms.from,
      content: parsed.sms.content,
      code,
      deviceName: device.name,
      receivedAt: parsed.sms.receivedAt,
    }),
  );
  return json({ ok: true, id, code });
}

async function duplicateResponse(
  env: Env,
  deviceId: string,
  contentHash: string,
  now: number,
  contentKey: ReturnType<typeof resolveContentKey>,
): Promise<Response | null> {
  const existing = await findMessageByHash(env.DB, contentHash);
  if (!existing) return null;
  const code = await revealCode(contentKey, existing.code, existing.encrypted === 1);
  await touchDevice(env.DB, deviceId, now);
  logInfo({
    message: "sms_duplicate",
    device_id: deviceId,
    message_id: existing.id,
    has_code: code !== null,
  });
  return json({ ok: true, id: existing.id, code, duplicate: true });
}
