import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex, verifyPassword } from "../src/auth";
import { parseAvatarDataUrl } from "../src/avatar";
import { decideGithubAccess } from "../src/github-oauth";
import { handleApi } from "../src/routes/api";

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOKEN = "sms_session_token_value";
const SESSION_COOKIE = `smsinbox_session=${TOKEN}`;
const ORIGIN = "https://sms.example";

type UserRow = {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  disabled_at: number | null;
  created_at: number;
  totp_secret?: string | null;
  totp_enabled_at?: number | null;
};

type SessionRow = { id: string; user_id: string; expires_at: number; created_at: number };

let sessionId = "";

beforeAll(async () => {
  sessionId = await sha256Hex(TOKEN);
});

function adminUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: ADMIN_ID,
    username: "root",
    password_hash: "pbkdf2-sha256$1$salt$hash",
    role: "admin",
    disabled_at: null,
    created_at: 1_000,
    ...overrides,
  };
}

function makeDb(options?: { users?: UserRow[]; sessions?: SessionRow[]; meta?: Record<string, string> }) {
  const users = options?.users ?? [adminUser()];
  const now = Date.now();
  const sessions = options?.sessions ?? [
    { id: sessionId, user_id: ADMIN_ID, expires_at: now + 60_000, created_at: now - 1_000 },
  ];
  const meta = new Map<string, string>([["single_user_merged_at", "1"], ...Object.entries(options?.meta ?? {})]);
  const calls: string[] = [];
  let totpTickets = 0;

  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        bind(...bound: unknown[]) {
          args = bound;
          return statement;
        },
        async first() {
          calls.push(sql);
          if (sql.includes("FROM schema_meta")) {
            const value = meta.get(String(args[0]));
            return value === undefined ? null : { value };
          }
          if (sql.includes("FROM sessions") && sql.includes("JOIN users")) {
            const session = sessions.find((item) => item.id === args[0]);
            const user = users.find((item) => item.id === session?.user_id);
            if (!session || !user) return null;
            return {
              id: user.id,
              username: user.username,
              role: user.role,
              disabled_at: user.disabled_at,
              expires_at: session.expires_at,
              totp_enabled_at: user.totp_enabled_at ?? null,
            };
          }
          if (sql.includes("FROM users") && sql.includes("WHERE id")) {
            return users.find((item) => item.id === args[0]) ?? null;
          }
          throw new Error(`unhandled first: ${sql}`);
        },
        async all() {
          calls.push(sql);
          if (sql.includes("FROM users") && sql.includes("ORDER BY created_at")) return { results: users };
          throw new Error(`unhandled all: ${sql}`);
        },
        async run() {
          calls.push(sql);
          if (sql.includes("totp_tickets")) {
            totpTickets += 1;
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE users SET role = 'admin'")) {
            const user = users.find((item) => item.id === args[0]);
            if (user) {
              user.role = "admin";
              user.disabled_at = null;
            }
            return { meta: { changes: user ? 1 : 0 } };
          }
          if (sql.startsWith("INSERT INTO sessions")) {
            sessions.push({
              id: String(args[0]),
              user_id: String(args[1]),
              expires_at: Number(args[2]),
              created_at: Number(args[3]),
            });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("INSERT INTO users")) {
            const username = String(args[1]);
            if (users.some((item) => item.username === username)) {
              throw new Error("UNIQUE constraint failed: users.username");
            }
            users.push({
              id: String(args[0]),
              username,
              password_hash: String(args[2]),
              role: String(args[3]),
              disabled_at: null,
              created_at: Number(args[4]),
            });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("INSERT INTO schema_meta")) {
            meta.set(String(args[0]), String(args[1]));
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("DELETE FROM schema_meta")) {
            meta.delete(String(args[0]));
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("DELETE FROM sessions WHERE id")) {
            const index = sessions.findIndex((item) => item.id === args[0]);
            if (index >= 0) sessions.splice(index, 1);
            return { meta: { changes: index >= 0 ? 1 : 0 } };
          }
          throw new Error(`unhandled run: ${sql}`);
        },
      };
      return statement;
    },
    async batch(statements: Array<{ run?: () => Promise<unknown> }>) {
      for (const statement of statements) {
        if (statement.run) await statement.run();
      }
    },
  };
  return { db: db as unknown as D1Database, users, sessions, meta, calls, get totpTickets() { return totpTickets; } };
}

