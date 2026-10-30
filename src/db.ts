import { logInfo } from "./log";
import { readRawMeta } from "./parse";
import type { DeviceRecord, DeviceView, MessageRecord, MessageView, SessionUser, UserRecord } from "./types";

export const RATE_LIMIT_PER_MINUTE = 60;
export const MAX_DEVICES = 50;

export function retentionDays(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3650) return 90;
  return parsed;
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed");
}

export async function countUsers(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS total FROM users").first<{ total: number }>();
  return row?.total ?? 0;
}

export async function findUserByUsername(db: D1Database, username: string): Promise<UserRecord | null> {
  return db
    .prepare("SELECT id, username, password_hash, created_at FROM users WHERE username = ?")
    .bind(username)
    .first<UserRecord>();
}

export async function insertUser(
  db: D1Database,
  user: { id: string; username: string; passwordHash: string; createdAt: number },
): Promise<void> {
  await db
    .prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)")
    .bind(user.id, user.username, user.passwordHash, user.createdAt)
    .run();
}

export async function updatePasswordHash(db: D1Database, userId: string, passwordHash: string): Promise<void> {
  await db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(passwordHash, userId).run();
}

export async function createSession(
  db: D1Database,
  session: { id: string; userId: string; expiresAt: number; createdAt: number },
): Promise<void> {
  await db
    .prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(session.id, session.userId, session.expiresAt, session.createdAt)
    .run();
}

export async function findSessionUser(db: D1Database, sessionHash: string): Promise<SessionUser | null> {
  return db
    .prepare(
      `SELECT u.id AS id, u.username AS username, s.expires_at AS expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`,
    )
    .bind(sessionHash)
    .first<SessionUser>();
}

export async function deleteSession(db: D1Database, sessionHash: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionHash).run();
}

export async function findDeviceByTokenHash(db: D1Database, tokenHash: string): Promise<DeviceRecord | null> {
  return db
    .prepare(
      `SELECT id, user_id, name, token_hash, secret, last_seen_at, created_at
       FROM devices WHERE token_hash = ?`,
    )
    .bind(tokenHash)
    .first<DeviceRecord>();
}

export async function touchDevice(db: D1Database, deviceId: string, seenAt: number): Promise<void> {
  await db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").bind(seenAt, deviceId).run();
}

