import {
  randomToken,
  requestIsSecure,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  sessionCookieHeader,
  sha256Hex,
} from "./auth";
import { createSession, deleteSession, findSessionUser } from "./db";
import { clientAddress, isCrossSite, json, readCookie, rejectsSensitiveWrite } from "./http";
import type { SessionUser } from "./types";

export type ActiveUser = SessionUser & { session_id: string };

export function publicUser(user: {
  id: string;
  username: string;
  role?: string;
  totp_enabled_at?: number | null;
}) {
  const body: {
    id: string;
    username: string;
    role: "admin" | "member";
    totp_enabled?: boolean;
  } = {
    id: user.id,
    username: user.username,
    role: user.role === "admin" ? "admin" : "member",
  };
  // Callers that did not load the column (for example a username change)
  // leave the flag off the payload instead of claiming 2FA is disabled.
  if ("totp_enabled_at" in user) body.totp_enabled = user.totp_enabled_at != null;
  return body;
}

export async function issueSessionCookie(request: Request, env: Env, user: { id: string }): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  const userAgent = request.headers.get("user-agent")?.slice(0, 512) || null;
  await createSession(env.DB, {
    id: await sha256Hex(token),
    userId: user.id,
    expiresAt: now + SESSION_TTL_SECONDS * 1000,
    createdAt: now,
    userAgent,
    ip: clientAddress(request),
  });
  return sessionCookieHeader(token, requestIsSecure(request), SESSION_TTL_SECONDS);
}

export async function issueSession(
  request: Request,
  env: Env,
  user: { id: string; username: string; role?: string; totp_enabled_at?: number | null },
): Promise<Response> {
  const headers = new Headers();
  headers.set("set-cookie", await issueSessionCookie(request, env, user));
  return json({ ok: true, user: publicUser(user) }, 200, headers);
}

// Looks up the session cookie without the cross-site check. OAuth callbacks
// arrive as a top-level navigation from GitHub, which browsers label cross-site.
export async function findRequestSession(request: Request, env: Env): Promise<ActiveUser | null> {
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (!token) return null;
  const sessionHash = await sha256Hex(token);
  const user = await findSessionUser(env.DB, sessionHash);
  if (!user || user.expires_at <= Date.now() || user.disabled_at != null || user.role !== "admin") {
    if (user) await deleteSession(env.DB, sessionHash);
    return null;
  }
  return { ...user, session_id: sessionHash };
}

export async function requireUser(request: Request, env: Env): Promise<ActiveUser | Response> {
  if (isCrossSite(request)) return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  const user = await findRequestSession(request, env);
  if (!user) return json({ ok: false, error: "未登录" }, 401);
  return user;
}

export async function requireSensitiveUser(request: Request, env: Env): Promise<ActiveUser | Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  if (rejectsSensitiveWrite(request)) return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  return user;
}
