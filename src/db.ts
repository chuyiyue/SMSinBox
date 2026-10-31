import { revealCode, revealRaw, revealText, type ContentKey } from "./crypto";
import { logInfo } from "./log";
import { readRawMeta } from "./parse";
import { messageMatchesQuery } from "./search";
import type {
  DeviceRecord,
  DeviceView,
  MessageRecord,
  MessageView,
  NotifyChannelRow,
  SessionUser,
  UserAccount,
  UserRecord,
} from "./types";

export const RATE_LIMIT_PER_MINUTE = 60;
export const MAX_DEVICES = 50;
export const ENCRYPTED_SEARCH_LIMIT = 500;

const MESSAGE_COLUMNS = `m.id, m.device_id, d.name AS device_name, m.from_number, m.to_number,
              m.content, m.code, m.raw_payload, m.received_at, m.created_at, m.encrypted`;

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
    .prepare(
      "SELECT id, username, password_hash, role, disabled_at, created_at FROM users WHERE username = ?",
    )
    .bind(username)
    .first<UserRecord>();
}

export async function findUserById(db: D1Database, userId: string): Promise<UserAccount | null> {
  return db
    .prepare("SELECT id, username, role, disabled_at, created_at FROM users WHERE id = ?")
    .bind(userId)
    .first<UserAccount>();
}

export async function listUsers(db: D1Database): Promise<UserAccount[]> {
  const result = await db
    .prepare("SELECT id, username, role, disabled_at, created_at FROM users ORDER BY created_at ASC")
    .all<UserAccount>();
  return result.results;
}

