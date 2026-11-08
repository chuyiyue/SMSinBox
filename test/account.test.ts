import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword, sha256Hex, verifyPassword } from "../src/auth";
import {
  LOGIN_FAILURE_LIMIT,
  loginPairKey,
  loginWindowStart,
} from "../src/db";
import { handleApi } from "../src/routes/api";

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN = "sms_session_token_value";
const COOKIE = `smsinbox_session=${TOKEN}`;
const PASSWORD = "s3cret-pass";
const OTHER_SESSION = "b".repeat(64);
const FOREIGN_SESSION = "c".repeat(64);
const EXPIRED_SESSION = "d".repeat(64);

type UserRow = {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  disabled_at: number | null;
  created_at: number;
};

type SessionRow = { id: string; user_id: string; expires_at: number; created_at: number };
type RateRow = { token_hash: string; window_start: number; count: number };

let sessionId = "";
let passwordHash = "";

beforeAll(async () => {
  sessionId = await sha256Hex(TOKEN);
  passwordHash = await hashPassword(PASSWORD);
});

function adminUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: ADMIN_ID,
    username: "root",
    password_hash: passwordHash,
    role: "admin",
    disabled_at: null,
    created_at: 1_000,
    ...overrides,
  };
}

function makeDb(options?: { users?: UserRow[]; sessions?: SessionRow[]; rates?: RateRow[] }) {
  const users = options?.users ?? [adminUser()];
  const now = Date.now();
  const sessions = options?.sessions ?? [
    { id: sessionId, user_id: ADMIN_ID, expires_at: now + 60_000, created_at: now - 10_000 },
    { id: OTHER_SESSION, user_id: ADMIN_ID, expires_at: now + 60_000, created_at: now - 20_000 },
    { id: FOREIGN_SESSION, user_id: OTHER_USER, expires_at: now + 60_000, created_at: now - 5_000 },
    { id: EXPIRED_SESSION, user_id: ADMIN_ID, expires_at: now - 1_000, created_at: now - 30_000 },
  ];
  const rates = options?.rates ?? [];
  // Seeded with the single-user merge marker so logins keep short-circuiting
  // the merge exactly like the old "any schema_meta read returns 1" stub did.
  const meta = new Map<string, string>([["single_user_merged_at", "1"]]);
  const calls: Array<{ sql: string; args: unknown[] }> = [];

  function remember(sql: string, args: unknown[]) {
    calls.push({ sql, args: [...args] });
  }

  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        sql,
        bind(...bound: unknown[]) {
          args = bound;
          return statement;
        },
        async first() {
          remember(sql, args);
          if (sql.includes("FROM schema_meta")) {
            const value = meta.get(String(args[0]));
            return value === undefined ? null : { value };
          }
          if (sql.includes("SELECT count FROM rate_limits")) {
            const row = rates.find((item) => item.token_hash === args[0] && item.window_start === args[1]);
            return row ? { count: row.count } : null;
          }
          if (sql.includes("INSERT INTO rate_limits")) {
            const key = String(args[0]);
            const windowStart = Number(args[1]);
            const existing = rates.find((item) => item.token_hash === key && item.window_start === windowStart);
            if (existing) existing.count += 1;
            else rates.push({ token_hash: key, window_start: windowStart, count: 1 });
            return { count: rates.find((item) => item.token_hash === key && item.window_start === windowStart)?.count ?? 1 };
          }
          if (sql.includes("COUNT(*)") && sql.includes("FROM users")) return { total: users.length };
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
            };
          }
          if (sql.includes("WHERE username")) return users.find((item) => item.username === args[0]) ?? null;
          if (sql.includes("password_hash") && sql.includes("WHERE id")) {
            return users.find((item) => item.id === args[0]) ?? null;
          }
          throw new Error(`unhandled first: ${sql}`);
        },
        async all() {
          remember(sql, args);
          if (sql.includes("FROM users") && sql.includes("ORDER BY created_at")) {
            return { results: users };
          }
          if (sql.includes("FROM sessions") && sql.includes("expires_at >")) {
            const rows = sessions
              .filter((item) => item.user_id === args[0] && item.expires_at > Number(args[1]))
              .sort((left, right) => right.created_at - left.created_at || left.id.localeCompare(right.id))
              .map(({ id, created_at, expires_at }) => ({ id, created_at, expires_at }));
            return { results: rows };
          }
          throw new Error(`unhandled all: ${sql}`);
        },
        async run() {
          remember(sql, args);
          let changes = 0;
          if (sql.startsWith("UPDATE users SET password_hash")) {
            const user = users.find((item) => item.id === args[1]);
            if (user) {
              user.password_hash = String(args[0]);
              changes = 1;
            }
          } else if (sql.startsWith("UPDATE users SET username")) {
            const next = String(args[0]);
            const user = users.find((item) => item.id === args[1]);
            if (users.some((item) => item.username === next && item.id !== user?.id)) {
              throw new Error("UNIQUE constraint failed: users.username");
            }
            if (user) {
              user.username = next;
              changes = 1;
            }
          } else if (sql.startsWith("UPDATE users SET role")) {
            const user = users.find((item) => item.id === args[1]);
            if (user) {
              user.role = "admin";
              user.disabled_at = null;
              changes = 1;
            }
          } else if (sql.startsWith("DELETE FROM sessions WHERE user_id = ? AND id <> ?")) {
            const before = sessions.length;
            const kept = sessions.filter((item) => item.user_id !== args[0] || item.id === args[1]);
            changes = before - kept.length;
            sessions.splice(0, sessions.length, ...kept);
          } else if (sql.startsWith("DELETE FROM sessions WHERE user_id = ? AND id = ?")) {
            const index = sessions.findIndex((item) => item.user_id === args[0] && item.id === args[1]);
            if (index >= 0) {
              sessions.splice(index, 1);
              changes = 1;
            }
          } else if (sql.startsWith("DELETE FROM totp_tickets WHERE user_id = ?")) {
            changes = 0;
          } else if (sql.startsWith("DELETE FROM sessions WHERE user_id = ?")) {
            const before = sessions.length;
            const kept = sessions.filter((item) => item.user_id !== args[0]);
            changes = before - kept.length;
            sessions.splice(0, sessions.length, ...kept);
          } else if (sql.startsWith("DELETE FROM sessions WHERE id = ?")) {
            const index = sessions.findIndex((item) => item.id === args[0]);
            if (index >= 0) {
              sessions.splice(index, 1);
              changes = 1;
            }
          } else if (sql.startsWith("DELETE FROM rate_limits WHERE token_hash = ? AND window_start = ?")) {
            const index = rates.findIndex((item) => item.token_hash === args[0] && item.window_start === args[1]);
            if (index >= 0) {
              rates.splice(index, 1);
              changes = 1;
            }
          } else if (sql.startsWith("INSERT INTO sessions")) {
            sessions.push({
              id: String(args[0]),
              user_id: String(args[1]),
              expires_at: Number(args[2]),
              created_at: Number(args[3]),
            });
            changes = 1;
          } else if (sql.startsWith("INSERT INTO users")) {
            users.push({
              id: String(args[0]),
              username: String(args[1]),
              password_hash: String(args[2]),
              role: String(args[3]),
              disabled_at: null,
              created_at: Number(args[4]),
            });
            changes = 1;
          } else if (sql.startsWith("INSERT INTO schema_meta")) {
            meta.set(String(args[0]), String(args[1]));
            changes = 1;
          } else if (sql.startsWith("DELETE FROM schema_meta")) {
            changes = meta.delete(String(args[0])) ? 1 : 0;
          } else {
            throw new Error(`unhandled run: ${sql}`);
          }
          return { meta: { changes } };
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
  return { db: db as unknown as D1Database, calls, users, sessions, rates, meta };
}

