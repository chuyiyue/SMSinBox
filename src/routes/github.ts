import { pickDesignatedUser } from "../admin-user";
import { hashPassword, randomToken, requestIsSecure, secretsEqual } from "../auth";
import { parseAvatarDataUrl, AVATAR_BODY_MAX } from "../avatar";
import {
  AVATAR_DATA_KEY,
  deleteSchemaMeta,
  ensureAdmin,
  getProfileUsername,
  GITHUB_AVATAR_URL_KEY,
  GITHUB_ID_KEY,
  GITHUB_LOGIN_KEY,
  insertUser,
  isUniqueViolation,
  listUserRecords,
  mergeIntoAdmin,
  readSchemaMeta,
  setProfileUsername,
  writeSchemaMeta,
} from "../db";
import { json, readCookie, readLimitedBytes } from "../http";
import { logInfo } from "../log";
import {
  clearGithubOAuthCookies,
  decideGithubAccess,
  fetchGithubIdentity,
  GH_INTENT_COOKIE,
  GH_STATE_COOKIE,
  githubOAuthCookie,
  githubSettings,
  GITHUB_LOGIN_RE,
  newOauthState,
  type GithubIdentity,
} from "../github-oauth";
import { findRequestSession, issueSessionCookie, requireSensitiveUser, requireUser } from "../session";
import type { UserRecord } from "../types";

const LOGIN_STATE = "/login?error=github_state";
const LOGIN_EXCHANGE = "/login?error=github_exchange";
const LOGIN_FORBIDDEN = "/login?error=github_forbidden";
const USERS_BOUND = "/users?github=bound";
const USERS_ERROR = "/users?github=error";

export function githubConfig(env: Env): Response {
  return json({ ok: true, github_enabled: githubSettings(env) !== null });
}

export async function githubStart(request: Request, env: Env): Promise<Response> {
  const settings = githubSettings(env);
  if (!settings) return json({ ok: false, error: "GitHub 登录未启用" }, 404);
  const intent = readIntent(new URL(request.url).searchParams.get("intent"));
  if (!intent) return json({ ok: false, error: "intent 无效" }, 400);
  if (intent === "bind") {
    const user = await requireUser(request, env);
    if (user instanceof Response) return user;
  }
  const state = newOauthState();
  const secure = requestIsSecure(request);
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", settings.clientId);
  authorize.searchParams.set("redirect_uri", callbackUrl(request));
  authorize.searchParams.set("scope", "read:user");
  authorize.searchParams.set("state", state);
  return redirect(authorize.toString(), [
    githubOAuthCookie(GH_STATE_COOKIE, state, secure),
    githubOAuthCookie(GH_INTENT_COOKIE, intent, secure),
  ]);
}

export async function githubCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const secure = requestIsSecure(request);
  const clears = clearGithubOAuthCookies(secure);
  const provided = url.searchParams.get("state") ?? "";
  const saved = readCookie(request.headers.get("cookie"), GH_STATE_COOKIE) ?? "";
  if (!provided || !saved || provided.length > 256 || !(await secretsEqual(provided, saved))) {
    return redirect(LOGIN_STATE, clears);
  }
  const settings = githubSettings(env);
  if (!settings) return redirect(LOGIN_EXCHANGE, clears);
  const intent = readIntent(readCookie(request.headers.get("cookie"), GH_INTENT_COOKIE));
  if (!intent) return redirect(LOGIN_STATE, clears);
  const code = url.searchParams.get("code") ?? "";
  if (!code || code.length > 512) return redirect(LOGIN_EXCHANGE, clears);

  const identity = await fetchGithubIdentity({
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    code,
    redirectUri: callbackUrl(request),
  });
  if (!identity) return redirect(LOGIN_EXCHANGE, clears);
  if (intent === "bind") return finishBind(request, env, identity, clears);
  return finishLogin(request, env, identity, settings.adminUsername, clears);
}

export async function githubUnbind(request: Request, env: Env): Promise<Response> {
  const user = await requireSensitiveUser(request, env);
  if (user instanceof Response) return user;
  await deleteSchemaMeta(env.DB, GITHUB_ID_KEY);
  await deleteSchemaMeta(env.DB, GITHUB_LOGIN_KEY);
  await deleteSchemaMeta(env.DB, GITHUB_AVATAR_URL_KEY);
  logInfo({ message: "github_unbound", user_id: user.id });
  return json({ ok: true });
}

export async function uploadAvatar(request: Request, env: Env): Promise<Response> {
  const user = await requireSensitiveUser(request, env);
  if (user instanceof Response) return user;
  const parsed = await readAvatarBody(request);
  if (!parsed.ok) return parsed.response;
  await writeSchemaMeta(env.DB, AVATAR_DATA_KEY, parsed.image);
  logInfo({ message: "avatar_updated", user_id: user.id });
  return json({ ok: true });
}

export async function deleteAvatar(request: Request, env: Env): Promise<Response> {
  const user = await requireSensitiveUser(request, env);
  if (user instanceof Response) return user;
  await deleteSchemaMeta(env.DB, AVATAR_DATA_KEY);
  logInfo({ message: "avatar_cleared", user_id: user.id });
  return json({ ok: true });
}

export async function authMeExtras(db: D1Database): Promise<{
  github: { login: string; avatar_url: string } | null;
  avatar_data: string | null;
}> {
  const id = await readSchemaMeta(db, GITHUB_ID_KEY);
  const avatar = await readSchemaMeta(db, AVATAR_DATA_KEY);
  if (!id) return { github: null, avatar_data: avatar };
  return {
    github: {
      login: (await readSchemaMeta(db, GITHUB_LOGIN_KEY)) ?? "",
      avatar_url: (await readSchemaMeta(db, GITHUB_AVATAR_URL_KEY)) ?? "",
    },
    avatar_data: avatar,
  };
}

