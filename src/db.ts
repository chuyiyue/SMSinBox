import { sha256Hex } from "./auth";
import { revealCode, revealRaw, revealText, type ContentKey } from "./crypto";
import { logInfo } from "./log";
import { readRawMeta } from "./parse";
import { messageMatchesQuery } from "./search";
import type {
  ApiTokenRecord,
  CodeSource,
  DeviceRecord,
  DeviceView,
  ListedSession,
  MessageRecord,
  MessageView,
  NotifyChannelRow,
  PushState,
  SessionUser,
  TotpTicketRecord,
  TotpUserRecord,
  UserAccount,
  UserRecord,
} from "./types";

export const RATE_LIMIT_PER_MINUTE = 60;
export const MAX_DEVICES = 50;
export const ENCRYPTED_SEARCH_LIMIT = 500;

const MESSAGE_COLUMNS = `m.id, m.device_id, d.name AS device_name, m.from_number, m.to_number,
              m.content, m.code, m.code_source, m.raw_payload, m.received_at, m.created_at, m.encrypted`;

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

export async function findUserRecordById(db: D1Database, userId: string): Promise<UserRecord | null> {
  return db
    .prepare(
      "SELECT id, username, password_hash, role, disabled_at, created_at FROM users WHERE id = ?",
    )
    .bind(userId)
    .first<UserRecord>();
}