function envFor(db: D1Database): Env {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response("") },
    RETENTION_DAYS: "90",
    CONTENT_KEY: "",
    ADMIN_USERNAME: "root",
    ADMIN_PASSWORD: "secret",
  } as unknown as Env;
}

function authed(path: string, method = "GET", body?: unknown, headers?: Record<string, string>) {
  return new Request(`https://sms.example${path}`, {
    method,
    headers: {
      cookie: COOKIE,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function loginRequest(username: string, password: string, headers?: Record<string, string>) {
  return new Request("https://sms.example/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ username, password }),
  });
}

describe("admin account", () => {
  it("no longer serves the legacy username endpoint", async () => {
    const script = makeDb();
    for (const body of [{}, { username: "owner" }, { current_password: PASSWORD, username: "owner" }]) {
      const response = await handleApi(authed("/api/v1/auth/username", "POST", body), envFor(script.db));
      expect(response.status).toBe(404);
    }
    expect(script.users[0]?.username).toBe("root");
    expect(script.calls.some((call) => call.sql.startsWith("UPDATE users SET username"))).toBe(false);
    expect(script.calls.some((call) => call.sql.includes("INSERT INTO users"))).toBe(false);
  });

  it("round-trips the profile username through schema_meta and me", async () => {
    const script = makeDb();
    const before = await handleApi(authed("/api/v1/auth/me"), envFor(script.db));
    expect(before.status).toBe(200);
    expect(await before.json()).toMatchObject({ user: { profile_username: "" } });

    const saved = await handleApi(
      authed("/api/v1/auth/profile", "POST", { username: "octocat" }),
      envFor(script.db),
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ ok: true, profile_username: "octocat" });
    expect(script.meta.get("profile_username")).toBe("octocat");
    // The nickname never touches the login username on the users row.
    expect(script.users[0]?.username).toBe("root");
    expect(script.calls.some((call) => call.sql.startsWith("UPDATE users SET username"))).toBe(false);

    const after = await handleApi(authed("/api/v1/auth/me"), envFor(script.db));
    expect(await after.json()).toMatchObject({ user: { profile_username: "octocat" } });

    const single = await handleApi(
      authed("/api/v1/auth/profile", "POST", { username: "a" }),
      envFor(script.db),
    );
    expect(single.status).toBe(200);
    expect(script.meta.get("profile_username")).toBe("a");

    const cleared = await handleApi(
      authed("/api/v1/auth/profile", "POST", { username: "" }),
      envFor(script.db),
    );
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ ok: true, profile_username: "" });
    expect(script.meta.has("profile_username")).toBe(false);
    const clearedMe = await handleApi(authed("/api/v1/auth/me"), envFor(script.db));
    expect(await clearedMe.json()).toMatchObject({ user: { profile_username: "" } });
  });

  it("rejects invalid profile usernames and requires a session to set one", async () => {
    const script = makeDb();
    // Any display name goes (the avatar falls back to a generated one);
    // only overlong names and control characters are refused.
    for (const username of ["a".repeat(40), "octo\u0007cat"]) {
      const response = await handleApi(
        authed("/api/v1/auth/profile", "POST", { username }),
        envFor(script.db),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: "用户名需为 1 到 39 个字符",
      });
    }
    expect(script.meta.has("profile_username")).toBe(false);
    for (const username of ["-octocat", "octo cat", "octo_cat", "用户名"]) {
      const response = await handleApi(
        authed("/api/v1/auth/profile", "POST", { username }),
        envFor(script.db),
      );
      expect(response.status).toBe(200);
      expect(script.meta.get("profile_username")).toBe(username);
    }
    script.meta.delete("profile_username");

    const anonymous = await handleApi(
      new Request("https://sms.example/api/v1/auth/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "octocat" }),
      }),
      envFor(script.db),
    );
    expect(anonymous.status).toBe(401);
    expect(script.meta.has("profile_username")).toBe(false);
  });

  it("requires the submitted username to match the admin row, ignoring case", async () => {
    const script = makeDb();
    const ok = await handleApi(loginRequest("root", PASSWORD), envFor(script.db));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ user: { id: ADMIN_ID, role: "admin" } });
    expect(script.calls.some((call) => call.sql.startsWith("UPDATE users SET username"))).toBe(false);
    expect(script.users).toHaveLength(1);

    const upper = makeDb();
    const cased = await handleApi(loginRequest("ROOT", PASSWORD), envFor(upper.db));
    expect(cased.status).toBe(200);

    // A wrong username fails exactly like a wrong password: same status and
    // same wording, so the response never says which field was wrong.
    const wrongName = makeDb();
    const denied = await handleApi(loginRequest("someone-else", PASSWORD), envFor(wrongName.db));
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ error: "密码错误" });
    expect(wrongName.calls.some((call) => call.sql.includes("INSERT INTO sessions"))).toBe(false);

    const missing = makeDb();
    const bare = await handleApi(
      new Request("https://sms.example/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: PASSWORD }),
      }),
      envFor(missing.db),
    );
    expect(bare.status).toBe(400);
    expect(await bare.json()).toMatchObject({ error: "请填写用户名" });
    expect(missing.rates).toHaveLength(0);

    const wrong = makeDb();
    const deniedPassword = await handleApi(loginRequest("root", "wrong-pass"), envFor(wrong.db));
    expect(deniedPassword.status).toBe(401);
    expect(await deniedPassword.json()).toMatchObject({ error: "密码错误" });
  });

  it("refuses login when no admin row has been synced", async () => {
    const script = makeDb({ users: [], sessions: [] });
    const wrongName = await handleApi(loginRequest("someone-else", "secret"), envFor(script.db));
    expect(wrongName.status).toBe(503);
    expect(await wrongName.json()).toMatchObject({ error: "管理员尚未同步，请先完成部署" });
    expect(script.users).toHaveLength(0);
    expect(script.calls.some((call) => call.sql.includes("INSERT INTO users"))).toBe(false);

    const created = await handleApi(loginRequest("root", "secret"), envFor(script.db));
    expect(created.status).toBe(503);
    expect(await created.json()).toMatchObject({ error: "管理员尚未同步，请先完成部署" });
    expect(script.users).toHaveLength(0);
    expect(script.calls.some((call) => call.sql.includes("INSERT INTO sessions"))).toBe(false);
  });

  it("changes the password, revokes every session, and clears the cookie", async () => {
    const script = makeDb();
    const short = await handleApi(
      authed("/api/v1/auth/password", "POST", { current_password: PASSWORD, password: "short" }),
      envFor(script.db),
    );
    expect(short.status).toBe(400);
    expect(await short.json()).toMatchObject({ error: "新密码需要 8 到 256 个字符" });

    const same = await handleApi(
      authed("/api/v1/auth/password", "POST", { current_password: PASSWORD, password: PASSWORD }),
      envFor(script.db),
    );
    expect(same.status).toBe(400);
    expect(await same.json()).toMatchObject({ error: "新密码不能与当前密码相同" });
    expect(script.sessions.some((item) => item.user_id === ADMIN_ID)).toBe(true);

    const changed = await handleApi(
      authed("/api/v1/auth/password", "POST", { current_password: PASSWORD, password: "replacement-pass" }),
      envFor(script.db),
    );
    const changedBody = await changed.json();
    expect(changed.status).toBe(200);
    expect(changedBody).toEqual({ ok: true });
    expect(changed.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(changed.headers.get("set-cookie")).toContain("HttpOnly");
    expect(changed.headers.get("set-cookie")).toContain("SameSite=Lax");
    const body = JSON.stringify(changedBody);
    expect(body).not.toContain("replacement-pass");
    expect(body).not.toContain(passwordHash);
    expect(script.sessions.some((item) => item.user_id === ADMIN_ID)).toBe(false);
    expect(script.sessions.some((item) => item.user_id === OTHER_USER)).toBe(true);
    expect(script.calls.some((call) => call.sql === "DELETE FROM sessions WHERE user_id = ?")).toBe(true);
    expect(script.calls.some((call) => call.sql.includes("INSERT INTO users"))).toBe(false);
    expect(await verifyPassword("replacement-pass", script.users[0]?.password_hash ?? "")).toBe(true);
    expect(await verifyPassword(PASSWORD, script.users[0]?.password_hash ?? "")).toBe(false);

    const later = await handleApi(authed("/api/v1/auth/me"), envFor(script.db));
    expect(later.status).toBe(401);
  });

  it("rejects cross-site account writes, including same-site and a null origin", async () => {
    const script = makeDb();
    const cases: Array<Record<string, string>> = [
      { origin: "https://evil.test" },
      { origin: "https://sms.example", "sec-fetch-site": "same-site" },
      { origin: "null", "sec-fetch-site": "same-origin" },
    ];
    for (const headers of cases) {
      const response = await handleApi(
        authed("/api/v1/auth/password", "POST", { current_password: PASSWORD, password: "replacement-pass" }, headers),
        envFor(script.db),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "跨站请求被拒绝" });
    }
    expect(script.users[0]?.password_hash).toBe(passwordHash);
    expect(script.calls.some((call) => call.sql.startsWith("UPDATE users SET password_hash"))).toBe(false);

    const allowed = await handleApi(
      authed(
        "/api/v1/auth/password",
        "POST",
        { current_password: PASSWORD, password: "replacement-pass" },
        { origin: "https://sms.example", "sec-fetch-site": "same-origin" },
      ),
      envFor(script.db),
    );
    expect(allowed.status).toBe(200);
  });

  it("stops guessing the current password", async () => {
    const script = makeDb();
    for (let attempt = 0; attempt < LOGIN_FAILURE_LIMIT; attempt += 1) {
      const response = await handleApi(
        authed("/api/v1/auth/password", "POST", { current_password: "wrong-pass", password: "replacement-pass" }),
        envFor(script.db),
      );
      expect(response.status).toBe(401);
    }
    const limited = await handleApi(
      authed("/api/v1/auth/password", "POST", { current_password: PASSWORD, password: "replacement-pass" }),
      envFor(script.db),
    );
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: "尝试过多，请稍后再试" });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(script.users[0]?.password_hash).toBe(passwordHash);

    script.rates.splice(0, script.rates.length);
    const changed = await handleApi(
      authed("/api/v1/auth/password", "POST", { current_password: PASSWORD, password: "replacement-pass" }),
      envFor(script.db),
    );
    expect(changed.status).toBe(200);
  });
});