export async function countEnabledAdmins(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND disabled_at IS NULL")
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function countAdmins(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'admin'")
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function insertUser(
  db: D1Database,
  user: { id: string; username: string; passwordHash: string; role: "admin" | "member"; createdAt: number },
): Promise<void> {
  await db
    .prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(user.id, user.username, user.passwordHash, user.role, user.createdAt)
    .run();
}

export async function updatePasswordHash(db: D1Database, userId: string, passwordHash: string): Promise<void> {
  await db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(passwordHash, userId).run();
}

export async function ensureAdmin(db: D1Database, userId: string): Promise<void> {
  await db.prepare("UPDATE users SET role = 'admin', disabled_at = NULL WHERE id = ?").bind(userId).run();
}

export async function setUserRole(db: D1Database, userId: string, role: "admin" | "member"): Promise<void> {
  await db.prepare("UPDATE users SET role = ? WHERE id = ?").bind(role, userId).run();
}

export async function setUserDisabledAt(db: D1Database, userId: string, disabledAt: number | null): Promise<void> {
  await db.prepare("UPDATE users SET disabled_at = ? WHERE id = ?").bind(disabledAt, userId).run();
}

export async function deleteUserSessions(db: D1Database, userId: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
}

export async function deleteUserCascade(db: D1Database, userId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM rate_limits WHERE token_hash IN (SELECT token_hash FROM devices WHERE user_id = ?)").bind(userId),
    db.prepare("DELETE FROM messages WHERE device_id IN (SELECT id FROM devices WHERE user_id = ?)").bind(userId),
    db.prepare("DELETE FROM devices WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM notify_channels WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
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
      `SELECT u.id AS id, u.username AS username, u.role AS role, u.disabled_at AS disabled_at,
              s.expires_at AS expires_at
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

export async function findDeviceForUser(
  db: D1Database,
  userId: string,
  deviceId: string,
): Promise<{ id: string; name: string } | null> {
  return db
    .prepare("SELECT id, name FROM devices WHERE id = ? AND user_id = ?")
    .bind(deviceId, userId)
    .first<{ id: string; name: string }>();
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

export async function countNotifyChannels(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS total FROM notify_channels WHERE user_id = ?")
    .bind(userId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function listNotifyChannels(db: D1Database, userId: string): Promise<NotifyChannelRow[]> {
  const result = await db
    .prepare(
      `SELECT id, user_id, kind, config, enabled, created_at
       FROM notify_channels
       WHERE user_id = ?
       ORDER BY created_at DESC`,
    )
    .bind(userId)
    .all<NotifyChannelRow>();
  return result.results;
}

export async function findNotifyChannel(
  db: D1Database,
  userId: string,
  channelId: string,
): Promise<NotifyChannelRow | null> {
  return db
    .prepare(
      `SELECT id, user_id, kind, config, enabled, created_at
       FROM notify_channels WHERE id = ? AND user_id = ?`,
    )
    .bind(channelId, userId)
    .first<NotifyChannelRow>();
}

export async function insertNotifyChannel(
  db: D1Database,
  channel: { id: string; userId: string; kind: string; config: string; enabled: number; createdAt: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO notify_channels (id, user_id, kind, config, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(channel.id, channel.userId, channel.kind, channel.config, channel.enabled, channel.createdAt)
    .run();
}

export async function deleteNotifyChannel(db: D1Database, userId: string, channelId: string): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM notify_channels WHERE id = ? AND user_id = ?")
    .bind(channelId, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function setNotifyChannelEnabled(
  db: D1Database,
  userId: string,
  channelId: string,
  enabled: boolean,
): Promise<boolean> {
  const result = await db
    .prepare("UPDATE notify_channels SET enabled = ? WHERE id = ? AND user_id = ?")
    .bind(enabled ? 1 : 0, channelId, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function findMessageByHash(
  db: D1Database,
  contentHash: string,
): Promise<{ id: string; code: string | null; encrypted: number } | null> {
  return db
    .prepare("SELECT id, code, encrypted FROM messages WHERE content_hash = ?")
    .bind(contentHash)
    .first<{ id: string; code: string | null; encrypted: number }>();
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
    encrypted: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO messages (
         id, device_id, from_number, to_number, content, content_hash, code, raw_payload,
         received_at, created_at, encrypted
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      message.encrypted,
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
    text: string | null;
    limit: number;
    offset: number;
    contentKey: ContentKey;
  },
): Promise<{ total: number; messages: MessageView[]; searchTruncated: boolean }> {
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
  // Ciphertext cannot be matched with SQL LIKE. Scan a bounded recent window and filter after decrypt.
  if (query.contentKey.state === "on" && query.text) {
    const scanned = await db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS}
         FROM messages m
         JOIN devices d ON d.id = m.device_id
         WHERE ${where.join(" AND ")}
         ORDER BY m.received_at DESC, m.created_at DESC
         LIMIT ?`,
      )
      .bind(...binds, ENCRYPTED_SEARCH_LIMIT)
      .all<MessageRecord>();
    const revealed = await revealRows(scanned.results, query.contentKey);
    const matched = revealed.filter((message) => messageMatchesQuery(message, query.text ?? ""));
    return {
      total: matched.length,
      messages: matched.slice(query.offset, query.offset + query.limit),
      searchTruncated: scanned.results.length >= ENCRYPTED_SEARCH_LIMIT,
    };
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
      `SELECT ${MESSAGE_COLUMNS}
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
    messages: await revealRows(listed.results, query.contentKey),
    searchTruncated: false,
  };
}

export async function listMessagesSince(
  db: D1Database,
  query: { userId: string; createdAt: number; id: string; limit: number; contentKey: ContentKey },
): Promise<MessageView[]> {
  // Same ordering contract as isAfterCursor: created_at, then id.
  const listed = await db
    .prepare(
      `SELECT ${MESSAGE_COLUMNS}
       FROM messages m
       JOIN devices d ON d.id = m.device_id
       WHERE d.user_id = ?
         AND (m.created_at > ? OR (m.created_at = ? AND m.id > ?))
       ORDER BY m.created_at ASC, m.id ASC
       LIMIT ?`,
    )
    .bind(query.userId, query.createdAt, query.createdAt, query.id, query.limit)
    .all<MessageRecord>();
  return revealRows(listed.results, query.contentKey);
}

export async function getMessage(
  db: D1Database,
  userId: string,
  messageId: string,
  contentKey: ContentKey,
): Promise<MessageView | null> {
  const row = await db
    .prepare(
      `SELECT ${MESSAGE_COLUMNS}
       FROM messages m
       JOIN devices d ON d.id = m.device_id
       WHERE m.id = ? AND d.user_id = ?`,
    )
    .bind(messageId, userId)
    .first<MessageRecord>();
  return row ? revealMessage(row, contentKey) : null;
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

async function revealRows(rows: MessageRecord[], key: ContentKey): Promise<MessageView[]> {
  const views: MessageView[] = [];
  for (const row of rows) views.push(await revealMessage(row, key));
  return views;
}

async function revealMessage(row: MessageRecord, key: ContentKey): Promise<MessageView> {
  const encrypted = row.encrypted === 1;
  const raw = await revealRaw(key, row.raw_payload, encrypted);
  const meta = readRawMeta(raw);
  return {
    id: row.id,
    device_id: row.device_id,
    device_name: row.device_name,
    from_number: row.from_number,
    to_number: row.to_number,
    content: await revealText(key, row.content, encrypted),
    code: await revealCode(key, row.code, encrypted),
    sim: meta.sim,
    reported_device: meta.device,
    received_at: row.received_at,
    created_at: row.created_at,
  };
}
