import { describe, expect, it } from "vitest";
import pkg from "../package.json";
import { pickDesignatedUser } from "../src/admin-user";
import { hashPassword } from "../src/auth";
import { SINGLE_USER_MERGED_KEY } from "../src/db";
import { handleApi } from "../src/routes/api";
import type { UserRecord } from "../src/types";

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const COOKIE = "smsinbox_session=sms_session_token_value";

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: ADMIN_ID,
    username: "root",
    role: "admin",
    disabled_at: null,
    expires_at: Date.now() + 60_000,
    ...overrides,
  };
}

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: MEMBER_ID,
    username: "alice",
    role: "member",
    disabled_at: null,
    created_at: 1_000,
    password_hash: "should-not-leak",
    ...overrides,
  };
}

function makeDb() {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  let usernameReads = 0;
  const state = {
    session: session() as Record<string, unknown> | null,
    byId: new Map<string, Record<string, unknown>>(),
    usernameUser: null as Record<string, unknown> | null,
    usernameUserAfter: null as Record<string, unknown> | null,
    enabledAdmins: 1,
    admins: 1,
    userTotal: 0,
    schemaMarker: null as string | null,
    schemaMissing: false,
    users: [] as Array<Record<string, unknown>>,
    failInsert: false,
  };
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        sql,
        get args() {
          return args;
        },
        bind(...bound: unknown[]) {
          args = bound;
          return statement;
        },
        async first() {
          calls.push({ sql, args });
          if (sql.includes("schema_meta")) {
            if (state.schemaMissing) throw new Error("D1_ERROR: no such table: schema_meta: SQLITE_ERROR");
            return state.schemaMarker ? { value: state.schemaMarker } : null;
          }
          if (sql.includes("FROM sessions")) return state.session;
          if (sql.includes("disabled_at IS NULL")) return { total: state.enabledAdmins };
          if (sql.includes("COUNT(*)") && sql.includes("role = 'admin'")) return { total: state.admins };
          if (sql.includes("COUNT(*)") && sql.includes("FROM users")) return { total: state.userTotal };
          if (sql.includes("WHERE username")) {
            usernameReads += 1;
            if (usernameReads > 1 && state.usernameUserAfter) return state.usernameUserAfter;
            return state.usernameUser;
          }
          if (sql.includes("WHERE id")) return state.byId.get(String(args[0])) ?? null;
          return null;
        },
        async all() {
          calls.push({ sql, args });
          return { results: state.users };
        },
        async run() {
          calls.push({ sql, args });
          if (state.failInsert && sql.includes("INSERT INTO users")) {
            throw new Error("UNIQUE constraint failed: users.username");
          }
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
    async batch(statements: Array<{ sql: string; args: unknown[] }>) {
      for (const statement of statements) calls.push({ sql: statement.sql, args: statement.args });
    },
  };
  return { db: db as unknown as D1Database, calls, state };
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

function authed(path: string, method = "GET", body?: unknown) {
  return new Request(`https://sms.example${path}`, {
    method,
    headers: {
      cookie: COOKIE,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function loginRequest(username: string, password: string) {
  return new Request("https://sms.example/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

describe("pickDesignatedUser", () => {
  const row = (id: string, username: string): UserRecord => ({
    id,
    username,
    password_hash: "x",
    role: "admin",
    disabled_at: null,
    created_at: 0,
  });

  it("matches ADMIN_USERNAME ignoring case", () => {
    const users = [row("1", "alice"), row("2", "ChuYiyue")];
    expect(pickDesignatedUser(users, "chuyiyue")?.id).toBe("2");
    expect(pickDesignatedUser(users, "CHUYIYUE")?.id).toBe("2");
    expect(pickDesignatedUser(users, "mallory")).toBeNull();
  });
});

describe("single admin", () => {
  it("closes user list, create, role, and delete routes", async () => {
    const anonymous = await handleApi(new Request("https://sms.example/api/v1/users"), envFor(makeDb().db));
    expect(anonymous.status).toBe(410);
    expect(await anonymous.json()).toMatchObject({ error: "用户管理已关闭" });

    const script = makeDb();
    const listed = await handleApi(authed("/api/v1/users"), envFor(script.db));
    const created = await handleApi(
      authed("/api/v1/users", "POST", { username: "alice", password: "s3cret-pass", role: "member" }),
      envFor(script.db),
    );
    const patched = await handleApi(
      authed(`/api/v1/users/${MEMBER_ID}`, "POST", { role: "admin", disabled: true, password: "replacement-pass" }),
      envFor(script.db),
    );
    const removed = await handleApi(authed(`/api/v1/users/${MEMBER_ID}`, "DELETE"), envFor(script.db));
    for (const response of [listed, created, patched, removed]) {
      expect(response.status).toBe(410);
      const body = await response.text();
      expect(body).toContain("用户管理已关闭");
      expect(body).not.toContain("should-not-leak");
      expect(body).not.toContain("s3cret-pass");
      expect(body).not.toContain("replacement-pass");
    }
    expect(script.calls.some((call) => call.sql.includes("DELETE FROM messages"))).toBe(false);
    expect(script.calls.some((call) => call.sql.includes("INSERT INTO users"))).toBe(false);
    expect(script.calls).toHaveLength(0);
  });

  it("refuses to guess between multiple rows when ADMIN_USERNAME matches none", async () => {
    const script = makeDb();
    script.state.users = [
      { ...account(), id: ADMIN_ID, username: "alice", role: "admin" },
      { ...account(), id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", username: "bob", role: "admin" },
    ];
    const response = await handleApi(loginRequest("root", "secret"), envFor(script.db));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("无法确定管理员") });
    expect(script.calls.some((call) => call.sql.includes("INSERT INTO users"))).toBe(false);
    expect(script.calls.some((call) => call.sql.includes("INSERT INTO sessions"))).toBe(false);
  });

  it("rejects a member password and a disabled account", async () => {
    const hash = await hashPassword("s3cret-pass");
    const member = makeDb();
    member.state.users = [{ ...account(), password_hash: hash }];
    const denied = await handleApi(loginRequest("alice", "s3cret-pass"), envFor(member.db));
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ error: "仅管理员可以登录" });
    expect(member.calls.some((call) => call.sql.includes("INSERT INTO sessions"))).toBe(false);
    expect(member.calls.some((call) => call.sql.includes("DELETE FROM users"))).toBe(false);

    const blocked = makeDb();
    blocked.state.users = [{ ...account(), password_hash: hash, disabled_at: 50 }];
    const disabled = await handleApi(loginRequest("alice", "s3cret-pass"), envFor(blocked.db));
    expect(disabled.status).toBe(401);
    expect(await disabled.json()).toMatchObject({ error: "账号已停用" });
    expect(blocked.calls.some((call) => call.sql.includes("INSERT INTO sessions"))).toBe(false);
  });

  it("promotes the configured admin and merges other rows without deleting messages", async () => {
    const recovery = makeDb();
    recovery.state.users = [
      {
        id: ADMIN_ID,
        username: "root",
        password_hash: "nope",
        role: "member",
        disabled_at: 50,
        created_at: 1,
      },
    ];
    const restored = await handleApi(loginRequest("root", "secret"), envFor(recovery.db));
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ user: { role: "admin", username: "root" } });
    expect(recovery.calls.some((call) => call.sql.includes("role = 'admin'"))).toBe(true);

    const mergeSql = recovery.calls
      .map((call) => call.sql)
      .filter(
        (sql) =>
          sql.startsWith("UPDATE devices") ||
          sql.startsWith("UPDATE notify_channels") ||
          sql.startsWith("DELETE FROM sessions WHERE user_id") ||
          sql.startsWith("DELETE FROM users WHERE id") ||
          sql.startsWith("INSERT INTO schema_meta"),
      );
    expect(mergeSql).toEqual([
      "UPDATE devices SET user_id = ? WHERE user_id <> ?",
      "UPDATE notify_channels SET user_id = ? WHERE user_id <> ?",
      "DELETE FROM sessions WHERE user_id <> ?",
      "DELETE FROM users WHERE id <> ?",
      "INSERT INTO schema_meta (key, value) VALUES (?, ?)",
    ]);
    const deviceUpdate = recovery.calls.find((call) => call.sql.startsWith("UPDATE devices"));
    expect(deviceUpdate?.args).toEqual([ADMIN_ID, ADMIN_ID]);
    expect(recovery.calls.some((call) => call.sql.includes("DELETE FROM messages"))).toBe(false);
    expect(
      recovery.calls.some((call) => call.sql.includes("token_hash") && !call.sql.includes("rate_limits")),
    ).toBe(false);
    expect(recovery.calls.some((call) => call.sql.includes("push_token_hash"))).toBe(false);
    const marker = recovery.calls.find((call) => call.sql.includes("schema_meta"));
    expect(marker?.args[0]).toBe(SINGLE_USER_MERGED_KEY);
  });

  it("does not merge again after the marker is set, and still logs in if the table is missing", async () => {
    const marked = makeDb();
    marked.state.schemaMarker = "1";
    marked.state.users = [
      {
        id: ADMIN_ID,
        username: "root",
        password_hash: "nope",
        role: "admin",
        disabled_at: null,
        created_at: 1,
      },
    ];
    const again = await handleApi(loginRequest("root", "secret"), envFor(marked.db));
    expect(again.status).toBe(200);
    expect(marked.calls.some((call) => call.sql.startsWith("UPDATE devices"))).toBe(false);
    expect(marked.calls.some((call) => call.sql.startsWith("DELETE FROM users"))).toBe(false);

    const legacy = makeDb();
    legacy.state.schemaMissing = true;
    legacy.state.users = marked.state.users;
    const loggedIn = await handleApi(loginRequest("root", "secret"), envFor(legacy.db));
    expect(loggedIn.status).toBe(200);
    expect(legacy.calls.some((call) => call.sql.startsWith("DELETE FROM users"))).toBe(false);
  });

  it("reports the package.json version and serves only the GitHub flag anonymously", async () => {
    const script = makeDb();
    const response = await handleApi(authed("/api/v1/system/info"), envFor(script.db));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      version: pkg.version,
      runtime: "Cloudflare Workers + D1",
    });

    // The login page needs github_enabled before signing in; anonymous
    // callers get exactly that flag and nothing else.
    const anonymous = await handleApi(new Request("https://sms.example/api/v1/system/info"), envFor(makeDb().db));
    expect(anonymous.status).toBe(200);
    const anonBody = (await anonymous.json()) as Record<string, unknown>;
    expect(anonBody).toMatchObject({ ok: true, github_enabled: false });
    expect(anonBody).not.toHaveProperty("version");

    const wrongMethod = await handleApi(authed("/api/v1/system/info", "POST", {}), envFor(makeDb().db));
    expect(wrongMethod.status).toBe(405);
    expect(await wrongMethod.json()).toMatchObject({ error: "方法不允许" });
  });

  it("drops a non-admin session and keeps the admin session", async () => {
    const script = makeDb();
    script.state.session = session({ role: "member", disabled_at: null });
    const response = await handleApi(authed("/api/v1/auth/me"), envFor(script.db));
    expect(response.status).toBe(401);
    expect(script.calls.some((call) => call.sql.includes("DELETE FROM sessions WHERE id"))).toBe(true);

    const disabled = makeDb();
    disabled.state.session = session({ role: "member", disabled_at: 80 });
    const blocked = await handleApi(authed("/api/v1/auth/me"), envFor(disabled.db));
    expect(blocked.status).toBe(401);
    expect(disabled.calls.some((call) => call.sql.includes("DELETE FROM sessions WHERE id"))).toBe(true);

    const active = makeDb();
    const me = await handleApi(authed("/api/v1/auth/me"), envFor(active.db));
    expect(await me.json()).toMatchObject({ user: { role: "admin" } });
    expect(active.calls.some((call) => call.sql.includes("DELETE FROM sessions WHERE id"))).toBe(false);
  });
});