describe("sessions", () => {
  it("lists only this user's live sessions and marks the current one", async () => {
    const script = makeDb();
    const anonymous = await handleApi(new Request("https://sms.example/api/v1/auth/sessions"), envFor(script.db));
    expect(anonymous.status).toBe(401);

    const response = await handleApi(authed("/api/v1/auth/sessions"), envFor(script.db));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      sessions: Array<{ id: string; current: boolean; created_at: number; expires_at: number }>;
    };
    expect(body.sessions.map((item) => item.id)).toEqual([sessionId, OTHER_SESSION]);
    expect(body.sessions[0]).toMatchObject({ current: true });
    expect(body.sessions[1]).toMatchObject({ current: false });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(JSON.stringify(body)).not.toContain("password_hash");
    expect(body.sessions.some((item) => item.id === FOREIGN_SESSION || item.id === EXPIRED_SESSION)).toBe(false);
  });

  it("revokes other sessions and a chosen session without touching someone else", async () => {
    const script = makeDb();
    const others = await handleApi(authed("/api/v1/auth/sessions/revoke-others", "POST"), envFor(script.db));
    expect(others.status).toBe(200);
    expect(script.sessions.map((item) => item.id).sort()).toEqual([FOREIGN_SESSION, sessionId].sort());

    const missing = await handleApi(authed(`/api/v1/auth/sessions/${FOREIGN_SESSION}`, "DELETE"), envFor(script.db));
    expect(missing.status).toBe(404);
    expect(script.sessions.some((item) => item.id === FOREIGN_SESSION)).toBe(true);

    const bad = await handleApi(authed("/api/v1/auth/sessions/not-a-session", "DELETE"), envFor(script.db));
    expect(bad.status).toBe(400);

    const current = await handleApi(authed(`/api/v1/auth/sessions/${sessionId}`, "DELETE"), envFor(script.db));
    expect(current.status).toBe(200);
    expect(current.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(script.sessions.some((item) => item.id === sessionId)).toBe(false);
    expect(script.sessions.some((item) => item.id === FOREIGN_SESSION)).toBe(true);
  });

  it("rejects cross-site session revocation and leaves every session alone", async () => {
    const script = makeDb();
    const cases: Array<Record<string, string>> = [
      { origin: "https://evil.test" },
      { origin: "https://sms.example", "sec-fetch-site": "same-site" },
      { origin: "null", "sec-fetch-site": "same-origin" },
    ];
    for (const headers of cases) {
      const others = await handleApi(
        authed("/api/v1/auth/sessions/revoke-others", "POST", {}, headers),
        envFor(script.db),
      );
      expect(others.status).toBe(403);
      expect(await others.json()).toMatchObject({ error: "跨站请求被拒绝" });

      const one = await handleApi(
        authed(`/api/v1/auth/sessions/${OTHER_SESSION}`, "DELETE", undefined, headers),
        envFor(script.db),
      );
      expect(one.status).toBe(403);
      expect(await one.json()).toMatchObject({ error: "跨站请求被拒绝" });
    }
    expect(script.sessions).toHaveLength(4);
    expect(script.calls.some((call) => call.sql.startsWith("DELETE FROM sessions"))).toBe(false);

    const anonymous = await handleApi(
      new Request("https://sms.example/api/v1/auth/sessions/revoke-others", { method: "POST" }),
      envFor(script.db),
    );
    expect(anonymous.status).toBe(401);
    const anonymousDelete = await handleApi(
      new Request(`https://sms.example/api/v1/auth/sessions/${OTHER_SESSION}`, { method: "DELETE" }),
      envFor(script.db),
    );
    expect(anonymousDelete.status).toBe(401);
    expect(script.sessions).toHaveLength(4);
  });

  it("keeps logout to the current session", async () => {
    const script = makeDb();
    const response = await handleApi(authed("/api/v1/auth/logout", "POST"), envFor(script.db));
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(script.sessions.some((item) => item.id === sessionId)).toBe(false);
    expect(script.sessions.some((item) => item.id === OTHER_SESSION)).toBe(true);
    expect(script.calls.some((call) => call.sql === "DELETE FROM sessions WHERE id = ?")).toBe(true);
    expect(script.calls.some((call) => call.sql === "DELETE FROM sessions WHERE user_id = ?")).toBe(false);
  });
});

