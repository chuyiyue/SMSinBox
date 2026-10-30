import {
  readBearer,
  sha256Hex,
  verifyHmacSignature,
} from "../auth";
import { dedupHash } from "../dedup";
import {
  consumeRateLimit,
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
import { buildRawPayload, parseSmsPayload } from "../parse";

export async function handleSms(request: Request, env: Env): Promise<Response> {
  const bytes = await readLimitedBytes(request, MAX_BODY_BYTES);
  if (bytes === null) return json({ ok: false, error: "请求体过大" }, 413);

  const token = readBearer(request.headers.get("authorization"));
  if (!token) return json({ ok: false, error: "缺少设备 token" }, 401);
  const tokenHash = await sha256Hex(token);
  const device = await findDeviceByTokenHash(env.DB, tokenHash);
  if (!device) return json({ ok: false, error: "设备 token 无效" }, 401);

  const now = Date.now();
  const signature = request.headers.get("x-signature");
  const timestamp = request.headers.get("x-timestamp");
  if (device.secret) {
    if (!signature || !timestamp) return json({ ok: false, error: "该设备要求 HMAC 签名" }, 401);
    const valid = await verifyHmacSignature({
      secret: device.secret,
      timestamp,
      body: bytes,
      signature,
      now,
    });
    if (!valid) return json({ ok: false, error: "签名无效" }, 401);
  } else if (signature || timestamp) {
    return json({ ok: false, error: "该设备未启用签名" }, 401);
  }

  const hits = await consumeRateLimit(env.DB, tokenHash, now);
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
  const duplicate = await duplicateResponse(env, device.id, contentHash, now);
  if (duplicate) return duplicate;

  const code = extractCode(parsed.sms.content);
  const id = crypto.randomUUID();
  try {
    await insertMessage(env.DB, {
      id,
      deviceId: device.id,
      from: parsed.sms.from,
      to: parsed.sms.to,
      content: parsed.sms.content,
      contentHash,
      code,
      rawPayload: buildRawPayload(bodyText, parsed.sms),
      receivedAt: parsed.sms.receivedAt,
      createdAt: now,
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await duplicateResponse(env, device.id, contentHash, now);
    if (raced) return raced;
    throw error;
  }

  await touchDevice(env.DB, device.id, now);
  logInfo({ message: "sms_stored", device_id: device.id, message_id: id, has_code: code !== null });
  return json({ ok: true, id, code });
}

async function duplicateResponse(
  env: Env,
  deviceId: string,
  contentHash: string,
  now: number,
): Promise<Response | null> {
  const existing = await findMessageByHash(env.DB, contentHash);
  if (!existing) return null;
  await touchDevice(env.DB, deviceId, now);
  logInfo({
    message: "sms_duplicate",
    device_id: deviceId,
    message_id: existing.id,
    has_code: existing.code !== null,
  });
  return json({ ok: true, id: existing.id, code: existing.code, duplicate: true });
}
