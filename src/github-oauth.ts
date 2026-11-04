import { bytesToHex } from "./auth";

// Optional Worker vars/secrets. Missing any one of them disables GitHub login
// entirely; password login does not read these.
declare global {
  interface Env {
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
    ADMIN_GITHUB_USERNAME?: string;
  }
}

export const GH_STATE_COOKIE = "gh_oauth_state";
export const GH_INTENT_COOKIE = "gh_oauth_intent";
export const GH_COOKIE_PATH = "/api/v1/auth/github";
export const GH_COOKIE_TTL_SECONDS = 600;

// Same syntax the profile username accepts. GitHub's own logins fit it.
export const GITHUB_LOGIN_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;

export type GithubSettings = { clientId: string; clientSecret: string; adminUsername: string };

export function githubSettings(env: Env): GithubSettings | null {
  const clientId = env.GITHUB_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.GITHUB_CLIENT_SECRET?.trim() ?? "";
  const adminUsername = env.ADMIN_GITHUB_USERNAME?.trim() ?? "";
  if (!clientId || !clientSecret || !adminUsername) return null;
  return { clientId, clientSecret, adminUsername };
}

export type GithubAccess =
  | { ok: true; reason: "admin_username" | "bound_id" }
  | { ok: false; reason: "not_authorized" };

// Login allow-list. The configured admin login wins even when an older binding
// points at someone else, so a later admin sign-in can take the binding over.
// Comparison of the login is case-insensitive; the numeric id is exact.
export function decideGithubAccess(
  github: { login: string; id: string },
  policy: { adminUsername: string; boundId: string | null },
): GithubAccess {
  const login = github.login.trim().toLowerCase();
  const admin = policy.adminUsername.trim().toLowerCase();
  if (admin.length > 0 && login === admin) return { ok: true, reason: "admin_username" };
  const bound = policy.boundId?.trim() ?? "";
  const id = github.id.trim();
  if (bound.length > 0 && id === bound) return { ok: true, reason: "bound_id" };
  return { ok: false, reason: "not_authorized" };
}

export function newOauthState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export function githubOAuthCookie(name: string, value: string, secure: boolean, maxAge = GH_COOKIE_TTL_SECONDS): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "HttpOnly",
    `Path=${GH_COOKIE_PATH}`,
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearGithubOAuthCookies(secure: boolean): string[] {
  return [
    githubOAuthCookie(GH_STATE_COOKIE, "", secure, 0),
    githubOAuthCookie(GH_INTENT_COOKIE, "", secure, 0),
  ];
}

export type GithubIdentity = {
  id: string;
  login: string;
  avatarUrl: string;
  name: string | null;
};

// Code exchange plus the user profile. Returns null on any failure so the
// callback can redirect instead of surfacing a 500. Tests replace global fetch.
export async function fetchGithubIdentity(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<GithubIdentity | null> {
  try {
    const tokenResponse = await globalThis.fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      redirect: "manual",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "SMSinBox",
      },
      body: new URLSearchParams({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        code: input.code,
        redirect_uri: input.redirectUri,
      }),
    });
    if (!isHttpOk(tokenResponse)) return null;
    const tokenBody = await readJson(tokenResponse);
    const accessToken = readAccessToken(tokenBody);
    if (!accessToken) return null;

    const userResponse = await globalThis.fetch("https://api.github.com/user", {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "SMSinBox",
      },
    });
    if (!isHttpOk(userResponse)) return null;
    return readIdentity(await readJson(userResponse));
  } catch {
    return null;
  }
}

function isHttpOk(response: Response): boolean {
  return response.status >= 200 && response.status < 300;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function readAccessToken(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const token = value.access_token;
  if (typeof token !== "string" || token.length < 8 || token.length > 2048 || /\s/.test(token)) return null;
  return token;
}

function readIdentity(value: unknown): GithubIdentity | null {
  if (!isRecord(value)) return null;
  const id = readGithubId(value.id);
  if (!id || typeof value.login !== "string") return null;
  const login = value.login.trim();
  if (login.length < 1 || login.length > 39 || /[\u0000-\u001f\s]/.test(login)) return null;
  let avatarUrl = "";
  if (typeof value.avatar_url === "string" && value.avatar_url.length <= 2048 && /^https:\/\/\S+$/.test(value.avatar_url)) {
    avatarUrl = value.avatar_url;
  }
  const name = typeof value.name === "string" && value.name.length <= 128 ? value.name : null;
  return { id, login, avatarUrl, name };
}

function readGithubId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value)) return value;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