describe("login rate limit", () => {
  it("locks the admin password after repeated failures and clears the counter on success", async () => {
    const script = makeDb();
    const pairKey = await loginPairKey("root", null);
    for (let attempt = 0; attempt < LOGIN_FAILURE_LIMIT; attempt += 1) {
      const response = await handleApi(loginRequest("root", "nope"), envFor(script.db));
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: "密码错误" });
    }
    expect(script.rates.find((row) => row.token_hash === pairKey)?.count).toBe(LOGIN_FAILURE_LIMIT);
    expect(script.calls.filter((call) => call.sql.includes("INSERT INTO sessions"))).toHaveLength(0);

    const limited = await handleApi(loginRequest("root", PASSWORD), envFor(script.db));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: "登录尝试过多，请稍后再试" });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(script.rates.find((row) => row.token_hash === pairKey)?.count).toBe(LOGIN_FAILURE_LIMIT);
    expect(script.calls.filter((call) => call.sql.includes("INSERT INTO rate_limits"))).toHaveLength(LOGIN_FAILURE_LIMIT);

    script.rates[0]!.count = 3;
    const ok = await handleApi(loginRequest("root", PASSWORD), envFor(script.db));
    expect(ok.status).toBe(200);
    expect(script.rates.some((row) => row.token_hash === pairKey)).toBe(false);

    const again = await handleApi(loginRequest("root", "nope"), envFor(script.db));
    expect(again.status).toBe(401);
    expect(script.rates.find((row) => row.token_hash === pairKey)?.count).toBe(1);
  });

  it("locks one username and IP pair without locking other pairs, and ignores a spoofed forwarding header", async () => {
    const ip = "203.0.113.10";
    const pairKey = await loginPairKey("root", ip);
    const script = makeDb({
      rates: [{ token_hash: pairKey, window_start: loginWindowStart(Date.now()), count: LOGIN_FAILURE_LIMIT }],
    });
    const limited = await handleApi(
      loginRequest("root", PASSWORD, { "cf-connecting-ip": ip }),
      envFor(script.db),
    );
    expect(limited.status).toBe(429);
    expect(script.rates).toEqual([
      expect.objectContaining({ token_hash: pairKey, count: LOGIN_FAILURE_LIMIT }),
    ]);

    // The same IP with another username is a different pair and is not locked.
    const otherName = await handleApi(
      loginRequest("alice", PASSWORD, { "cf-connecting-ip": ip }),
      envFor(script.db),
    );
    expect(otherName.status).toBe(401);

    // The same username from another IP is a different pair and can sign in.
    const otherIp = await handleApi(
      loginRequest("root", PASSWORD, { "cf-connecting-ip": "203.0.113.99" }),
      envFor(script.db),
    );
    expect(otherIp.status).toBe(200);

    // A spoofed forwarding header never joins the key: without the
    // Cloudflare header the pair is the username alone, which is not locked.
    const spoofed = await handleApi(
      loginRequest("root", PASSWORD, { "x-forwarded-for": ip }),
      envFor(script.db),
    );
    expect(spoofed.status).toBe(200);
  });

  it("does not count a cross-site login or a request that never reached the password", async () => {
    const script = makeDb();
    const cross = await handleApi(
      loginRequest("root", "nope", { origin: "https://evil.test" }),
      envFor(script.db),
    );
    expect(cross.status).toBe(403);
    const empty = await handleApi(
      new Request("https://sms.example/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      envFor(script.db),
    );
    expect(empty.status).toBe(400);
    expect(script.rates).toHaveLength(0);
    expect(script.calls.some((call) => call.sql.includes("INSERT INTO rate_limits"))).toBe(false);
  });

  it("rejects an env password that does not match the stored hash", async () => {
    const script = makeDb({
      users: [{ ...adminUser(), id: OTHER_USER, username: "alice", password_hash: "stale" }],
      sessions: [],
    });
    const mismatched = await handleApi(loginRequest("root", "secret"), envFor(script.db));
    expect(mismatched.status).toBe(401);
    expect(await mismatched.json()).toMatchObject({ error: "密码错误" });
    expect(script.users[0]?.password_hash).toBe("stale");

    const response = await handleApi(loginRequest("alice", "secret"), envFor(script.db));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "密码错误" });
    expect(script.users[0]?.password_hash).toBe("stale");
    expect(script.users.map((item) => item.username)).toEqual(["alice"]);
    expect(script.calls.some((call) => call.sql.includes("INSERT INTO users"))).toBe(false);
    expect(script.calls.some((call) => call.sql.includes("UPDATE users SET password_hash"))).toBe(false);
    expect(script.calls.some((call) => call.sql.includes("UPDATE users SET role"))).toBe(false);
    expect(script.calls.some((call) => call.sql.includes("INSERT INTO sessions"))).toBe(false);
    expect((await handleApi(authed("/api/v1/users", "POST", { username: "mina", password: "mina-pass-1" }), envFor(script.db))).status).toBe(410);
  });
});