function envFor(db: D1Database, extra: Record<string, string> = {}): Env {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response("") },
    RETENTION_DAYS: "90",
    CONTENT_KEY: "",
    ADMIN_USERNAME: "octocat",
    ADMIN_PASSWORD: "secret",
    GH_CLIENT_ID: "client-id",
    GH_CLIENT_SECRET: "client-secret",
    ...extra,
  } as unknown as Env;
}

function dataUrl(kind: "png" | "jpeg" | "webp", bytes: number[]): string {
  const binary = bytes.map((byte) => String.fromCharCode(byte)).join("");
  return `data:image/${kind};base64,${btoa(binary)}`;
}

const PNG = dataUrl("png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const JPEG = dataUrl("jpeg", [0xff, 0xd8, 0xff, 0xd9]);
const WEBP = dataUrl("webp", [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

function cookiePairs(response: Response): Record<string, { value: string; header: string }> {
  const pairs: Record<string, { value: string; header: string }> = {};
  for (const header of response.headers.getSetCookie()) {
    const first = header.split(";")[0] ?? "";
    const eq = first.indexOf("=");
    pairs[first.slice(0, eq)] = { value: decodeURIComponent(first.slice(eq + 1)), header };
  }
  return pairs;
}

function sessionCookie(response: Response): string | null {
  const header = cookiePairs(response).smsinbox_session?.header;
  if (!header) return null;
  const match = /smsinbox_session=([^;]+)/.exec(header);
  return match ? `smsinbox_session=${match[1]}` : null;
}

describe("decideGithubAccess", () => {
  it("allows the configured admin login, ignoring case and surrounding space", () => {
    expect(decideGithubAccess({ login: "OctoCat", id: "9" }, { adminUsername: " octocat ", boundId: null })).toEqual({
      ok: true,
      reason: "admin_username",
    });
    expect(decideGithubAccess({ login: " octocat ", id: "9" }, { adminUsername: "OCTOCAT", boundId: "1" })).toEqual({
      ok: true,
      reason: "admin_username",
    });
  });

  it("allows a previously bound id when the login is no longer the admin name", () => {
    expect(decideGithubAccess({ login: "renamed", id: "42" }, { adminUsername: "octocat", boundId: "42" })).toEqual({
      ok: true,
      reason: "bound_id",
    });
  });

  it("refuses when neither the login nor the id matches", () => {
    expect(decideGithubAccess({ login: "stranger", id: "7" }, { adminUsername: "octocat", boundId: "42" })).toEqual({
      ok: false,
      reason: "not_authorized",
    });
    expect(decideGithubAccess({ login: "octocat", id: "42" }, { adminUsername: "", boundId: null })).toEqual({
      ok: false,
      reason: "not_authorized",
    });
    expect(decideGithubAccess({ login: "other", id: "042" }, { adminUsername: "octocat", boundId: "42" })).toEqual({
      ok: false,
      reason: "not_authorized",
    });
  });
});

describe("parseAvatarDataUrl", () => {
  it("accepts png, jpeg, and webp data URLs and rejects everything else", () => {
    expect(parseAvatarDataUrl(PNG)).toEqual({ ok: true, dataUrl: PNG });
    expect(parseAvatarDataUrl(JPEG)).toEqual({ ok: true, dataUrl: JPEG });
    expect(parseAvatarDataUrl(WEBP)).toEqual({ ok: true, dataUrl: WEBP });
    expect(parseAvatarDataUrl("data:image/gif;base64,R0lGODlh")).toMatchObject({
      ok: false,
      error: "仅支持 PNG、JPEG 或 WebP 图片",
    });
    expect(parseAvatarDataUrl("data:image/png;base64,AAAA")).toMatchObject({ ok: false, error: "图片数据无效" });
    expect(parseAvatarDataUrl(`data:image/png;base64,${"A".repeat(400 * 1024)}`)).toMatchObject({
      ok: false,
      error: "图片过大，请控制在 400KB 以内",
    });
  });
});

describe("github oauth and avatar http", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", async (input: unknown) => {
      throw new Error(`unexpected fetch ${String(input)}`);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports github_enabled from the public login config", async () => {
    const enabled = await handleApi(new Request(`${ORIGIN}/api/v1/auth/config`), envFor(makeDb().db));
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toEqual({ ok: true, github_enabled: true });

    const disabledCases: Array<Record<string, string>> = [
      { GH_CLIENT_ID: "" },
      { GH_CLIENT_SECRET: "  " },
      { ADMIN_USERNAME: "" },
    ];
    for (const extra of disabledCases) {
      const disabled = await handleApi(new Request(`${ORIGIN}/api/v1/auth/config`), envFor(makeDb().db, extra));
      expect(await disabled.json()).toEqual({ ok: true, github_enabled: false });
    }
  });

  it("hides the start endpoint when GitHub is not configured", async () => {
    const missing: Array<Record<string, string>> = [
      { GH_CLIENT_ID: "" },
      { GH_CLIENT_SECRET: "" },
      { ADMIN_USERNAME: "" },
    ];
    for (const extra of missing) {
      const response = await handleApi(
        new Request(`${ORIGIN}/api/v1/auth/github/start?intent=login`),
        envFor(makeDb().db, extra),
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ ok: false, error: "GitHub 登录未启用" });
    }
  });

  it("rejects a bad intent and requires a session to bind", async () => {
    const script = makeDb();
    const bad = await handleApi(
      new Request(`${ORIGIN}/api/v1/auth/github/start?intent=signup`),
      envFor(script.db),
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ ok: false, error: "intent 无效" });

    const posted = await handleApi(
      new Request(`${ORIGIN}/api/v1/auth/github/start?intent=login`, { method: "POST" }),
      envFor(script.db),
    );
    expect(posted.status).toBe(405);

    const anonymous = await handleApi(
      new Request(`${ORIGIN}/api/v1/auth/github/start?intent=bind`),
      envFor(script.db),
    );
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ ok: false, error: "未登录" });
    expect(anonymous.headers.get("location")).toBeNull();
  });

  it("redirects login and bind starts at GitHub with state cookies", async () => {
    const script = makeDb();
    const login = await handleApi(new Request(`${ORIGIN}/api/v1/auth/github/start?intent=login`), envFor(script.db));
    expect(login.status).toBe(302);
    const location = new URL(login.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("client-id");
    expect(location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/v1/auth/github/callback`);
    expect(location.searchParams.get("scope")).toBe("read:user");
    expect(location.searchParams.get("client_secret")).toBeNull();
    const cookies = cookiePairs(login);
    expect(cookies.gh_oauth_state?.value).toBe(location.searchParams.get("state"));
    expect(cookies.gh_oauth_state?.value.length).toBeGreaterThanOrEqual(32);
    expect(cookies.gh_oauth_intent?.value).toBe("login");
    for (const name of ["gh_oauth_state", "gh_oauth_intent"] as const) {
      expect(cookies[name]?.header).toContain("HttpOnly");
      expect(cookies[name]?.header).toContain("Path=/api/v1/auth/github");
      expect(cookies[name]?.header).toContain("SameSite=Lax");
      expect(cookies[name]?.header).toContain("Max-Age=600");
      expect(cookies[name]?.header).toContain("Secure");
    }

    const bind = await handleApi(
      new Request(`${ORIGIN}/api/v1/auth/github/start?intent=bind`, { headers: { cookie: SESSION_COOKIE } }),
      envFor(script.db),
    );
    expect(bind.status).toBe(302);
    expect(cookiePairs(bind).gh_oauth_intent?.value).toBe("bind");
  });

  it("rejects a callback whose state does not match the cookie", async () => {
    const response = await handleApi(
      new Request(`${ORIGIN}/api/v1/auth/github/callback?code=abc&state=bbbb`, {
        headers: { cookie: "gh_oauth_state=aaaa; gh_oauth_intent=login" },
      }),
      envFor(makeDb().db),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login?error=github_state");
    expect(cookiePairs(response).gh_oauth_state?.header).toContain("Max-Age=0");
    expect(cookiePairs(response).gh_oauth_intent?.header).toContain("Max-Age=0");
    expect(sessionCookie(response)).toBeNull();
  });

  it("redirects exchange failures and a disabled callback instead of returning 500", async () => {
    installGithub({ id: 1, login: "octocat", avatar_url: "https://avatars.githubusercontent.com/u/1" }, 503);
    const script = makeDb({ users: [], sessions: [] });
    const failed = await callback(script, "login", "state-token");
    expect(failed.status).toBe(302);
    expect(failed.headers.get("location")).toBe("/login?error=github_exchange");
    expect(script.users).toHaveLength(0);
    expect(script.meta.has("github_id")).toBe(false);

    const disabled = await handleApi(
      new Request(`${ORIGIN}/api/v1/auth/github/callback?code=abc&state=state-token`, {
        headers: { cookie: "gh_oauth_state=state-token; gh_oauth_intent=login" },
      }),
      envFor(makeDb({ users: [], sessions: [] }).db, { GH_CLIENT_SECRET: "" }),
    );
    expect(disabled.status).toBe(302);
    expect(disabled.headers.get("location")).toBe("/login?error=github_exchange");
  });

  it("does not create an account from a stale binding when no user exists", async () => {
    installGithub({ id: 7, login: "other-dev", avatar_url: "https://avatars.githubusercontent.com/u/7" });
    const script = makeDb({ users: [], sessions: [], meta: { github_id: "7", github_login: "other-dev" } });
    const response = await callback(script, "login", "state-token");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login?error=github_forbidden");
    expect(script.users).toHaveLength(0);
    expect(script.sessions).toHaveLength(0);
    expect(script.meta.get("github_id")).toBe("7");
  });

  it("refuses an unauthorized GitHub user without a session or a binding", async () => {
    installGithub({ id: 99, login: "stranger", avatar_url: "https://avatars.githubusercontent.com/u/99" });
    const script = makeDb();
    const before = script.sessions.length;
    const response = await callback(script, "login", "state-token");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login?error=github_forbidden");
    expect(sessionCookie(response)).toBeNull();
    expect(script.sessions).toHaveLength(before);
    expect(script.users).toHaveLength(1);
    expect(script.meta.has("github_id")).toBe(false);
    expect(script.totpTickets).toBe(0);
  });

  it("creates the admin on the first authorized login, binds GitHub, and skips TOTP", async () => {
    const calls = installGithub({
      id: 42,
      login: "OctoCat",
      avatar_url: "https://avatars.githubusercontent.com/u/42",
      name: "Mona",
    });
    const script = makeDb({ users: [], sessions: [] });
    const response = await callback(script, "login", "state-token");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("set-cookie") ?? "").not.toContain("totp");
    const cookie = sessionCookie(response);
    expect(cookie).toBeTruthy();
    expect(cookiePairs(response).smsinbox_session?.header).toContain("HttpOnly");
    expect(script.totpTickets).toBe(0);
    expect(script.users).toHaveLength(1);
    expect(script.users[0]).toMatchObject({ username: "octocat", role: "admin", disabled_at: null });
    expect(script.users[0]?.password_hash.startsWith("pbkdf2-sha256$")).toBe(true);
    expect(await verifyPassword("secret", script.users[0]?.password_hash ?? "")).toBe(false);
    expect(script.meta.get("github_id")).toBe("42");
    expect(script.meta.get("github_login")).toBe("OctoCat");
    expect(script.meta.get("github_avatar_url")).toBe("https://avatars.githubusercontent.com/u/42");
    expect(script.meta.get("profile_username")).toBe("OctoCat");

    const tokenCall = calls[0];
    expect(String(tokenCall?.input)).toBe("https://github.com/login/oauth/access_token");
    expect(tokenCall?.init.method).toBe("POST");
    expect(String(tokenCall?.init.body)).toContain("client_secret=client-secret");
    expect(String(tokenCall?.init.body)).toContain(encodeURIComponent(`${ORIGIN}/api/v1/auth/github/callback`));
    expect(new Headers(tokenCall?.init.headers).get("accept")).toBe("application/json");
    expect(String(calls[1]?.input)).toBe("https://api.github.com/user");
    expect(new Headers(calls[1]?.init.headers).get("authorization")).toBe("Bearer gho_test_token");

    const me = await handleApi(new Request(`${ORIGIN}/api/v1/auth/me`, { headers: { cookie: cookie ?? "" } }), envFor(script.db));
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      user: {
        username: "octocat",
        profile_username: "OctoCat",
        github: { login: "OctoCat", avatar_url: "https://avatars.githubusercontent.com/u/42" },
        avatar_data: null,
      },
    });
  });

  it("does not seed the profile username when an existing admin signs in with GitHub", async () => {
    installGithub({ id: 42, login: "OctoCat", avatar_url: "https://avatars.githubusercontent.com/u/42" });
    const script = makeDb();
    const response = await callback(script, "login", "state-token");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    expect(script.meta.get("github_id")).toBe("42");
    // Only an account created by GitHub sign-up gets the login as its
    // initial display name; an existing account keeps its own (empty) one.
    expect(script.meta.has("profile_username")).toBe(false);
  });

  it("matches the shared ADMIN_USERNAME case-insensitively and names the row after it", async () => {
    installGithub({ id: 42, login: "OctoCat", avatar_url: "https://avatars.githubusercontent.com/u/42" });
    const script = makeDb({ users: [], sessions: [] });
    const response = await callback(script, "login", "state-token", { ADMIN_USERNAME: "OCTOCAT" });
    expect(response.status).toBe(302);
    expect(script.users[0]?.username).toBe("OCTOCAT");
  });

  it("signs in an admin who already has TOTP without a challenge and keeps a custom profile", async () => {
    installGithub({ id: 42, login: "OctoCat", avatar_url: "https://avatars.githubusercontent.com/u/42" });
    const script = makeDb({
      users: [adminUser({ totp_secret: "sealed", totp_enabled_at: 1_700_000_000_000 })],
      meta: { profile_username: "KeptName" },
    });
    const response = await callback(script, "login", "state-token");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    expect(sessionCookie(response)).toBeTruthy();
    expect(script.totpTickets).toBe(0);
    expect(script.calls.some((sql) => sql.includes("totp_"))).toBe(false);
    expect(script.users[0]?.totp_enabled_at).toBe(1_700_000_000_000);
    expect(script.users[0]?.totp_secret).toBe("sealed");
    expect(script.meta.get("profile_username")).toBe("KeptName");
    expect(script.meta.get("github_id")).toBe("42");
    const me = await handleApi(
      new Request(`${ORIGIN}/api/v1/auth/me`, { headers: { cookie: sessionCookie(response) ?? "" } }),
      envFor(script.db),
    );
    expect(me.status).toBe(200);
  });

  it("revives a disabled configured admin when the GitHub login matches", async () => {
    installGithub({ id: 42, login: "octocat", avatar_url: "https://avatars.githubusercontent.com/u/42" });
    const script = makeDb({ users: [adminUser({ role: "member", disabled_at: 50 })] });
    const response = await callback(script, "login", "state-token");
    expect(response.status).toBe(302);
    expect(script.users[0]).toMatchObject({ role: "admin", disabled_at: null });
    const me = await handleApi(
      new Request(`${ORIGIN}/api/v1/auth/me`, { headers: { cookie: sessionCookie(response) ?? "" } }),
      envFor(script.db),
    );
    expect(me.status).toBe(200);
  });

  it("does not bind when the callback has no session", async () => {
    installGithub({ id: 7, login: "other-dev", avatar_url: "https://avatars.githubusercontent.com/u/7" });
    const script = makeDb();
    const response = await callback(script, "bind", "state-token");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/users?github=error");
    expect(script.meta.has("github_id")).toBe(false);
    expect(script.sessions).toHaveLength(1);
  });

  it("binds the signed-in user, then accepts that id after a rename, and drops it on unbind", async () => {
    installGithub({ id: 7, login: "other-dev", avatar_url: "https://avatars.githubusercontent.com/u/7" });
    const script = makeDb();
    const started = await handleApi(
      new Request(`${ORIGIN}/api/v1/auth/github/start?intent=bind`, { headers: { cookie: SESSION_COOKIE } }),
      envFor(script.db),
    );
    const state = cookiePairs(started).gh_oauth_state?.value ?? "";
    const bound = await handleApi(
      new Request(`${ORIGIN}/api/v1/auth/github/callback?code=abc&state=${state}`, {
        headers: {
          cookie: `gh_oauth_state=${state}; gh_oauth_intent=bind; ${SESSION_COOKIE}`,
        },
      }),
      envFor(script.db),
    );
    expect(bound.status).toBe(302);
    expect(bound.headers.get("location")).toBe("/users?github=bound");
    expect(sessionCookie(bound)).toBeNull();
    expect(script.sessions).toHaveLength(1);
    expect(script.meta.get("github_id")).toBe("7");
    expect(script.meta.get("github_login")).toBe("other-dev");
    // Binding never touches the profile username: unset stays unset.
    expect(script.meta.has("profile_username")).toBe(false);

    installGithub({ id: 7, login: "renamed-dev", avatar_url: "https://avatars.githubusercontent.com/u/7?v=2" });
    const byId = await callback(script, "login", "next-state");
    expect(byId.headers.get("location")).toBe("/");
    expect(sessionCookie(byId)).toBeTruthy();
    expect(script.meta.get("github_login")).toBe("renamed-dev");
    expect(script.meta.get("github_avatar_url")).toBe("https://avatars.githubusercontent.com/u/7?v=2");
    expect(script.meta.has("profile_username")).toBe(false);

    const unbind = await handleApi(
      new Request(`${ORIGIN}/api/v1/auth/github/unbind`, { method: "POST", headers: { cookie: SESSION_COOKIE } }),
      envFor(script.db),
    );
    expect(unbind.status).toBe(200);
    expect(await unbind.json()).toEqual({ ok: true });
    expect(script.meta.has("github_id")).toBe(false);
    expect(script.meta.has("github_login")).toBe(false);
    expect(script.meta.has("github_avatar_url")).toBe(false);
    expect(script.meta.has("profile_username")).toBe(false);

    installGithub({ id: 7, login: "renamed-dev", avatar_url: "https://avatars.githubusercontent.com/u/7?v=2" });
    const denied = await callback(script, "login", "after-unbind");
    expect(denied.headers.get("location")).toBe("/login?error=github_forbidden");
    expect(sessionCookie(denied)).toBeNull();
    expect(script.meta.has("github_id")).toBe(false);
  });

  it("replaces an existing binding when the admin GitHub account signs in", async () => {
    const script = makeDb({
      meta: { github_id: "7", github_login: "other-dev", github_avatar_url: "https://avatars.githubusercontent.com/u/7" },
    });
    installGithub({ id: 99, login: "octocat", avatar_url: "https://avatars.githubusercontent.com/u/99" });
    const response = await callback(script, "login", "state-token");
    expect(response.headers.get("location")).toBe("/");
    expect(script.meta.get("github_id")).toBe("99");
    expect(script.meta.get("github_login")).toBe("octocat");

    installGithub({ id: 7, login: "other-dev", avatar_url: "https://avatars.githubusercontent.com/u/7" });
    const stale = await callback(script, "login", "stale");
    expect(stale.headers.get("location")).toBe("/login?error=github_forbidden");
    expect(script.meta.get("github_id")).toBe("99");
  });

  it("stores a custom avatar and returns it from me", async () => {
    const script = makeDb({ meta: { github_id: "7", github_login: "other-dev", github_avatar_url: "https://avatars.githubusercontent.com/u/7" } });
    const env = envFor(script.db);
    const anonymous = await handleApi(
      new Request(`${ORIGIN}/api/v1/auth/avatar`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image: PNG }),
      }),
      env,
    );
    expect(anonymous.status).toBe(401);

    const gif = await handleApi(avatarRequest("data:image/gif;base64,R0lGODlhAQABAAAAACw="), env);
    expect(gif.status).toBe(400);
    expect(await gif.json()).toMatchObject({ error: "仅支持 PNG、JPEG 或 WebP 图片" });

    const garbage = await handleApi(avatarRequest("data:image/png;base64,AAAA"), env);
    expect(garbage.status).toBe(400);
    expect(await garbage.json()).toMatchObject({ error: "图片数据无效" });

    const huge = await handleApi(avatarRequest(`data:image/png;base64,${"A".repeat(400 * 1024)}`), env);
    expect(huge.status).toBe(400);
    expect(await huge.json()).toMatchObject({ error: "图片过大，请控制在 400KB 以内" });
    expect(script.meta.has("avatar_data")).toBe(false);

    const saved = await handleApi(avatarRequest(PNG), env);
    expect(saved.status).toBe(200);
    expect(script.meta.get("avatar_data")).toBe(PNG);
    const me = await handleApi(new Request(`${ORIGIN}/api/v1/auth/me`, { headers: { cookie: SESSION_COOKIE } }), env);
    expect(await me.json()).toMatchObject({
      user: {
        avatar_data: PNG,
        github: { login: "other-dev", avatar_url: "https://avatars.githubusercontent.com/u/7" },
      },
    });

    const removed = await handleApi(
      new Request(`${ORIGIN}/api/v1/auth/avatar`, { method: "DELETE", headers: { cookie: SESSION_COOKIE } }),
      env,
    );
    expect(removed.status).toBe(200);
    expect(script.meta.has("avatar_data")).toBe(false);
    const after = await handleApi(new Request(`${ORIGIN}/api/v1/auth/me`, { headers: { cookie: SESSION_COOKIE } }), env);
    expect(await after.json()).toMatchObject({
      user: { avatar_data: null, github: { login: "other-dev", avatar_url: "https://avatars.githubusercontent.com/u/7" } },
    });
  });

  it("requires a session to unbind", async () => {
    const script = makeDb({ meta: { github_id: "7", github_login: "other-dev" } });
    const anonymous = await handleApi(
      new Request(`${ORIGIN}/api/v1/auth/github/unbind`, { method: "POST" }),
      envFor(script.db),
    );
    expect(anonymous.status).toBe(401);
    expect(script.meta.get("github_id")).toBe("7");

    const cross = await handleApi(
      new Request(`${ORIGIN}/api/v1/auth/github/unbind`, {
        method: "POST",
        headers: { cookie: SESSION_COOKIE, origin: "https://evil.test" },
      }),
      envFor(script.db),
    );
    expect(cross.status).toBe(403);
    expect(script.meta.get("github_id")).toBe("7");
  });
});

function avatarRequest(image: string): Request {
  return new Request(`${ORIGIN}/api/v1/auth/avatar`, {
    method: "POST",
    headers: { cookie: SESSION_COOKIE, "content-type": "application/json" },
    body: JSON.stringify({ image }),
  });
}

function callback(
  script: ReturnType<typeof makeDb>,
  intent: "login" | "bind",
  state: string,
  extra: Record<string, string> = {},
): Promise<Response> {
  return handleApi(
    new Request(`${ORIGIN}/api/v1/auth/github/callback?code=abc&state=${state}`, {
      headers: { cookie: `gh_oauth_state=${state}; gh_oauth_intent=${intent}` },
    }),
    envFor(script.db, extra),
  );
}

type GithubUser = { id: number; login: string; avatar_url: string; name?: string };

function installGithub(user: GithubUser, tokenStatus = 200) {
  const calls: Array<{ input: unknown; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    calls.push({ input, init: init ?? {} });
    const url = String(input);
    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      if (tokenStatus !== 200) return new Response("nope", { status: tokenStatus });
      return Response.json({ access_token: "gho_test_token", token_type: "bearer" });
    }
    if (url === "https://api.github.com/user") {
      return Response.json({ id: user.id, login: user.login, avatar_url: user.avatar_url, name: user.name ?? null });
    }
    return new Response("missing", { status: 404 });
  });
  return calls;
}