// Login resolves the single administrator from this list. The password hash is
// needed because there is no username to look up any more.
export async function listUserRecords(db: D1Database): Promise<UserRecord[]> {
  const result = await db
    .prepare(
      "SELECT id, username, password_hash, role, disabled_at, created_at FROM users ORDER BY created_at ASC",
    )
    .all<UserRecord>();
  return result.results;
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

export async function updateUsername(db: D1Database, userId: string, username: string): Promise<void> {
  await db.prepare("UPDATE users SET username = ? WHERE id = ?").bind(username, userId).run();
}

export async function ensureAdmin(db: D1Database, userId: string): Promise<void> {
  await db.prepare("UPDATE users SET role = 'admin', disabled_at = NULL WHERE id = ?").bind(userId).run();
}

export const SINGLE_USER_MERGED_KEY = "single_user_merged_at";

export type SingleUserMergeResult = "merged" | "already" | "skipped" | "aborted";

function isMissingSchemaMeta(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table:?\s*schema_meta/i.test(message);
}

// Move other people's devices and notify channels onto the configured admin,
// then drop their sessions and user rows. Never call deleteUserCascade: that
// path deletes messages. Tokens and push hashes are left unchanged.
export async function mergeIntoAdmin(
  db: D1Database,
  target: { id: string; role: string },
): Promise<SingleUserMergeResult> {
  if (target.role !== "admin" || target.id.length === 0) return "aborted";
  let marker: { value: string } | null;
  try {
    marker = await db
      .prepare("SELECT value FROM schema_meta WHERE key = ?")
      .bind(SINGLE_USER_MERGED_KEY)
      .first<{ value: string }>();
  } catch (error) {
    if (isMissingSchemaMeta(error)) return "skipped";
    throw error;
  }
  if (marker?.value) return "already";
  try {
    await db.batch([
      db.prepare("UPDATE devices SET user_id = ? WHERE user_id <> ?").bind(target.id, target.id),
      db.prepare("UPDATE notify_channels SET user_id = ? WHERE user_id <> ?").bind(target.id, target.id),
      db.prepare("DELETE FROM sessions WHERE user_id <> ?").bind(target.id),
      db.prepare("DELETE FROM users WHERE id <> ?").bind(target.id),
      db.prepare("INSERT INTO schema_meta (key, value) VALUES (?, ?)").bind(SINGLE_USER_MERGED_KEY, String(Date.now())),
    ]);
  } catch (error) {
    if (isMissingSchemaMeta(error)) return "skipped";
    if (isUniqueViolation(error)) return "already";
    throw error;
  }
  logInfo({ message: "single_user_merged", user_id: target.id });
  return "merged";
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

// Removes this user's messages and devices. The single-user merge must not call it.
export async function deleteUserCascade(db: D1Database, userId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM rate_limits WHERE token_hash IN (SELECT token_hash FROM devices WHERE user_id = ?)").bind(userId),
    db.prepare(
      "DELETE FROM rate_limits WHERE token_hash IN (SELECT push_token_hash FROM devices WHERE user_id = ? AND push_token_hash IS NOT NULL)",
    ).bind(userId),
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
              u.totp_enabled_at AS totp_enabled_at, s.expires_at AS expires_at
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

export async function listUserSessions(db: D1Database, userId: string, now: number): Promise<ListedSession[]> {
  const result = await db
    .prepare(
      `SELECT id, created_at, expires_at
       FROM sessions
       WHERE user_id = ? AND expires_at > ?
       ORDER BY created_at DESC, id ASC`,
    )
    .bind(userId, now)
    .all<ListedSession>();
  return result.results;
}

export async function deleteUserSessionById(db: D1Database, userId: string, sessionId: string): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM sessions WHERE user_id = ? AND id = ?")
    .bind(userId, sessionId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function deleteOtherUserSessions(db: D1Database, userId: string, keepSessionId: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE user_id = ? AND id <> ?").bind(userId, keepSessionId).run();
}

// Same statement as deleteOtherUserSessions. TOTP disable keeps the session
// that just proved the second factor and drops every other one.
export async function deleteUserSessionsExcept(db: D1Database, userId: string, keepHash: string): Promise<void> {
  await deleteOtherUserSessions(db, userId, keepHash);
}

export async function findTotpUser(db: D1Database, userId: string): Promise<TotpUserRecord | null> {
  return db
    .prepare(
      `SELECT id, username, role, disabled_at, password_hash,
              totp_secret, totp_pending_secret, totp_pending_created_at, totp_enabled_at, totp_last_counter
       FROM users WHERE id = ?`,
    )
    .bind(userId)
    .first<TotpUserRecord>();
}

export async function setTotpPending(
  db: D1Database,
  userId: string,
  sealedSecret: string,
  createdAt: number,
): Promise<void> {
  await db
    .prepare("UPDATE users SET totp_pending_secret = ?, totp_pending_created_at = ? WHERE id = ?")
    .bind(sealedSecret, createdAt, userId)
    .run();
}

// Promotes the pending secret. The enrollment code is deliberately not stored
// as totp_last_counter: the operator may log in again inside the same 30s step.
export async function enableTotp(db: D1Database, userId: string, enabledAt: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE users
       SET totp_secret = totp_pending_secret,
           totp_enabled_at = ?,
           totp_last_counter = NULL,
           totp_pending_secret = NULL,
           totp_pending_created_at = NULL
       WHERE id = ? AND totp_pending_secret IS NOT NULL`,
    )
    .bind(enabledAt, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function clearTotp(db: D1Database, userId: string): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE users
         SET totp_secret = NULL, totp_pending_secret = NULL, totp_pending_created_at = NULL,
             totp_enabled_at = NULL, totp_last_counter = NULL
         WHERE id = ?`,
      )
      .bind(userId),
    db.prepare("DELETE FROM totp_recovery_codes WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM totp_tickets WHERE user_id = ?").bind(userId),
  ]);
}

// Rejects a code that maps to an already accepted (or older) step.
export async function advanceTotpCounter(db: D1Database, userId: string, counter: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE users SET totp_last_counter = ?
       WHERE id = ? AND (totp_last_counter IS NULL OR totp_last_counter < ?)`,
    )
    .bind(counter, userId, counter)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function replaceRecoveryCodes(
  db: D1Database,
  userId: string,
  hashes: string[],
  createdAt: number,
): Promise<void> {
  const statements = [db.prepare("DELETE FROM totp_recovery_codes WHERE user_id = ?").bind(userId)];
  for (const hash of hashes) {
    statements.push(
      db
        .prepare(
          `INSERT INTO totp_recovery_codes (id, user_id, code_hash, created_at, used_at)
           VALUES (?, ?, ?, ?, NULL)`,
        )
        .bind(crypto.randomUUID(), userId, hash, createdAt),
    );
  }
  await db.batch(statements);
}

export async function consumeRecoveryCode(
  db: D1Database,
  userId: string,
  codeHash: string,
  usedAt: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE totp_recovery_codes SET used_at = ?
       WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`,
    )
    .bind(usedAt, userId, codeHash)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function countRecoveryCodes(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS total FROM totp_recovery_codes WHERE user_id = ? AND used_at IS NULL")
    .bind(userId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function createTotpTicket(
  db: D1Database,
  ticket: { id: string; userId: string; expiresAt: number; createdAt: number },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO totp_tickets (id, user_id, expires_at, attempts, created_at) VALUES (?, ?, ?, 0, ?)",
    )
    .bind(ticket.id, ticket.userId, ticket.expiresAt, ticket.createdAt)
    .run();
}

export async function findTotpTicket(db: D1Database, ticketHash: string): Promise<TotpTicketRecord | null> {
  return db
    .prepare(
      `SELECT t.id AS id, t.user_id AS user_id, t.expires_at AS expires_at, t.attempts AS attempts,
              t.created_at AS created_at, u.username AS username, u.role AS role,
              u.disabled_at AS disabled_at, u.totp_secret AS totp_secret,
              u.totp_enabled_at AS totp_enabled_at, u.totp_last_counter AS totp_last_counter
       FROM totp_tickets t
       JOIN users u ON u.id = t.user_id
       WHERE t.id = ?`,
    )
    .bind(ticketHash)
    .first<TotpTicketRecord>();
}

export async function recordTotpAttempt(db: D1Database, ticketHash: string): Promise<number> {
  const row = await db
    .prepare("UPDATE totp_tickets SET attempts = attempts + 1 WHERE id = ? RETURNING attempts")
    .bind(ticketHash)
    .first<{ attempts: number }>();
  return row?.attempts ?? 1;
}

export async function deleteTotpTicket(db: D1Database, ticketHash: string): Promise<void> {
  await db.prepare("DELETE FROM totp_tickets WHERE id = ?").bind(ticketHash).run();
}

export async function deleteUserTotpTickets(db: D1Database, userId: string): Promise<void> {
  await db.prepare("DELETE FROM totp_tickets WHERE user_id = ?").bind(userId).run();
}

export function pushState(hash: string | null | undefined, revokedAt: number | null | undefined): PushState {
  if (hash == null || hash === "") return "none";
  if (revokedAt != null) return "revoked";
  return "active";
}

export async function findDeviceByTokenHash(db: D1Database, tokenHash: string): Promise<DeviceRecord | null> {
  return db
    .prepare(
      `SELECT id, user_id, name, platform, token_hash, token_version, last_seen_at, created_at
       FROM devices WHERE token_hash = ?`,
    )
    .bind(tokenHash)
    .first<DeviceRecord>();
}

export async function findDeviceById(db: D1Database, deviceId: string): Promise<DeviceRecord | null> {
  return db
    .prepare(
      `SELECT id, user_id, name, platform, token_hash, token_version, last_seen_at, created_at,
              push_token_hash, push_revoked_at
       FROM devices WHERE id = ?`,
    )
    .bind(deviceId)
    .first<DeviceRecord>();
}

export async function findDeviceByPushTokenHash(db: D1Database, pushTokenHash: string): Promise<DeviceRecord | null> {
  return db
    .prepare(
      `SELECT id, user_id, name, platform, token_hash, token_version, last_seen_at, created_at,
              push_token_hash, push_revoked_at
       FROM devices WHERE push_token_hash = ?`,
    )
    .bind(pushTokenHash)
    .first<DeviceRecord>();
}

export async function touchDevice(db: D1Database, deviceId: string, seenAt: number): Promise<void> {
  await db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").bind(seenAt, deviceId).run();
}

export async function consumeRateLimit(db: D1Database, tokenHash: string, now: number): Promise<number> {
  return consumeRateLimitWindow(db, tokenHash, now, 60_000);
}

// Same table, but callers that need a long window (login failures, second
// factor guesses) pass it explicitly instead of resetting every minute.
export async function consumeRateLimitWindow(
  db: D1Database,
  tokenHash: string,
  now: number,
  windowMs: number,
): Promise<number> {
  const windowStart = rateLimitWindowStart(now, windowMs);
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

// Login and current-password failures share rate_limits with ingest.
// Keys are `login:user|ip|account:` plus a SHA-256, so they cannot collide
// with a device token hash. The window is 15 minutes, not one minute.
export const LOGIN_FAILURE_LIMIT = 8;
export const LOGIN_IP_FAILURE_LIMIT = 30;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export function rateLimitWindowStart(now: number, windowMs: number): number {
  return Math.floor(now / windowMs) * windowMs;
}

export function rateLimitRetryAfterSeconds(now: number, windowMs: number): number {
  const end = rateLimitWindowStart(now, windowMs) + windowMs;
  return Math.max(1, Math.ceil((end - now) / 1000));
}

export function loginWindowStart(now: number): number {
  return rateLimitWindowStart(now, LOGIN_WINDOW_MS);
}

export function loginRetryAfterSeconds(now: number): number {
  return rateLimitRetryAfterSeconds(now, LOGIN_WINDOW_MS);
}

export async function loginRateKey(kind: "user" | "ip" | "account", value: string): Promise<string> {
  return `login:${kind}:${await sha256Hex(value)}`;
}

export async function loginAttemptCount(db: D1Database, key: string, now: number): Promise<number> {
  const row = await db
    .prepare("SELECT count FROM rate_limits WHERE token_hash = ? AND window_start = ?")
    .bind(key, loginWindowStart(now))
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function recordLoginFailure(db: D1Database, key: string, now: number): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (token_hash, window_start, count)
       VALUES (?, ?, 1)
       ON CONFLICT(token_hash, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(key, loginWindowStart(now))
    .first<{ count: number }>();
  return row?.count ?? 1;
}

export async function clearRateLimitWindow(
  db: D1Database,
  key: string,
  now: number,
  windowMs: number,
): Promise<void> {
  await db
    .prepare("DELETE FROM rate_limits WHERE token_hash = ? AND window_start = ?")
    .bind(key, rateLimitWindowStart(now, windowMs))
    .run();
}

export async function clearLoginFailures(db: D1Database, key: string, now: number): Promise<void> {
  await clearRateLimitWindow(db, key, now, LOGIN_WINDOW_MS);
}

// Every endpoint that re-checks the current password (rename, password change,
// turning two-factor off, new recovery codes) shares one `login:account:`
// budget. The key is separate from `login:user:`/`login:ip:`, so a stolen
// session cannot lock the owner out of the login form.
export async function accountPasswordLimited(db: D1Database, userId: string, now: number): Promise<boolean> {
  return (await loginAttemptCount(db, await loginRateKey("account", userId), now)) >= LOGIN_FAILURE_LIMIT;
}

export async function recordAccountPasswordFailure(db: D1Database, userId: string, now: number): Promise<number> {
  return recordLoginFailure(db, await loginRateKey("account", userId), now);
}

export async function clearAccountPasswordFailures(db: D1Database, userId: string, now: number): Promise<void> {
  await clearLoginFailures(db, await loginRateKey("account", userId), now);
}

// Reads the counter without incrementing it, so a caller can refuse the
// attempt before it checks a password or TOTP code.
export async function readRateLimitWindow(
  db: D1Database,
  tokenHash: string,
  now: number,
  windowMs: number,
): Promise<number> {
  const windowStart = rateLimitWindowStart(now, windowMs);
  const row = await db
    .prepare(
      `SELECT "count" AS total FROM rate_limits WHERE token_hash = ? AND window_start = ?`,
    )
    .bind(tokenHash, windowStart)
    .first<{ total: number }>();
  return row?.total ?? 0;
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
      `SELECT id, name, platform, created_at, last_seen_at, push_token_hash, push_revoked_at
       FROM devices WHERE user_id = ?
       ORDER BY created_at DESC`,
    )
    .bind(userId)
    .all<{
      id: string;
      name: string;
      platform: string | null;
      created_at: number;
      last_seen_at: number | null;
      push_token_hash: string | null;
      push_revoked_at: number | null;
    }>();
  return result.results.map((row) => ({
    id: row.id,
    name: row.name,
    platform: row.platform,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    push: pushState(row.push_token_hash, row.push_revoked_at),
  }));
}

export async function insertDevice(
  db: D1Database,
  device: {
    id: string;
    userId: string;
    name: string;
    platform?: string | null;
    tokenHash: string;
    tokenVersion?: number;
    createdAt: number;
    pushTokenHash?: string | null;
  },
): Promise<void> {
  // `devices.secret` is intentionally not written any more: per-device HMAC
  // signing is gone, and the column is kept only for backward compatibility.
  await db
    .prepare(
      `INSERT INTO devices (
         id, user_id, name, platform, token_hash, token_version, last_seen_at, created_at,
         push_token_hash, push_revoked_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
    )
    .bind(
      device.id,
      device.userId,
      device.name,
      device.platform ?? "other",
      device.tokenHash,
      device.tokenVersion ?? 0,
      device.createdAt,
      device.pushTokenHash ?? null,
    )
    .run();
}

export async function findOwnedDevice(
  db: D1Database,
  userId: string,
  deviceId: string,
): Promise<{
  id: string;
  name: string;
  push_token_hash: string | null;
  push_revoked_at: number | null;
} | null> {
  return db
    .prepare(
      `SELECT id, name, push_token_hash, push_revoked_at
       FROM devices WHERE id = ? AND user_id = ?`,
    )
    .bind(deviceId, userId)
    .first<{
      id: string;
      name: string;
      push_token_hash: string | null;
      push_revoked_at: number | null;
    }>();
}

export async function replaceDevicePushToken(
  db: D1Database,
  userId: string,
  deviceId: string,
  pushTokenHash: string,
  action: "issue" | "rotate",
): Promise<boolean> {
  const guard =
    action === "issue"
      ? "AND (push_token_hash IS NULL OR push_revoked_at IS NOT NULL)"
      : "AND push_token_hash IS NOT NULL";
  const result = await db
    .prepare(
      `UPDATE devices
       SET push_token_hash = ?, push_revoked_at = NULL
       WHERE id = ? AND user_id = ?
       ${guard}`,
    )
    .bind(pushTokenHash, deviceId, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function revokeDevicePush(
  db: D1Database,
  userId: string,
  deviceId: string,
  revokedAt: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE devices SET push_revoked_at = ?
       WHERE id = ? AND user_id = ? AND push_token_hash IS NOT NULL AND push_revoked_at IS NULL`,
    )
    .bind(revokedAt, deviceId, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
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
    .prepare("SELECT id, token_hash, push_token_hash FROM devices WHERE id = ? AND user_id = ?")
    .bind(deviceId, userId)
    .first<{ id: string; token_hash: string; push_token_hash: string | null }>();
  if (!owned) return false;
  await db.batch([
    db.prepare("DELETE FROM messages WHERE device_id = ?").bind(deviceId),
    db.prepare("DELETE FROM rate_limits WHERE token_hash = ? OR token_hash = ?").bind(owned.token_hash, owned.push_token_hash),
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
    codeSource: CodeSource | null;
    rawPayload: string;
    receivedAt: number;
    createdAt: number;
    encrypted: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO messages (
         id, device_id, from_number, to_number, content, content_hash, code, code_source, raw_payload,
         received_at, created_at, encrypted
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      message.id,
      message.deviceId,
      message.from,
      message.to,
      message.content,
      message.contentHash,
      message.code,
      message.codeSource,
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
  const tickets = await db.prepare("DELETE FROM totp_tickets WHERE expires_at < ?").bind(now).run();
  logInfo({
    message: "retention_complete",
    retention_days: days,
    messages: messages.meta.changes,
    sessions: sessions.meta.changes,
    rate_limits: rates.meta.changes,
    totp_tickets: tickets.meta.changes,
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
    code_source: row.code === null ? null : row.code_source,
    sim: meta.sim,
    reported_device: meta.device,
    received_at: row.received_at,
    received_at_source: meta.receivedAtSource,
    created_at: row.created_at,
  };
}

// ─── API Tokens ──────────────────────────────────────────────────────────────

export async function insertApiToken(
  db: D1Database,
  token: {
    id: string;
    userId: string;
    name: string;
    tokenHash: string;
    tokenPrefix: string;
    permissions: string; // JSON
    deviceScope: string; // JSON
    expiresAt: number | null;
    createdAt: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO api_tokens (id, user_id, name, token_hash, token_prefix, permissions, device_scope, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(token.id, token.userId, token.name, token.tokenHash, token.tokenPrefix, token.permissions, token.deviceScope, token.expiresAt, token.createdAt)
    .run();
}

export async function findApiTokenByHash(db: D1Database, tokenHash: string): Promise<ApiTokenRecord | null> {
  return db
    .prepare(
      `SELECT id, user_id, name, token_hash, token_prefix, permissions, device_scope, expires_at,
              disabled_at, revoked_at, created_at, last_used_at
       FROM api_tokens WHERE token_hash = ?`,
    )
    .bind(tokenHash)
    .first<ApiTokenRecord>();
}

export async function listApiTokens(db: D1Database, userId: string): Promise<ApiTokenRecord[]> {
  const result = await db
    .prepare(
      `SELECT id, user_id, name, token_hash, token_prefix, permissions, device_scope, expires_at,
              disabled_at, revoked_at, created_at, last_used_at
       FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .bind(userId)
    .all<ApiTokenRecord>();
  return result.results;
}

export async function updateApiTokenDisabled(db: D1Database, userId: string, tokenId: string, disabledAt: number | null): Promise<boolean> {
  const result = await db
    .prepare("UPDATE api_tokens SET disabled_at = ? WHERE id = ? AND user_id = ?")
    .bind(disabledAt, tokenId, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function updateApiTokenRevoked(db: D1Database, userId: string, tokenId: string, revokedAt: number): Promise<boolean> {
  const result = await db
    .prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
    .bind(revokedAt, tokenId, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function deleteApiToken(db: D1Database, userId: string, tokenId: string): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM api_tokens WHERE id = ? AND user_id = ?")
    .bind(tokenId, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function touchApiTokenLastUsed(db: D1Database, tokenId: string, lastUsedAt: number): Promise<void> {
  // We update last_used_at on every request. This causes one DB write per request
  // but is acceptable for external API usage (not on the hot ingest path).
  await db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").bind(lastUsedAt, tokenId).run();
}

// External API queries with device_scope filtering at SQL level.
// device_scope: empty array = all devices allowed; non-empty = only those IDs.
// When scopeDeviceIds is non-empty, SQL IN clause is built dynamically (D1 doesn't support array bindings).

const EXT_MESSAGE_COLUMNS = `m.id, m.device_id, d.name AS device_name, m.from_number, m.to_number,
              m.content, m.code, m.code_source, m.raw_payload, m.received_at, m.created_at, m.encrypted`;

export async function listExtMessages(
  db: D1Database,
  query: {
    userId: string;
    scopeDeviceIds: string[]; // empty = all devices
    deviceId: string | null;
    from: string | null;
    since: number | null;
    until: number | null;
    like: string | null;
    text?: string | null;
    limit: number;
    offset: number;
    contentKey: ContentKey;
  },
): Promise<{ total: number; messages: MessageView[] }> {
  const where = ["d.user_id = ?"];
  const binds: Array<string | number> = [query.userId];

  // Device scope: restrict to authorized devices at SQL level
  if (query.scopeDeviceIds.length > 0) {
    const placeholders = query.scopeDeviceIds.map(() => "?").join(", ");
    where.push(`m.device_id IN (${placeholders})`);
    binds.push(...query.scopeDeviceIds);
  }
  if (query.deviceId) {
    where.push("m.device_id = ?");
    binds.push(query.deviceId);
  }
  if (query.from) {
    where.push("m.from_number = ?");
    binds.push(query.from);
  }
  if (query.since != null) {
    where.push("m.received_at >= ?");
    binds.push(query.since);
  }
  if (query.until != null) {
    where.push("m.received_at <= ?");
    binds.push(query.until);
  }

  const encryptedSearch = query.contentKey.state === "on" && Boolean(query.text);
  if (encryptedSearch) {
    const scanned = await db
      .prepare(
        `SELECT ${EXT_MESSAGE_COLUMNS}
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
    };
  }

  if (query.like) {
    where.push("(m.content LIKE ? ESCAPE ? OR m.from_number LIKE ? ESCAPE ? OR IFNULL(m.code, '') LIKE ? ESCAPE ?)");
    binds.push(query.like, "\\", query.like, "\\", query.like, "\\");
  }
  const whereSql = where.join(" AND ");
  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS total FROM messages m JOIN devices d ON d.id = m.device_id WHERE ${whereSql}`)
    .bind(...binds)
    .first<{ total: number }>();
  const listed = await db
    .prepare(
      `SELECT ${EXT_MESSAGE_COLUMNS}
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
  };
}

export async function getExtMessage(
  db: D1Database,
  userId: string,
  messageId: string,
  scopeDeviceIds: string[], // empty = all devices
  contentKey: ContentKey,
): Promise<MessageView | null> {
  const where = ["m.id = ?", "d.user_id = ?"];
  const binds: Array<string | number> = [messageId, userId];
  if (scopeDeviceIds.length > 0) {
    const placeholders = scopeDeviceIds.map(() => "?").join(", ");
    where.push(`m.device_id IN (${placeholders})`);
    binds.push(...scopeDeviceIds);
  }
  const row = await db
    .prepare(
      `SELECT ${EXT_MESSAGE_COLUMNS}
       FROM messages m
       JOIN devices d ON d.id = m.device_id
       WHERE ${where.join(" AND ")}`,
    )
    .bind(...binds)
    .first<MessageRecord>();
  return row ? revealMessage(row, contentKey) : null;
}

export async function getLatestExtOtp(
  db: D1Database,
  query: {
    userId: string;
    scopeDeviceIds: string[];
    deviceId: string | null;
    from: string | null;
    since: number | null;
    contentKey: ContentKey;
  },
): Promise<MessageView | null> {
  const where = ["d.user_id = ?", "m.code IS NOT NULL", "m.code != ''"];
  const binds: Array<string | number> = [query.userId];
  if (query.scopeDeviceIds.length > 0) {
    const placeholders = query.scopeDeviceIds.map(() => "?").join(", ");
    where.push(`m.device_id IN (${placeholders})`);
    binds.push(...query.scopeDeviceIds);
  }
  if (query.deviceId) {
    where.push("m.device_id = ?");
    binds.push(query.deviceId);
  }
  if (query.from) {
    where.push("m.from_number = ?");
    binds.push(query.from);
  }
  if (query.since != null) {
    where.push("m.received_at >= ?");
    binds.push(query.since);
  }
  const row = await db
    .prepare(
      `SELECT ${EXT_MESSAGE_COLUMNS}
       FROM messages m
       JOIN devices d ON d.id = m.device_id
       WHERE ${where.join(" AND ")}
       ORDER BY m.received_at DESC, m.created_at DESC
       LIMIT 1`,
    )
    .bind(...binds)
    .first<MessageRecord>();
  return row ? revealMessage(row, query.contentKey) : null;
}

export async function listExtOtp(
  db: D1Database,
  query: {
    userId: string;
    scopeDeviceIds: string[];
    deviceId: string | null;
    from: string | null;
    since: number | null;
    until: number | null;
    limit: number;
    offset: number;
    contentKey: ContentKey;
  },
): Promise<{ total: number; messages: MessageView[] }> {
  const where = ["d.user_id = ?", "m.code IS NOT NULL", "m.code != ''"];
  const binds: Array<string | number> = [query.userId];
  if (query.scopeDeviceIds.length > 0) {
    const placeholders = query.scopeDeviceIds.map(() => "?").join(", ");
    where.push(`m.device_id IN (${placeholders})`);
    binds.push(...query.scopeDeviceIds);
  }
  if (query.deviceId) {
    where.push("m.device_id = ?");
    binds.push(query.deviceId);
  }
  if (query.from) {
    where.push("m.from_number = ?");
    binds.push(query.from);
  }
  if (query.since != null) {
    where.push("m.received_at >= ?");
    binds.push(query.since);
  }
  if (query.until != null) {
    where.push("m.received_at <= ?");
    binds.push(query.until);
  }
  const whereSql = where.join(" AND ");
  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS total FROM messages m JOIN devices d ON d.id = m.device_id WHERE ${whereSql}`)
    .bind(...binds)
    .first<{ total: number }>();
  const listed = await db
    .prepare(
      `SELECT ${EXT_MESSAGE_COLUMNS}
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
  };
}

export async function listExtDevices(
  db: D1Database,
  userId: string,
  scopeDeviceIds: string[], // empty = all devices
): Promise<DeviceRecord[]> {
  if (scopeDeviceIds.length > 0) {
    const placeholders = scopeDeviceIds.map(() => "?").join(", ");
    const result = await db
      .prepare(
        `SELECT id, user_id, name, platform, token_hash, token_version, last_seen_at, created_at
         FROM devices WHERE user_id = ? AND id IN (${placeholders})
         ORDER BY created_at DESC`,
      )
      .bind(userId, ...scopeDeviceIds)
      .all<DeviceRecord>();
    return result.results;
  }
  const result = await db
    .prepare(
      `SELECT id, user_id, name, platform, token_hash, token_version, last_seen_at, created_at
       FROM devices WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .bind(userId)
    .all<DeviceRecord>();
  return result.results;
}

export async function getExtDevice(
  db: D1Database,
  userId: string,
  deviceId: string,
  scopeDeviceIds: string[], // empty = all devices
): Promise<DeviceRecord | null> {
  if (scopeDeviceIds.length > 0 && !scopeDeviceIds.includes(deviceId)) {
    return null;
  }
  return db
    .prepare(
      `SELECT id, user_id, name, platform, token_hash, token_version, last_seen_at, created_at
       FROM devices WHERE id = ? AND user_id = ?`,
    )
    .bind(deviceId, userId)
    .first<DeviceRecord>();
}

export async function getLastMessageTimeForDevice(db: D1Database, deviceId: string): Promise<number | null> {
  const row = await db
    .prepare("SELECT MAX(received_at) AS last_at FROM messages WHERE device_id = ?")
    .bind(deviceId)
    .first<{ last_at: number | null }>();
  return row?.last_at ?? null;
}