async function legacyHashForTest(password: string, iterations: number): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const saltCopy = new ArrayBuffer(salt.byteLength);
  new Uint8Array(saltCopy).set(salt);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltCopy, iterations },
    key,
    256,
  );
  const encode = (bytes: Uint8Array): string => {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
  };
  return "pbkdf2-sha256$" + iterations + "$" + encode(salt) + "$" + encode(new Uint8Array(bits));
}

describe("login hash upgrade (M3)", () => {
  it("rehashes a legacy-iteration stored hash after a successful login", async () => {
    const legacy = await legacyHashForTest(PASSWORD, 10_000);
    const script = makeDb({ users: [adminUser({ password_hash: legacy })] });
    const response = await handleApi(loginRequest("root", PASSWORD), envFor(script.db));
    expect(response.status).toBe(200);
    const stored = script.users[0]?.password_hash ?? "";
    expect(stored.startsWith("pbkdf2-sha256$100000$")).toBe(true);
    expect(await verifyPassword(PASSWORD, stored)).toBe(true);
  });

  it("does not rewrite a hash already at the current iteration count", async () => {
    const script = makeDb();
    const response = await handleApi(loginRequest("root", PASSWORD), envFor(script.db));
    expect(response.status).toBe(200);
    expect(script.calls.some((call) => call.sql.includes("UPDATE users SET password_hash"))).toBe(false);
  });
});

