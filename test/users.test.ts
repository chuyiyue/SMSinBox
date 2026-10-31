import { describe, expect, it } from "vitest";
import { hashPassword } from "../src/auth";
import { handleApi } from "../src/routes/api";

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
          if (sql.includes("FROM sessions")) return state.session;
          if (sql.includes("disabled_at IS NULL")) return { total: state.enabledAdmins };
          if (sql.includes("COUNT(*)") && sql.includes("role = 'admin'")) return { total: state.admins };
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

describe("user administration", () => {
  it("hides the user list from anonymous callers and ordinary users", async () => {
    const anonymous = await handleApi(new Request("https://sms.example/api/v1/users"), envFor(makeDb().db));
    expect(anonymous.status).toBe(401);

    const member = makeDb();
    member.state.session = session({ role: "member" });
    const response = await handleApi(authed("/api/v1/users"), envFor(member.db));
    expect(response.status).toBe(403);
  });

  it("lists accounts without password hashes", async () => {
    const script = makeDb();
    script.state.users = [account(), account({ id: ADMIN_ID, username: "root", role: "admin" })];
    const response = await handleApi(authed("/api/v1/users"), envFor(script.db));
    expect(response.status).toBe(200);
    const body = await response.json() as { users: Array<{ username: string; role: string }> };
    expect(body.users.map((user) => user.username)).toEqual(["alice", "root"]);
    expect(body.users[1]?.role).toBe("admin");
    expect(JSON.stringify(body)).not.toContain("should-not-leak");
  });

  it("creates a member and rejects a short password, a bad username, and a duplicate", async () => {
    const script = makeDb();
    const created = await handleApi(
      authed("/api/v1/users", "POST", { username: "alice", password: "s3cret-pass" }),
      envFor(script.db),
    );
    expect(created.status).toBe(200);
    const body = await created.json() as { user: { role: string; username: string } };
    expect(body.user).toMatchObject({ username: "alice", role: "member", disabled_at: null });
    expect(JSON.stringify(body)).not.toContain("s3cret-pass");
    const inserted = script.calls.find((call) => call.sql.includes("INSERT INTO users"));
    expect(inserted?.args[1]).toBe("alice");
    expect(inserted?.args[3]).toBe("member");
    expect(String(inserted?.args[2]).startsWith("pbkdf2-sha256$")).toBe(true);
    expect(String(inserted?.args[2])).not.toContain("s3cret-pass");

    const invalid = await handleApi(
      authed("/api/v1/users", "POST", { username: ".bob", password: "s3cret-pass" }),
      envFor(makeDb().db),
    );
    expect(invalid.status).toBe(400);

    const short = await handleApi(
      authed("/api/v1/users", "POST", { username: "bob", password: "short" }),
      envFor(makeDb().db),
    );
    expect(short.status).toBe(400);

    const duplicate = makeDb();
    duplicate.state.failInsert = true;
    const conflict = await handleApi(
      authed("/api/v1/users", "POST", { username: "alice", password: "s3cret-pass" }),
      envFor(duplicate.db),
    );
    expect(conflict.status).toBe(409);
  });

  it("refuses to disable or delete yourself, or to demote the last admin", async () => {
    const self = makeDb();
    self.state.byId.set(ADMIN_ID, account({ id: ADMIN_ID, username: "root", role: "admin" }));
    const disabled = await handleApi(
      authed(`/api/v1/users/${ADMIN_ID}`, "POST", { disabled: true }),
      envFor(self.db),
    );
    expect(disabled.status).toBe(400);
    expect(self.calls.some((call) => call.sql.startsWith("UPDATE"))).toBe(false);

    const removed = await handleApi(authed(`/api/v1/users/${ADMIN_ID}`, "DELETE"), envFor(self.db));
    expect(removed.status).toBe(400);

    const demoted = await handleApi(
      authed(`/api/v1/users/${ADMIN_ID}`, "POST", { role: "member" }),
      envFor(self.db),
    );
    expect(demoted.status).toBe(400);
    expect(await demoted.json()).toMatchObject({ error: "不能取消最后一位管理员" });
  });

  it("disables another user immediately and deletes their devices and messages", async () => {
    const script = makeDb();
    script.state.byId.set(MEMBER_ID, account());
    const disabled = await handleApi(
      authed(`/api/v1/users/${MEMBER_ID}`, "POST", { disabled: true }),
      envFor(script.db),
    );
    expect(disabled.status).toBe(200);
    expect(script.calls.some((call) => call.sql.includes("SET disabled_at"))).toBe(true);
    expect(script.calls.some((call) => call.sql.includes("DELETE FROM sessions WHERE user_id"))).toBe(true);

    const deleted = await handleApi(authed(`/api/v1/users/${MEMBER_ID}`, "DELETE"), envFor(script.db));
    expect(deleted.status).toBe(200);
    const sql = script.calls.map((call) => call.sql).join("\n");
    expect(sql).toContain("DELETE FROM messages");
    expect(sql).toContain("DELETE FROM devices");
    expect(sql).toContain("DELETE FROM notify_channels");
    expect(sql).toContain("DELETE FROM users");

    const reset = makeDb();
    reset.state.byId.set(MEMBER_ID, account());
    const response = await handleApi(
      authed(`/api/v1/users/${MEMBER_ID}`, "POST", { password: "replacement-pass" }),
      envFor(reset.db),
    );
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain("replacement-pass");
    const updated = reset.calls.find((call) => call.sql.includes("password_hash"));
    expect(String(updated?.args[0]).startsWith("pbkdf2-sha256$")).toBe(true);
    expect(String(updated?.args[0])).not.toContain("replacement-pass");
    expect(reset.calls.some((call) => call.sql.includes("DELETE FROM sessions WHERE user_id"))).toBe(true);
  });

  it("rejects a disabled password login and lets the configured admin back in", async () => {
    const hash = await hashPassword("s3cret-pass");
    const blocked = makeDb();
    blocked.state.usernameUser = {
      ...account(),
      password_hash: hash,
      disabled_at: 50,
    };
    const denied = await handleApi(
      new Request("https://sms.example/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "alice", password: "s3cret-pass" }),
      }),
      envFor(blocked.db),
    );
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ error: "账号已停用" });
    expect(blocked.calls.some((call) => call.sql.includes("INSERT INTO sessions"))).toBe(false);

    const recovery = makeDb();
    recovery.state.usernameUser = {
      id: ADMIN_ID,
      username: "root",
      password_hash: "nope",
      role: "member",
      disabled_at: 50,
      created_at: 1,
    };
    recovery.state.usernameUserAfter = {
      ...recovery.state.usernameUser,
      role: "admin",
      disabled_at: null,
    };
    const restored = await handleApi(
      new Request("https://sms.example/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "root", password: "secret" }),
      }),
      envFor(recovery.db),
    );
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ user: { role: "admin", username: "root" } });
    expect(recovery.calls.some((call) => call.sql.includes("role = 'admin'"))).toBe(true);
  });

  it("drops an existing session when the account is disabled", async () => {
    const script = makeDb();
    script.state.session = session({ role: "member", disabled_at: 80 });
    const response = await handleApi(authed("/api/v1/auth/me"), envFor(script.db));
    expect(response.status).toBe(401);
    expect(script.calls.some((call) => call.sql.includes("DELETE FROM sessions WHERE id"))).toBe(true);

    const active = makeDb();
    const me = await handleApi(authed("/api/v1/auth/me"), envFor(active.db));
    expect(await me.json()).toMatchObject({ user: { role: "admin" } });
  });
});