// GitHub redirects the browser here with Sec-Fetch-Site: cross-site. The OAuth
// state cookie is the CSRF check; requireUser would reject that navigation.
async function finishBind(
  request: Request,
  env: Env,
  identity: GithubIdentity,
  clears: string[],
): Promise<Response> {
  const user = await findRequestSession(request, env);
  if (!user) return redirect(USERS_ERROR, clears);
  await syncGithubProfile(env.DB, identity);
  logInfo({ message: "github_bound", user_id: user.id });
  return redirect(USERS_BOUND, clears);
}

// A successful GitHub callback is already a second factor, so this path issues
// the session cookie directly and never opens a TOTP ticket.
async function finishLogin(
  request: Request,
  env: Env,
  identity: GithubIdentity,
  adminUsername: string,
  clears: string[],
): Promise<Response> {
  const decision = decideGithubAccess(
    { login: identity.login, id: identity.id },
    { adminUsername, boundId: await readSchemaMeta(env.DB, GITHUB_ID_KEY) },
  );
  if (!decision.ok) {
    logInfo({ message: "github_login_denied", login: identity.login });
    return redirect(LOGIN_FORBIDDEN, clears);
  }

  const users = await listUserRecords(env.DB);
  let user: UserRecord | null;
  if (users.length === 0) {
    if (decision.reason !== "admin_username") return redirect(LOGIN_FORBIDDEN, clears);
    user = await createGithubAdmin(env, identity.login);
    if (!user) return redirect(LOGIN_EXCHANGE, clears);
  } else {
    user = pickDesignatedUser(users, env.ADMIN_USERNAME?.trim() ?? "");
    if (!user) return redirect(LOGIN_FORBIDDEN, clears);
    if (decision.reason === "admin_username") {
      if (user.role !== "admin" || user.disabled_at != null) {
        await ensureAdmin(env.DB, user.id);
        user = { ...user, role: "admin", disabled_at: null };
      }
    } else if (user.role !== "admin" || user.disabled_at != null) {
      return redirect(LOGIN_FORBIDDEN, clears);
    }
  }

  await syncGithubProfile(env.DB, identity);
  await mergeIntoAdmin(env.DB, user);
  const sessionCookie = await issueSessionCookie(request, env, user);
  logInfo({ message: "github_login", user_id: user.id, login: identity.login });
  return redirect("/", [...clears, sessionCookie]);
}

async function createGithubAdmin(env: Env, login: string): Promise<UserRecord | null> {
  const username = env.ADMIN_USERNAME?.trim() || login;
  const createdAt = Date.now();
  const user: UserRecord = {
    id: crypto.randomUUID(),
    username,
    password_hash: await hashPassword(randomToken()),
    role: "admin",
    disabled_at: null,
    created_at: createdAt,
  };
  try {
    await insertUser(env.DB, {
      id: user.id,
      username: user.username,
      passwordHash: user.password_hash,
      role: "admin",
      createdAt,
    });
    // The account was born from this GitHub login, so the display name
    // starts as the GitHub login. This runs only at creation; later binds
    // and sign-ins leave the profile username alone (see syncGithubProfile).
    const profile = await getProfileUsername(env.DB);
    if (!profile && GITHUB_LOGIN_RE.test(login)) await setProfileUsername(env.DB, login);
    return user;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const again = await listUserRecords(env.DB);
    return pickDesignatedUser(again, username) ?? again[0] ?? null;
  }
}

async function syncGithubProfile(db: D1Database, identity: GithubIdentity): Promise<void> {
  await writeSchemaMeta(db, GITHUB_ID_KEY, identity.id);
  await writeSchemaMeta(db, GITHUB_LOGIN_KEY, identity.login);
  await writeSchemaMeta(db, GITHUB_AVATAR_URL_KEY, identity.avatarUrl);
  // Binding or signing in never touches the profile username: the display
  // name is independent of GitHub. The single exception is account
  // creation, which seeds it in createGithubAdmin above.
}

async function readAvatarBody(
  request: Request,
): Promise<{ ok: true; image: string } | { ok: false; response: Response }> {
  const bytes = await readLimitedBytes(request, AVATAR_BODY_MAX);
  if (bytes === null) return { ok: false, response: json({ ok: false, error: "图片过大，请控制在 400KB 以内" }, 400) };
  if (bytes.byteLength === 0) return { ok: false, response: json({ ok: false, error: "请求体为空" }, 400) };
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return { ok: false, response: json({ ok: false, error: "JSON 无法解析" }, 400) };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, response: json({ ok: false, error: "请求体无效" }, 400) };
  }
  const image = (value as Record<string, unknown>).image;
  if (typeof image !== "string" || image.length === 0) {
    return { ok: false, response: json({ ok: false, error: "请上传图片" }, 400) };
  }
  const parsed = parseAvatarDataUrl(image);
  if (!parsed.ok) return { ok: false, response: json({ ok: false, error: parsed.error }, 400) };
  return { ok: true, image: parsed.dataUrl };
}

function readIntent(value: string | null): "login" | "bind" | null {
  if (value === "login" || value === "bind") return value;
  return null;
}

function callbackUrl(request: Request): string {
  return `${new URL(request.url).origin}/api/v1/auth/github/callback`;
}

function redirect(location: string, cookies: string[]): Response {
  const headers = new Headers();
  headers.set("location", location);
  headers.set("cache-control", "no-store");
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}