export async function consumeRateLimit(db: D1Database, tokenHash: string, now: number): Promise<number> {
  const windowStart = Math.floor(now / 60_000) * 60_000;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (token_hash, window_start, count)
       VALUES (?, ?, 1)
       ON CONFLICT(token_hash, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(tokenHash, windowStart)
    .first<{ count: number }>();
  return row?.count ?? 1;
}

export async function countDevices(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS total FROM devices WHERE user_id = ?")
    .bind(userId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function listDevices(db: D1Database, userId: string): Promise<DeviceView[]> {
  const result = await db
    .prepare(
      `SELECT id, name, created_at, last_seen_at, secret
       FROM devices WHERE user_id = ?
       ORDER BY created_at DESC`,
    )
    .bind(userId)
    .all<{ id: string; name: string; created_at: number; last_seen_at: number | null; secret: string | null }>();
  return result.results.map((row) => ({
    id: row.id,
    name: row.name,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    has_secret: Boolean(row.secret),
  }));
}

export async function insertDevice(
  db: D1Database,
  device: { id: string; userId: string; name: string; tokenHash: string; secret: string | null; createdAt: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO devices (id, user_id, name, token_hash, secret, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    )
    .bind(device.id, device.userId, device.name, device.tokenHash, device.secret, device.createdAt)
    .run();
}

export async function deleteDevice(db: D1Database, userId: string, deviceId: string): Promise<boolean> {
  const owned = await db
    .prepare("SELECT id FROM devices WHERE id = ? AND user_id = ?")
    .bind(deviceId, userId)
    .first<{ id: string }>();
  if (!owned) return false;
  await db.batch([
    db.prepare("DELETE FROM messages WHERE device_id = ?").bind(deviceId),
    db.prepare("DELETE FROM devices WHERE id = ? AND user_id = ?").bind(deviceId, userId),
  ]);
  return true;
}

export async function findMessageByHash(
  db: D1Database,
  contentHash: string,
): Promise<{ id: string; code: string | null } | null> {
  return db
    .prepare("SELECT id, code FROM messages WHERE content_hash = ?")
    .bind(contentHash)
    .first<{ id: string; code: string | null }>();
}

export async function insertMessage(
  db: D1Database,
  message: {
    id: string;
    deviceId: string;
    from: string;
    to: string;
    content: string;
    contentHash: string;
    code: string | null;
    rawPayload: string;
    receivedAt: number;
    createdAt: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO messages (
         id, device_id, from_number, to_number, content, content_hash, code, raw_payload, received_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      message.id,
      message.deviceId,
      message.from,
      message.to,
      message.content,
      message.contentHash,
      message.code,
      message.rawPayload,
      message.receivedAt,
      message.createdAt,
    )
    .run();
}

export async function listMessages(
  db: D1Database,
  query: {
    userId: string;
    deviceId: string | null;
    from: string | null;
    like: string | null;
    limit: number;
    offset: number;
  },
): Promise<{ total: number; messages: MessageView[] }> {
  const where = ["d.user_id = ?"];
  const binds: Array<string | number> = [query.userId];
  if (query.deviceId) {
    where.push("m.device_id = ?");
    binds.push(query.deviceId);
  }
  if (query.from) {
    where.push("m.from_number = ?");
    binds.push(query.from);
  }
  if (query.like) {
    where.push(
      "(m.content LIKE ? ESCAPE ? OR m.from_number LIKE ? ESCAPE ? OR IFNULL(m.code, '') LIKE ? ESCAPE ?)",
    );
    binds.push(query.like, "\\", query.like, "\\", query.like, "\\");
  }
  const whereSql = where.join(" AND ");
  const totalRow = await db
    .prepare(
      `SELECT COUNT(*) AS total
       FROM messages m
       JOIN devices d ON d.id = m.device_id
       WHERE ${whereSql}`,
    )
    .bind(...binds)
    .first<{ total: number }>();
  const listed = await db
    .prepare(
      `SELECT m.id, m.device_id, d.name AS device_name, m.from_number, m.to_number,
              m.content, m.code, m.raw_payload, m.received_at, m.created_at
       FROM messages m
       JOIN devices d ON d.id = m.device_id
       WHERE ${whereSql}
       ORDER BY m.received_at DESC, m.created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(...binds, query.limit, query.offset)
    .all<MessageRecord>();
  return {
    total: totalRow?.total ?? 0,
    messages: listed.results.map(toMessageView),
  };
}

export async function getMessage(db: D1Database, userId: string, messageId: string): Promise<MessageView | null> {
  const row = await db
    .prepare(
      `SELECT m.id, m.device_id, d.name AS device_name, m.from_number, m.to_number,
              m.content, m.code, m.raw_payload, m.received_at, m.created_at
       FROM messages m
       JOIN devices d ON d.id = m.device_id
       WHERE m.id = ? AND d.user_id = ?`,
    )
    .bind(messageId, userId)
    .first<MessageRecord>();
  return row ? toMessageView(row) : null;
}

export async function purgeExpired(db: D1Database, now: number, retention: string): Promise<void> {
  const days = retentionDays(retention);
  const messageCutoff = now - days * 24 * 60 * 60 * 1000;
  const rateCutoff = now - 2 * 24 * 60 * 60 * 1000;
  const messages = await db.prepare("DELETE FROM messages WHERE created_at < ?").bind(messageCutoff).run();
  const sessions = await db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run();
  const rates = await db.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(rateCutoff).run();
  logInfo({
    message: "retention_complete",
    retention_days: days,
    messages: messages.meta.changes,
    sessions: sessions.meta.changes,
    rate_limits: rates.meta.changes,
  });
}

function toMessageView(row: MessageRecord): MessageView {
  const meta = readRawMeta(row.raw_payload);
  return {
    id: row.id,
    device_id: row.device_id,
    device_name: row.device_name,
    from_number: row.from_number,
    to_number: row.to_number,
    content: row.content,
    code: row.code,
    sim: meta.sim,
    reported_device: meta.device,
    received_at: row.received_at,
    created_at: row.created_at,
  };
}
