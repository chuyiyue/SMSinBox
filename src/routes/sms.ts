import { readBearer, secretsEqual, sha256Hex } from "../auth";
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
  readAdminTranslateEnabled,
  touchDevice,
} from "../db";
import { recognizeCode } from "../code-recognition";
import { json, MAX_BODY_BYTES, readLimitedBytes } from "../http";
import { errorText, logError, logInfo } from "../log";
import { translateSmsContent } from "../translate";
import { notifyStoredSms, scheduleNotify } from "../notify";
import { buildRawPayload, parseSmsPayload } from "../parse";
import type { DeviceRecord } from "../types";

const INGEST_PREFIX = "/api/v1/ingest/";
// Legacy secrets are "psh_" + base64url; current secrets are 32 lowercase
// hex characters (symbol-free). Both stay valid until the device rotates.
const PUSH_TOKEN_PATTERN = /^(?:psh_[A-Za-z0-9_-]+|[0-9a-f]{32})$/;

export function buildTestSms(nonce: string): string {
  return `SMSinBox 测试短信。验证码 654321。序号 ${nonce}`;
}

// Reject before hashing. The charset is either the legacy psh_ base64url
// shape or the current 32-hex shape, and the length cap matches readBearer
// so a huge path never becomes a SHA-256 input.
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
  const auth = await authenticateDevice(env, token, now);
  if (auth instanceof Response) return auth;
  return storeSms(request, env, ctx, auth.device, bytes, auth.rateKey, now);
}

type DeviceAuth = { device: DeviceRecord; rateKey: string; mode: "jwt" | "legacy" };

// Two credentials coexist during the migration window:
//   - system-signed JWT (new devices; no per-device secret, no HMAC)
//   - legacy random Bearer token
// The JWT path is checked first. A device row is the source of truth, so
// deleting the device (or changing token_version/token_hash) revokes it.
async function authenticateDevice(
  env: Env,
  token: string,
  now: number,
): Promise<DeviceAuth | Response> {
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
    // Rate limits use the stored credential hash, the same value deleteDevice
    // clears, so a deleted device cannot leave a live window behind. A fresh
    // jti (token rotation) naturally starts a fresh window.
    return { device, rateKey: tokenHash, mode: "jwt" };
  }

  const tokenHash = await sha256Hex(token);
  const device = await findDeviceByTokenHash(env.DB, tokenHash);
  if (!device) return json({ ok: false, error: "设备 token 无效" }, 401);
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
  // Bearer cannot choose a different device.
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

  const recognized = await recognizeCode(env, parsed.sms.content);
  const code = recognized.code;
  const translation = await loadTranslation(env, parsed.sms.content);
  const sealed = await sealMessage(contentKey, {
    content: parsed.sms.content,
    code,
    rawPayload: buildRawPayload(bodyText, parsed.sms),
    translatedContent: translation?.translated ?? null,
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
      codeSource: recognized.source,
      rawPayload: sealed.rawPayload,
      receivedAt: parsed.sms.receivedAt,
      createdAt: now,
      encrypted: sealed.encrypted,
      translatedContent: sealed.translatedContent,
      sourceLang: translation?.sourceLang ?? null,
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await duplicateResponse(env, device.id, contentHash, now, contentKey);
    if (raced) return raced;
    throw error;
  }

  await touchDevice(env.DB, device.id, now);
  logInfo({
    message: "sms_stored",
    device_id: device.id,
    message_id: id,
    has_code: code !== null,
    code_source: recognized.source,
    translated: translation !== null,
    source_lang: translation?.sourceLang ?? null,
  });
  scheduleNotify(ctx, () =>
    notifyStoredSms(env, device.user_id, {
      messageId: id,
      from: parsed.sms.from,
      content: parsed.sms.content,
      code,
      deviceName: device.name,
      receivedAt: parsed.sms.receivedAt,
      translatedContent: translation?.translated ?? null,
      sourceLang: translation?.sourceLang ?? null,
    }),
  );
  return json({ ok: true, id, code });
}

// Preference lookup and the model call both fail closed. A throw, a timeout,
// or a rejected translation leaves the two columns null and still stores the SMS.
async function loadTranslation(
  env: Env,
  content: string,
): Promise<{ translated: string; sourceLang: string } | null> {
  try {
    const enabled = await readAdminTranslateEnabled(env.DB);
    if (!enabled) return null;
    return await translateSmsContent(env, content);
  } catch (error) {
    logError({ message: "sms_translate_failed", error: errorText(error) });
    return null;
  }
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
