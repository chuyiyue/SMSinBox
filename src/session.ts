import {
  randomToken,
  requestIsSecure,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  sessionCookieHeader,
  sha256Hex,
} from "./auth";
import { consumeRateLimitWindow, createSession, deleteSession, findSessionUser } from "./db";
import { isCrossSite, json, readCookie } from "./http";
import type { SessionUser } from "./types";

// Failed password attempts are throttled per username in a five-minute window.
// A successful login does not clear the counter; it expires with the window.
export const LOGIN_FAILURE_LIMIT = 10;
export const LOGIN_FAILURE_WINDOW_MS = 5 * 60 * 1000;

export function publicUser(user: {
  id: string;
  username: string;
  role?: string;
  totp_enabled_at?: number | null;
}) {
  return {
    id: user.id,
    username: user.username,
    role: user.role === "admin" ? "admin" : "member",
    totp_enabled: user.totp_enabled_at != null,
  };
}

export async function issueSession(
  request: Request,
  env: Env,
  user: { id: string; username: string; role?: string; totp_enabled_at?: number | null },
): Promise<Response> {
  const token = randomToken();
  const now = Date.now();
  await createSession(env.DB, {
    id: await sha256Hex(token),
    userId: user.id,
    expiresAt: now + SESSION_TTL_SECONDS * 1000,
    createdAt: now,
  });
  const headers = new Headers();
  headers.set("set-cookie", sessionCookieHeader(token, requestIsSecure(request), SESSION_TTL_SECONDS));
  return json({ ok: true, user: publicUser(user) }, 200, headers);
}

export async function requireUser(request: Request, env: Env): Promise<SessionUser | Response> {
  if (isCrossSite(request)) return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (!token) return json({ ok: false, error: "未登录" }, 401);
  const sessionHash = await sha256Hex(token);
  const user = await findSessionUser(env.DB, sessionHash);
  if (!user || user.expires_at <= Date.now() || user.disabled_at != null || user.role !== "admin") {
    if (user) await deleteSession(env.DB, sessionHash);
    return json({ ok: false, error: "未登录" }, 401);
  }
  return user;
}

export async function recordLoginFailure(env: Env, username: string): Promise<boolean> {
  const key = `login:${await sha256Hex(username.trim().toLowerCase())}`;
  const count = await consumeRateLimitWindow(env.DB, key, Date.now(), LOGIN_FAILURE_WINDOW_MS);
  return count > LOGIN_FAILURE_LIMIT;
}