describe("sensitive write guard (L1)", () => {
  const crossSite = { "sec-fetch-site": "cross-site" };

  it("rejects cross-site writes on device, group, message, channel and totp endpoints before any state change", async () => {
    const script = makeDb();
    const env = envFor(script.db);
    const attempts: Array<Promise<Response>> = [
      handleApi(authed("/api/v1/devices", "POST", { name: "x", platform: "android" }, crossSite), env),
      handleApi(authed("/api/v1/devices/" + ADMIN_ID + "/push", "POST", { action: "revoke" }, crossSite), env),
      handleApi(authed("/api/v1/devices/" + ADMIN_ID + "/pin", "POST", undefined, crossSite), env),
      handleApi(authed("/api/v1/devices/" + ADMIN_ID, "PATCH", { name: "y" }, crossSite), env),
      handleApi(authed("/api/v1/devices/" + ADMIN_ID, "DELETE", undefined, crossSite), env),
      handleApi(authed("/api/v1/device-groups", "POST", { name: "g" }, crossSite), env),
      handleApi(authed("/api/v1/device-groups/" + ADMIN_ID, "DELETE", undefined, crossSite), env),
      handleApi(authed("/api/v1/messages/delete", "POST", { ids: [ADMIN_ID] }, crossSite), env),
      handleApi(authed("/api/v1/notifications", "POST", {}, crossSite), env),
      handleApi(authed("/api/v1/notifications/" + ADMIN_ID, "PATCH", { note: "n" }, crossSite), env),
      handleApi(authed("/api/v1/notifications/" + ADMIN_ID, "DELETE", undefined, crossSite), env),
      handleApi(authed("/api/v1/notifications/" + ADMIN_ID + "/test", "POST", undefined, crossSite), env),
      handleApi(authed("/api/v1/auth/totp/setup", "POST", undefined, crossSite), env),
      handleApi(authed("/api/v1/auth/totp/disable", "POST", {}, crossSite), env),
    ];
    for (const attempt of attempts) {
      const response = await attempt;
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "跨站请求被拒绝" });
    }
    // The guard is the first statement of every handler, ahead of
    // authentication and body parsing, so not one statement reached the
    // database: no state could have changed.
    expect(script.calls).toHaveLength(0);
  });

  it("rejects a same-site logout that the old cross-site check let through", async () => {
    const script = makeDb();
    const response = await handleApi(
      authed("/api/v1/auth/logout", "POST", undefined, { "sec-fetch-site": "same-site" }),
      envFor(script.db),
    );
    expect(response.status).toBe(403);
    expect(script.sessions.some((item) => item.id === sessionId)).toBe(true);
    expect(script.calls).toHaveLength(0);
  });
});
