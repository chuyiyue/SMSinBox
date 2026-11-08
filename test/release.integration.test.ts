// Release gate: the worker runs against local D1 and the real migration files.
// The other suites stub SQL text, so they cannot catch a missing column or a rewritten 0005.

import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pkg from "../package.json";
import { Miniflare } from "miniflare";
import { bytesToBase64Url, hashPassword, sha256Hex, verifyPassword } from "../src/auth";
import { seedAdmin } from "./seed-admin";
import { LOGIN_FAILURE_LIMIT, loginRateKey } from "../src/db";
import { ENCRYPTED_PREFIX } from "../src/crypto";
import worker from "../src/index";
import { base32Decode, hotp, totpCounter, TOTP_FAILURE_LIMIT, TOTP_FAILURE_WINDOW_MS } from "../src/totp";

const ORIGIN = "http://smsinbox.test";
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "change-me-please";
const MIGRATION_DIR = "migrations";
const EXPECTED_MIGRATIONS = [
  "0001_init.sql",
  "0002_notify.sql",
  "0003_message_encryption.sql",
  "0004_users.sql",
  "0005_device_push.sql",
  "0006_single_user.sql",
  "0007_totp.sql",
  "0008_device_identity.sql",
  "0009_api_tokens.sql",
  "0010_message_code_source.sql",
  "0011_session_client_info.sql",
  "0012_device_push_secret.sql",
  "0013_api_token_secret.sql",
  "0014_device_pins_groups.sql",
  "0015_device_group_order.sql",
  "0016_notify_channel_note.sql",
  "0017_message_translation.sql",
  "0018_push_logs.sql",
  "0019_user_locale.sql",
];
const TABLES = [
  "api_tokens",
  "push_logs",
  "schema_meta",
  "totp_tickets",
  "totp_recovery_codes",
  "notify_channels",
  "messages",
  "rate_limits",
  "sessions",
  "device_groups",
  "devices",
  "users",
];

const LEGACY_USER = "11111111-1111-4111-8111-111111111111";
const LEGACY_DEVICE = "22222222-2222-4222-8222-222222222222";
const LEGACY_TOKEN = "sms_legacy_device_token_0001";

let mf: Miniflare;
let env: Env;

function migrationFiles(): string[] {
  return readdirSync(MIGRATION_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

function statementsIn(file: string): string[] {
  return readFileSync(`${MIGRATION_DIR}/${file}`, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

async function runSql(db: D1Database, statement: string, args: Array<string | number | null> = []): Promise<void> {
  try {
    const prepared = db.prepare(statement);
    await (args.length > 0 ? prepared.bind(...args) : prepared).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\nSQL: ${statement.slice(0, 160)}`);
  }
}

async function applyFiles(files: string[]): Promise<void> {
  for (const file of files) {
    for (const statement of statementsIn(file)) await runSql(env.DB, statement);
  }
}

async function resetSchema(until?: string): Promise<void> {
  env.CONTENT_KEY = "";
  for (const table of TABLES) await runSql(env.DB, `DROP TABLE IF EXISTS ${table}`);
  const files = migrationFiles().filter((file) => !until || file <= until);
  await applyFiles(files);
}

async function seedConfiguredAdmin(): Promise<void> {
  await seedAdmin(env.DB, { username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
}

async function countOf(sql: string, args: Array<string | number | null> = []): Promise<number> {
  const prepared = env.DB.prepare(sql);
  const row = await (args.length > 0 ? prepared.bind(...args) : prepared).first<{ total: number }>();
  return Number(row?.total ?? 0);
}

type TestContext = ExecutionContext & { drain(): Promise<void> };

function executionContext(): TestContext {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
    async drain() {
      await Promise.all(pending.splice(0));
    },
  } as TestContext;
}

const contexts: TestContext[] = [];

async function call(path: string, init: RequestInit = {}, cookie?: string): Promise<Response> {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  const ctx = executionContext();
  contexts.push(ctx);
  const fetchWorker = worker.fetch as unknown as (
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ) => Promise<Response>;
  const response = await fetchWorker(new Request(`${ORIGIN}${path}`, { ...init, headers }), env, ctx);
  await ctx.drain();
  return response;
}

async function expectStatus(response: Response, status: number): Promise<Record<string, unknown>> {
  const text = await response.text();
  expect(response.status, text).toBe(status);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function sessionCookie(response: Response): string {
  const raw = response.headers.get("set-cookie") ?? "";
  const match = /smsinbox_session=([^;]+)/.exec(raw);
  expect(match?.[1]).toBeTruthy();
  expect(raw).toContain("HttpOnly");
  return `smsinbox_session=${match?.[1] ?? ""}`;
}

function jsonInit(body: unknown, extra?: HeadersInit): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headersOf(extra) },
    body: JSON.stringify(body),
  };
}

function headersOf(extra?: HeadersInit): Record<string, string> {
  if (!extra) return {};
  return Object.fromEntries(new Headers(extra).entries());
}

function pushSecret(url: string): string {
  const secret = url.split("/api/v1/ingest/")[1] ?? "";
  // Current push secrets are 32 lowercase hex characters (symbol-free).
  expect(secret).toMatch(/^[0-9a-f]{32}$/);
  expect(secret.includes("?")).toBe(false);
  return secret;
}

beforeAll(async () => {
  mf = new Miniflare({
    logRequests: false,
    verbose: false,
    workers: [
      {
        config: {
          name: "smsinbox",
          compatibilityDate: "2026-10-30",
          compatibilityFlags: ["nodejs_compat"],
          env: { DB: { type: "d1", id: "smsinbox-release" } },
          manifest: {
            mainModule: "index.mjs",
            modulesRoot: "/tmp",
            modules: {
              "index.mjs": {
                type: "esm",
                contents: "export default { async fetch() { return new Response('ok') } }",
              },
            },
          },
        },
      },
    ],
  });
  const db = await mf.getD1Database("DB");
  env = {
    DB: db as unknown as D1Database,
    ASSETS: {
      fetch: async () => new Response("asset", { status: 200 }),
      connect() {
        throw new Error("assets connect is not used");
      },
    } as Fetcher,
    RETENTION_DAYS: "90",
    CONTENT_KEY: "",
    ADMIN_USERNAME,
    ADMIN_PASSWORD,
    DEVICE_JWT_SECRET: "integration-device-jwt-secret-0001",
  };
}, 30_000);

afterAll(async () => {
  await Promise.all(contexts.map((ctx) => ctx.drain()));
  await mf.dispose();
});

describe("release migrations", () => {
  it("applies only the known files and keeps 0005 additive", async () => {
    expect(migrationFiles()).toEqual(EXPECTED_MIGRATIONS);
    const init = readFileSync("migrations/0001_init.sql", "utf8");
    expect(init).not.toContain("push_token_hash");
    const push = readFileSync("migrations/0005_device_push.sql", "utf8");
    expect(push).toMatch(/ADD COLUMN push_token_hash/);
    expect(push).toMatch(/ADD COLUMN push_revoked_at/);
    expect(push).toMatch(/CREATE UNIQUE INDEX idx_devices_push_token_hash/);
    expect(push).not.toMatch(/\b(drop|update|delete)\b/i);

    const identity = readFileSync("migrations/0008_device_identity.sql", "utf8");
    expect(identity).toMatch(/ADD COLUMN platform/);
    expect(identity).toMatch(/ADD COLUMN token_version/);
    expect(identity).not.toMatch(/\b(drop|update|delete)\b/i);

    await resetSchema("0004_users.sql");
    const before = await env.DB.prepare("PRAGMA table_info(devices)").all<{ name: string }>();
    expect(before.results.map((column) => column.name)).not.toContain("push_token_hash");

    const tokenHash = await sha256Hex(LEGACY_TOKEN);
    await runSql(
      env.DB,
      "INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'member', ?)",
      [LEGACY_USER, ADMIN_USERNAME, "not-a-password-hash", 1_700_000_000_000],
    );
    await runSql(
      env.DB,
      "INSERT INTO devices (id, user_id, name, token_hash, secret, created_at) VALUES (?, ?, ?, ?, NULL, ?)",
      [LEGACY_DEVICE, LEGACY_USER, "旧手机", tokenHash, 1_700_000_000_000],
    );

    await applyFiles(["0005_device_push.sql"]);
    const after = await env.DB.prepare("PRAGMA table_info(devices)").all<{ name: string }>();
    expect(after.results.map((column) => column.name)).toEqual([
      "id",
      "user_id",
      "name",
      "token_hash",
      "secret",
      "last_seen_at",
      "created_at",
      "push_token_hash",
      "push_revoked_at",
    ]);
    const legacy = await env.DB.prepare(
      "SELECT token_hash, push_token_hash, push_revoked_at FROM devices WHERE id = ?",
    )
      .bind(LEGACY_DEVICE)
      .first<{ token_hash: string; push_token_hash: string | null; push_revoked_at: number | null }>();
    expect(legacy).toEqual({ token_hash: tokenHash, push_token_hash: null, push_revoked_at: null });

    await runSql(
      env.DB,
      "INSERT INTO devices (id, user_id, name, token_hash, secret, created_at, push_token_hash, push_revoked_at) VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL)",
      ["33333333-3333-4333-8333-333333333333", LEGACY_USER, "另一台", "hash-two", 1_700_000_000_001],
    );
    await runSql(
      env.DB,
      "INSERT INTO devices (id, user_id, name, token_hash, secret, created_at, push_token_hash, push_revoked_at) VALUES (?, ?, ?, ?, NULL, ?, ?, NULL)",
      ["44444444-4444-4444-8444-444444444444", LEGACY_USER, "冲突", "hash-three", 1_700_000_000_002, "same-push-hash"],
    );
    await expect(
      runSql(
        env.DB,
        "INSERT INTO devices (id, user_id, name, token_hash, secret, created_at, push_token_hash, push_revoked_at) VALUES (?, ?, ?, ?, NULL, ?, ?, NULL)",
        ["55555555-5555-4555-8555-555555555555", LEGACY_USER, "冲突二", "hash-four", 1_700_000_000_003, "same-push-hash"],
      ),
    ).rejects.toThrow(/UNIQUE/);

    // The worker under test reads the later additive columns, so finish the
    // schema before exercising login on the legacy rows.
    await applyFiles(["0006_single_user.sql", "0007_totp.sql", "0008_device_identity.sql", "0009_api_tokens.sql", "0010_message_code_source.sql", "0011_session_client_info.sql", "0012_device_push_secret.sql", "0013_api_token_secret.sql", "0014_device_pins_groups.sql", "0015_device_group_order.sql", "0016_notify_channel_note.sql", "0017_message_translation.sql", "0018_push_logs.sql", "0019_user_locale.sql"]);
    const migrated = await env.DB.prepare("PRAGMA table_info(devices)").all<{ name: string; dflt_value: unknown }>();
    expect(migrated.results.map((column) => column.name)).toEqual([
      "id",
      "user_id",
      "name",
      "token_hash",
      "secret",
      "last_seen_at",
      "created_at",
      "push_token_hash",
      "push_revoked_at",
      "platform",
      "token_version",
      "push_token_enc",
      "pinned_at",
      "group_id",
    ]);
    const legacyIdentity = await env.DB.prepare("SELECT platform, token_version FROM devices WHERE id = ?")
      .bind(LEGACY_DEVICE)
      .first<{ platform: string; token_version: number }>();
    expect(legacyIdentity).toEqual({ platform: "other", token_version: 0 });

    const stale = await call("/api/v1/auth/login", jsonInit({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }));
    expect(stale.status).toBe(401);
    expect((await expectStatus(stale, 401)).error).toBe("密码错误");
    const stillMember = await env.DB.prepare("SELECT role, password_hash FROM users WHERE id = ?")
      .bind(LEGACY_USER)
      .first<{ role: string; password_hash: string }>();
    expect(stillMember).toEqual({ role: "member", password_hash: "not-a-password-hash" });
    await runSql(env.DB, "UPDATE users SET password_hash = ?, role = 'admin', disabled_at = NULL WHERE id = ?", [
      await hashPassword(ADMIN_PASSWORD),
      LEGACY_USER,
    ]);

    const login = await call("/api/v1/auth/login", jsonInit({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }));
    const cookie = sessionCookie(login);
    const session = await expectStatus(login, 200);
    expect(session.user).toMatchObject({ username: ADMIN_USERNAME, role: "admin" });

    const listed = await expectStatus(await call("/api/v1/devices", {}, cookie), 200);
    const devices = listed.devices as Array<Record<string, unknown>>;
    const old = devices.find((device) => device.id === LEGACY_DEVICE);
    expect(old).toMatchObject({ name: "旧手机", push: "none" });
    expect(old).not.toHaveProperty("has_secret");
    expect(JSON.stringify(listed)).not.toContain(LEGACY_TOKEN);
    expect(JSON.stringify(listed)).not.toContain("psh_");

    const stored = await expectStatus(
      await call("/api/v1/sms", {
        method: "POST",
        headers: { authorization: `Bearer ${LEGACY_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ from: "10086", content: "验证码 112233", device: "Android" }),
      }),
      200,
    );
    expect(stored).toMatchObject({ ok: true, code: "112233" });

    const issued = await expectStatus(
      await call(`/api/v1/devices/${LEGACY_DEVICE}/push`, jsonInit({ action: "issue" }), cookie),
      200,
    );
    const issuedUrl = String(issued.push_url);
    expect(pushSecret(issuedUrl)).toHaveLength(32);
    const still = await env.DB.prepare("SELECT token_hash FROM devices WHERE id = ?").bind(LEGACY_DEVICE).first<{
      token_hash: string;
    }>();
    expect(still?.token_hash).toBe(tokenHash);

    const viaPush = await expectStatus(
      await call(new URL(issuedUrl).pathname, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "10010", content: "验证码 445566", device: "iOS" }),
      }),
      200,
    );
    expect(viaPush).toMatchObject({ ok: true, code: "445566" });
    const viaBearer = await expectStatus(
      await call("/api/v1/sms", {
        method: "POST",
        headers: { authorization: `Bearer ${LEGACY_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ from: "10086", content: "验证码 778899", device: "Android" }),
      }),
      200,
    );
    expect(viaBearer.ok).toBe(true);
  }, 30_000);

  it("0010 adds code_source and backfills existing codes as regex", async () => {
    await resetSchema("0009_api_tokens.sql");
    const sql = readFileSync("migrations/0010_message_code_source.sql", "utf8");
    expect(sql).toMatch(/ADD COLUMN code_source/);
    expect(sql).toMatch(/SET code_source = 'regex' WHERE code IS NOT NULL/);

    const before = await env.DB.prepare("PRAGMA table_info(messages)").all<{ name: string }>();
    expect(before.results.map((column) => column.name)).not.toContain("code_source");

    await runSql(
      env.DB,
      "INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'member', ?)",
      ["user-code-source", "code-source", "hash", 1],
    );
    await runSql(
      env.DB,
      "INSERT INTO devices (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
      ["device-code-source", "user-code-source", "旧手机", "hash-code-source", 1],
    );
    await runSql(
      env.DB,
      "INSERT INTO messages (id, device_id, from_number, to_number, content, content_hash, code, raw_payload, received_at, created_at) VALUES (?, ?, '10086', '', '验证码 123456', 'hash-source-1', '123456', '{}', 1, 1)",
      ["message-with-code", "device-code-source"],
    );
    await runSql(
      env.DB,
      "INSERT INTO messages (id, device_id, from_number, to_number, content, content_hash, code, raw_payload, received_at, created_at) VALUES (?, ?, '10086', '', '普通通知', 'hash-source-2', NULL, '{}', 2, 2)",
      ["message-without-code", "device-code-source"],
    );

    await applyFiles(["0010_message_code_source.sql"]);

    const after = await env.DB.prepare("PRAGMA table_info(messages)").all<{ name: string }>();
    expect(after.results.map((column) => column.name)).toContain("code_source");
    const rows = await env.DB.prepare(
      "SELECT id, code, code_source FROM messages ORDER BY id",
    ).all<{ id: string; code: string | null; code_source: string | null }>();
    expect(rows.results).toEqual([
      { id: "message-with-code", code: "123456", code_source: "regex" },
      { id: "message-without-code", code: null, code_source: null },
    ]);
  });

  it("adds schema_meta without moving devices or deleting users", async () => {
    await resetSchema("0005_device_push.sql");
    const adminId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const elderId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await runSql(
      env.DB,
      "INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)",
      [elderId, "elder", "hash-elder", 1],
    );
    await runSql(
      env.DB,
      "INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)",
      [adminId, ADMIN_USERNAME, "hash-admin", 2],
    );
    await runSql(
      env.DB,
      "INSERT INTO devices (id, user_id, name, token_hash, secret, created_at) VALUES (?, ?, ?, ?, NULL, ?)",
      [LEGACY_DEVICE, elderId, "旧手机", "hash-elder-device", 1],
    );
    await runSql(
      env.DB,
      "INSERT INTO messages (id, device_id, from_number, to_number, content, content_hash, code, raw_payload, received_at, created_at) VALUES (?, ?, '10086', '', '保留短信', 'hash-keep', NULL, '{}', ?, ?)",
      ["cccccccc-cccc-4ccc-8ccc-cccccccccccc", LEGACY_DEVICE, 1, 1],
    );

    const sql = readFileSync("migrations/0006_single_user.sql", "utf8");
    expect(sql).toMatch(/CREATE TABLE schema_meta/);
    expect(sql).not.toMatch(/DROP\s+TABLE/i);
    expect(sql).not.toMatch(/DELETE\s+FROM/i);
    expect(sql).not.toMatch(/UPDATE\s+/i);

    await applyFiles(["0006_single_user.sql"]);
    expect(await countOf("SELECT COUNT(*) AS total FROM users")).toBe(2);
    expect(await countOf("SELECT COUNT(*) AS total FROM messages")).toBe(1);
    const device = await env.DB.prepare("SELECT user_id, token_hash FROM devices WHERE id = ?")
      .bind(LEGACY_DEVICE)
      .first<{ user_id: string; token_hash: string }>();
    expect(device).toEqual({ user_id: elderId, token_hash: "hash-elder-device" });
    const meta = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'").first<{
      name: string;
    }>();
    expect(meta?.name).toBe("schema_meta");
  });

  it("adds TOTP columns and tables without rewriting existing rows", async () => {
    await resetSchema("0006_single_user.sql");
    const sql = readFileSync("migrations/0007_totp.sql", "utf8");
    expect(sql).toMatch(/ADD COLUMN totp_secret/);
    expect(sql).toMatch(/ADD COLUMN totp_pending_secret/);
    expect(sql).toMatch(/ADD COLUMN totp_enabled_at/);
    expect(sql).toMatch(/CREATE TABLE totp_recovery_codes/);
    expect(sql).toMatch(/CREATE TABLE totp_tickets/);
    expect(sql).not.toMatch(/DROP\s+TABLE/i);
    expect(sql).not.toMatch(/DELETE\s+FROM/i);
    expect(sql).not.toMatch(/UPDATE\s+/i);

    const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await runSql(
      env.DB,
      "INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)",
      [userId, ADMIN_USERNAME, "hash-kept", 1_700_000_000_000],
    );
    await runSql(
      env.DB,
      "INSERT INTO devices (id, user_id, name, token_hash, secret, created_at) VALUES (?, ?, ?, ?, NULL, ?)",
      [LEGACY_DEVICE, userId, "旧手机", "hash-kept-device", 1_700_000_000_000],
    );
    await runSql(
      env.DB,
      "INSERT INTO messages (id, device_id, from_number, to_number, content, content_hash, code, raw_payload, received_at, created_at) VALUES (?, ?, '10086', '', '保留短信', 'hash-keep-totp', NULL, '{}', ?, ?)",
      ["cccccccc-cccc-4ccc-8ccc-cccccccccccc", LEGACY_DEVICE, 1, 1],
    );

    await applyFiles(["0007_totp.sql"]);
    const columns = await env.DB.prepare("PRAGMA table_info(users)").all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).toEqual([
      "id",
      "username",
      "password_hash",
      "created_at",
      "role",
      "disabled_at",
      "totp_secret",
      "totp_pending_secret",
      "totp_pending_created_at",
      "totp_enabled_at",
      "totp_last_counter",
    ]);
    const user = await env.DB.prepare(
      "SELECT username, password_hash, totp_secret, totp_pending_secret, totp_enabled_at FROM users WHERE id = ?",
    )
      .bind(userId)
      .first<{
        username: string;
        password_hash: string;
        totp_secret: string | null;
        totp_pending_secret: string | null;
        totp_enabled_at: number | null;
      }>();
    expect(user).toEqual({
      username: ADMIN_USERNAME,
      password_hash: "hash-kept",
      totp_secret: null,
      totp_pending_secret: null,
      totp_enabled_at: null,
    });
    expect(await countOf("SELECT COUNT(*) AS total FROM devices")).toBe(1);
    expect(await countOf("SELECT COUNT(*) AS total FROM messages")).toBe(1);
  });
});

describe("release journey", () => {
  const state: {
    cookie: string;
    deviceId: string;
    token: string;
    pushUrl: string;
    secret: string;
    messageId: string;
  } = {
    cookie: "",
    deviceId: "",
    token: "",
    pushUrl: "",
    secret: "",
    messageId: "",
  };

  beforeAll(async () => {
    await resetSchema();
  });

  it("rejects a logged-out reader and an empty database, then signs in the seeded admin", async () => {
    expect((await call("/api/v1/devices")).status).toBe(401);
    const cross = await call(
      "/api/v1/auth/login",
      jsonInit({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }, { origin: "https://evil.test" }),
    );
    expect((await expectStatus(cross, 403)).error).toBe("跨站请求被拒绝");

    const empty = await call("/api/v1/auth/login", jsonInit({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }));
    expect((await expectStatus(empty, 503)).error).toBe("管理员尚未同步，请先完成部署");
    expect(await countOf("SELECT COUNT(*) AS total FROM users")).toBe(0);
    await seedConfiguredAdmin();
    const wrongName = await call("/api/v1/auth/login", jsonInit({ username: "someone-else", password: ADMIN_PASSWORD }));
    expect((await expectStatus(wrongName, 401)).error).toBe("密码错误");
    expect(await countOf("SELECT COUNT(*) AS total FROM users")).toBe(1);

    const login = await call("/api/v1/auth/login", jsonInit({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }));
    state.cookie = sessionCookie(login);
    const body = await expectStatus(login, 200);
    expect(JSON.stringify(body)).not.toContain("sms_");
    expect(body.user).toMatchObject({ username: ADMIN_USERNAME, role: "admin" });
    const me = await expectStatus(await call("/api/v1/auth/me", {}, state.cookie), 200);
    expect(me.user).toMatchObject({ username: ADMIN_USERNAME });
    const page = await call("/devices.html");
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("asset");
  });

  it("serves the package.json version on the system info endpoint", async () => {
    // Anonymous callers only learn whether GitHub login is enabled (the
    // login page needs it pre-login); version details need the session.
    const anon = await expectStatus(await call("/api/v1/system/info"), 200);
    expect(anon).toMatchObject({ ok: true, github_enabled: false });
    expect(anon).not.toHaveProperty("version");
    const info = await expectStatus(await call("/api/v1/system/info", {}, state.cookie), 200);
    expect(info).toMatchObject({ ok: true, version: pkg.version, runtime: "Cloudflare Workers + D1" });
  });

  it("stores the display-only profile username in schema_meta and clears it again", async () => {
    expect((await call("/api/v1/auth/profile", jsonInit({ username: "octocat" }))).status).toBe(401);
    const initial = await expectStatus(await call("/api/v1/auth/me", {}, state.cookie), 200);
    expect(initial.user).toMatchObject({ profile_username: "" });

    const bad = await call("/api/v1/auth/profile", jsonInit({ username: "x".repeat(40) }), state.cookie);
    expect((await expectStatus(bad, 400)).error).toContain("39");

    const saved = await expectStatus(
      await call("/api/v1/auth/profile", jsonInit({ username: "octocat" }), state.cookie),
      200,
    );
    expect(saved).toMatchObject({ ok: true, profile_username: "octocat" });
    const row = await env.DB.prepare("SELECT value FROM schema_meta WHERE key = ?")
      .bind("profile_username")
      .first<{ value: string }>();
    expect(row?.value).toBe("octocat");
    const me = await expectStatus(await call("/api/v1/auth/me", {}, state.cookie), 200);
    expect(me.user).toMatchObject({ username: ADMIN_USERNAME, profile_username: "octocat" });
    expect(await countOf("SELECT COUNT(*) AS total FROM users")).toBe(1);

    const cleared = await expectStatus(
      await call("/api/v1/auth/profile", jsonInit({ username: "" }), state.cookie),
      200,
    );
    expect(cleared).toMatchObject({ ok: true, profile_username: "" });
    const gone = await env.DB.prepare("SELECT value FROM schema_meta WHERE key = ?")
      .bind("profile_username")
      .first<{ value: string }>();
    expect(gone).toBeNull();
  });

  it("returns a bearer and a push link, then keeps the push link visible to the owner", async () => {
    const created = await expectStatus(
      await call("/api/v1/devices", jsonInit({ name: "iPhone" }), state.cookie),
      200,
    );
    state.deviceId = String((created.device as { id: string }).id);
    state.token = String(created.token);
    state.pushUrl = String(created.push_url);
    state.secret = pushSecret(state.pushUrl);
    expect(state.token.startsWith("eyJ")).toBe(true);
    expect(state.token.split(".")).toHaveLength(3);
    expect(created).toMatchObject({ token_type: "Bearer" });
    expect(Number(created.token_expires_at)).toBeGreaterThan(Date.now());
    expect(created.device).toMatchObject({ name: "iPhone", push: "active", platform: "other" });
    expect(created.device).not.toHaveProperty("has_secret");

    const listed = await expectStatus(await call("/api/v1/devices", {}, state.cookie), 200);
    const text = JSON.stringify(listed);
    // The bearer token stays one-time; the push link is stored (0012) and
    // stays visible in the owner's list so it can be copied any time.
    expect(text).not.toContain(state.token);
    expect(listed.devices).toContainEqual(
      expect.objectContaining({ id: state.deviceId, push: "active", push_url: state.pushUrl }),
    );
  });

  it("renames a device through PATCH and validates the new name", async () => {
    const patch = (id: string, name: unknown) =>
      call(
        `/api/v1/devices/${id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        },
        state.cookie,
      );
    const renamed = await expectStatus(await patch(state.deviceId, "床头手机"), 200);
    expect(renamed).toMatchObject({ ok: true, id: state.deviceId, name: "床头手机" });
    const listed = await expectStatus(await call("/api/v1/devices", {}, state.cookie), 200);
    expect(listed.devices).toContainEqual(expect.objectContaining({ id: state.deviceId, name: "床头手机" }));

    expect((await patch(state.deviceId, "   ")).status).toBe(400);
    expect((await patch(state.deviceId, "x".repeat(65))).status).toBe(400);
    expect((await patch("123e4567-e89b-12d3-a456-426614174000", "没这台")).status).toBe(404);
    // Restore the shared fixture name for the later steps in this journey.
    await expectStatus(await patch(state.deviceId, "iPhone"), 200);
  });

  it("stores bearer and push messages, redacts the ingest path, and ignores a foreign bearer", async () => {
    const payload = JSON.stringify({
      from: "10086",
      content: "验证码 246810",
      timestamp: Date.now(),
      device: "Android",
    });
    const first = await expectStatus(
      await call("/api/v1/sms", {
        method: "POST",
        headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
        body: payload,
      }),
      200,
    );
    state.messageId = String(first.id);
    expect(first).toMatchObject({ ok: true, code: "246810" });
    const duplicate = await expectStatus(
      await call("/api/v1/sms", {
        method: "POST",
        headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
        body: payload,
      }),
      200,
    );
    expect(duplicate).toMatchObject({ ok: true, id: state.messageId, duplicate: true, code: "246810" });

    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      lines.push(String(message));
    });
    const err = vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
      lines.push(String(message));
    });
    try {
      const ingested = await expectStatus(
        await call(`${new URL(state.pushUrl).pathname}?ticket=do-not-log`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer sms_someone_elses_token",
          },
          body: JSON.stringify({ from: "1069", content: "验证码 135790", device: "iOS" }),
        }),
        200,
      );
      expect(ingested).toMatchObject({ ok: true, code: "135790" });
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
    const logged = lines.join("\n");
    expect(logged).toContain('"/api/v1/ingest/:secret"');
    expect(logged).not.toContain(state.secret);
    expect(logged).not.toContain(state.token);
    expect(logged).not.toContain("do-not-log");
    expect(logged).not.toContain("135790");
    expect(logged).not.toContain("验证码");

    const inbox = await expectStatus(await call("/api/v1/messages", {}, state.cookie), 200);
    const messages = inbox.messages as Array<Record<string, unknown>>;
    expect(messages.map((message) => message.code).sort()).toEqual(["135790", "246810"]);
    expect(messages.every((message) => message.device_id === state.deviceId)).toBe(true);

    expect((await call("/api/v1/sms")).status).toBe(405);
    expect((await call(`/api/v1/ingest/${state.secret}`)).status).toBe(405);
    const asBearer = await expectStatus(
      await call("/api/v1/sms", {
        method: "POST",
        headers: { authorization: `Bearer ${state.secret}`, "content-type": "application/json" },
        body: JSON.stringify({ from: "10086", content: "验证码 000111", device: "Android" }),
      }),
      401,
    );
    expect(asBearer.error).toBe("设备 token 无效");
  });

  it("filters messages by since and rejects invalid timestamps", async () => {
    const base = Date.now();
    const before = base - 10 * 24 * 60 * 60 * 1000;
    const middle = base - 2 * 60 * 60 * 1000;
    const after = base - 10 * 60 * 1000;
    await runSql(
      env.DB,
      "INSERT INTO messages (id, device_id, from_number, to_number, content, content_hash, code, raw_payload, received_at, created_at) VALUES (?, ?, '10086', '', '旧短信', 'hash-since-old', NULL, '{}', ?, ?)",
      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state.deviceId, before, before],
    );
    await runSql(
      env.DB,
      "INSERT INTO messages (id, device_id, from_number, to_number, content, content_hash, code, raw_payload, received_at, created_at) VALUES (?, ?, '10086', '', '中间短信', 'hash-since-mid', NULL, '{}', ?, ?)",
      ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", state.deviceId, middle, middle],
    );
    await runSql(
      env.DB,
      "INSERT INTO messages (id, device_id, from_number, to_number, content, content_hash, code, raw_payload, received_at, created_at) VALUES (?, ?, '10086', '', '新短信', 'hash-since-new', NULL, '{}', ?, ?)",
      ["cccccccc-cccc-4ccc-8ccc-cccccccccccc", state.deviceId, after, after],
    );

    const cutoff = base - 3 * 60 * 60 * 1000;
    const filtered = await expectStatus(await call(`/api/v1/messages?since=${cutoff}`, {}, state.cookie), 200) as {
      messages: Array<Record<string, unknown>>;
    };
    const filteredMessages = filtered.messages;
    expect(filteredMessages).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: "中间短信" }), expect.objectContaining({ content: "新短信" })]),
    );
    expect(filteredMessages.some((message) => String(message.content) === "旧短信")).toBe(false);
    expect(filteredMessages.every((message) => Number(message.received_at) >= cutoff)).toBe(true);

    const all = await expectStatus(await call("/api/v1/messages", {}, state.cookie), 200) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(all.messages.length).toBeGreaterThan(filteredMessages.length);
    expect(all.messages.some((message) => String(message.content) === "旧短信")).toBe(true);

    for (const value of ["abc", "-1", "1.5"]) {
      const bad = await call(`/api/v1/messages?since=${encodeURIComponent(value)}`, {}, state.cookie);
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ ok: false, error: "since 参数无效" });
    }
  });

  it("ignores a per-device secret on create and authenticates legacy rows by bearer only", async () => {
    // The `secret` column still exists in D1 but is never written or read. An
    // old client that sends it on create is not rejected; the field is ignored.
    const created = await expectStatus(
      await call("/api/v1/devices", jsonInit({ name: "Pixel", secret: "signing-secret" }), state.cookie),
      200,
    );
    expect(created.device).toMatchObject({ name: "Pixel", push: "active" });
    expect(created.device).not.toHaveProperty("has_secret");
    expect(String(created.token).startsWith("eyJ")).toBe(true);

    const admin = await env.DB.prepare("SELECT id FROM users ORDER BY created_at ASC").first<{ id: string }>();
    const legacyToken = "sms_legacy_bearer_device_token_0001";
    const legacyId = "99999999-9999-4999-8999-999999999999";
    await runSql(
      env.DB,
      "INSERT INTO devices (id, user_id, name, token_hash, secret, created_at, push_token_hash, push_revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)",
      [legacyId, String(admin?.id), "旧 Pixel", await sha256Hex(legacyToken), "signing-secret", Date.now()],
    );

    // A leftover secret no longer forces HMAC: the bearer works on its own.
    const unsigned = await expectStatus(
      await call("/api/v1/sms", {
        method: "POST",
        headers: { authorization: `Bearer ${legacyToken}`, "content-type": "application/json" },
        body: JSON.stringify({ from: "10000", content: "验证码 222333", device: "Pixel" }),
      }),
      200,
    );
    expect(unsigned).toMatchObject({ ok: true, code: "222333" });

    // Signature headers are ignored rather than rejected, for legacy and JWT
    // credentials alike, so an old client keeps working without signing.
    const body = JSON.stringify({ from: "10000", content: "验证码 333444", device: "Pixel" });
    const jwtSigned = await expectStatus(
      await call("/api/v1/sms", {
        method: "POST",
        headers: {
          authorization: `Bearer ${state.token}`,
          "content-type": "application/json",
          "x-timestamp": String(Math.floor(Date.now() / 1000)),
          "x-signature": "ab".repeat(32),
        },
        body,
      }),
      200,
    );
    expect(jwtSigned).toMatchObject({ ok: true, code: "333444" });
  });

  it("rotates and revokes without deleting messages or the bearer", async () => {
    const active = await expectStatus(
      await call(`/api/v1/devices/${state.deviceId}/push`, jsonInit({ action: "issue" }), state.cookie),
      409,
    );
    expect(active.error).toBe("推送链接仍有效，请改用轮换");

    const before = await countOf("SELECT COUNT(*) AS total FROM messages WHERE device_id = ?", [state.deviceId]);
    const rotated = await expectStatus(
      await call(`/api/v1/devices/${state.deviceId}/push`, jsonInit({ action: "rotate" }), state.cookie),
      200,
    );
    const nextUrl = String(rotated.push_url);
    const nextSecret = pushSecret(nextUrl);
    expect(nextSecret).not.toBe(state.secret);
    const oldPath = `/api/v1/ingest/${state.secret}`;
    const retired = await expectStatus(
      await call(oldPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "10086", content: "验证码 555666", device: "iOS" }),
      }),
      401,
    );
    expect(retired.error).toBe("推送链接无效");
    const fresh = await expectStatus(
      await call(`/api/v1/ingest/${nextSecret}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "10086", content: "验证码 555666", device: "iOS" }),
      }),
      200,
    );
    expect(fresh.code).toBe("555666");
    expect(await countOf("SELECT COUNT(*) AS total FROM messages WHERE device_id = ?", [state.deviceId])).toBe(before + 1);

    const revoked = await expectStatus(
      await call(`/api/v1/devices/${state.deviceId}/push`, jsonInit({ action: "revoke" }), state.cookie),
      200,
    );
    expect(revoked.push_url).toBeUndefined();
    expect(revoked.device).toMatchObject({ push: "revoked" });
    const blocked = await expectStatus(
      await call(`/api/v1/ingest/${nextSecret}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "10086", content: "验证码 666777", device: "iOS" }),
      }),
      401,
    );
    expect(blocked.error).toBe("推送链接已撤销");
    const bearer = await expectStatus(
      await call("/api/v1/sms", {
        method: "POST",
        headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
        body: JSON.stringify({ from: "10086", content: "验证码 666777", device: "Android" }),
      }),
      200,
    );
    expect(bearer.ok).toBe(true);

    const reissued = await expectStatus(
      await call(`/api/v1/devices/${state.deviceId}/push`, jsonInit({ action: "issue" }), state.cookie),
      200,
    );
    state.secret = pushSecret(String(reissued.push_url));
    state.pushUrl = String(reissued.push_url);
    const listed = await expectStatus(await call("/api/v1/devices", {}, state.cookie), 200);
    // The re-issued link is stored, so the owner's list shows it in full.
    expect(listed.devices).toContainEqual(
      expect.objectContaining({ id: state.deviceId, push: "active", push_url: state.pushUrl }),
    );
  });

  it("sends a test message and downloads a shortcut without the device secret", async () => {
    const tested = await expectStatus(
      await call(`/api/v1/devices/${state.deviceId}/test`, jsonInit({}), state.cookie),
      200,
    );
    expect(tested.code).toBe("654321");
    const inbox = await expectStatus(
      await call(`/api/v1/messages?device_id=${state.deviceId}`, {}, state.cookie),
      200,
    );
    expect(JSON.stringify(inbox.messages)).toContain("654321");

    expect((await call("/api/v1/ios/shortcut")).status).toBe(401);
    const file = await call("/api/v1/ios/shortcut", {}, state.cookie);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toContain("SMSinBox-iOS.shortcut");
    const plist = await file.text();
    expect(plist).toContain("推送链接");
    expect(plist).not.toContain(state.secret);
    expect(plist).not.toContain(state.token);
    expect(plist).not.toContain("icloud.com/shortcuts");
    const code = await call("/api/v1/ios/shortcut?variant=code", {}, state.cookie);
    expect(code.status).toBe(200);
    expect(await code.text()).toContain("/api/v1/sms");
  });

  it("clears both rate keys when the device is deleted", async () => {
    const row = await env.DB.prepare("SELECT token_hash FROM devices WHERE id = ?")
      .bind(state.deviceId)
      .first<{ token_hash: string }>();
    const tokenHash = String(row?.token_hash);
    const pushHash = await sha256Hex(state.secret);
    expect(await countOf("SELECT COUNT(*) AS total FROM rate_limits WHERE token_hash = ? OR token_hash = ?", [tokenHash, pushHash])).toBeGreaterThan(0);

    expect((await expectStatus(await call(`/api/v1/devices/${state.deviceId}`, { method: "DELETE" }, state.cookie), 200)).ok).toBe(true);
    expect(await countOf("SELECT COUNT(*) AS total FROM messages WHERE device_id = ?", [state.deviceId])).toBe(0);
    expect(await countOf("SELECT COUNT(*) AS total FROM rate_limits WHERE token_hash = ? OR token_hash = ?", [tokenHash, pushHash])).toBe(0);
    expect(
      (
        await expectStatus(
          await call("/api/v1/sms", {
            method: "POST",
            headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
            body: JSON.stringify({ from: "10086", content: "验证码 888999", device: "Android" }),
          }),
          401,
        )
      ).error,
    ).toBe("设备 token 无效");
    expect(
      (
        await expectStatus(
          await call(`/api/v1/ingest/${state.secret}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ from: "10086", content: "验证码 888999", device: "iOS" }),
          }),
          401,
        )
      ).error,
    ).toBe("推送链接无效");
  });
});

describe("single user convergence", () => {
  beforeAll(async () => {
    await resetSchema();
  });

  it("refuses to guess an admin when more than one user row exists", async () => {
    const adminId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const elderId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const deviceId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const messageId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const channelId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const token = "sms_elder_device_token_0001";
    const tokenHash = await sha256Hex(token);
    const pushHash = "elder-push-hash-kept";
    const now = 1_700_000_000_000;
    const elderPassword = await hashPassword("elder-pass-1");

    await runSql(
      env.DB,
      "INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)",
      [elderId, "elder", elderPassword, 1],
    );
    await runSql(
      env.DB,
      "INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)",
      [adminId, ADMIN_USERNAME, "not-a-password-hash", 2],
    );
    await runSql(
      env.DB,
      "INSERT INTO devices (id, user_id, name, token_hash, secret, created_at, push_token_hash, push_revoked_at) VALUES (?, ?, ?, ?, NULL, ?, ?, NULL)",
      [deviceId, elderId, "旧手机", tokenHash, now, pushHash],
    );
    await runSql(
      env.DB,
      "INSERT INTO messages (id, device_id, from_number, to_number, content, content_hash, code, raw_payload, received_at, created_at) VALUES (?, ?, '10086', '', '旧成员短信 246810', 'hash-elder-message', '246810', '{}', ?, ?)",
      [messageId, deviceId, now, now],
    );
    await runSql(
      env.DB,
      "INSERT INTO notify_channels (id, user_id, kind, config, enabled, created_at) VALUES (?, ?, 'bark', ?, 1, ?)",
      [channelId, elderId, '{"device_key":"abcd1234"}', now],
    );
    await runSql(env.DB, "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)", [
      "elder-session",
      elderId,
      now + 60_000,
      now,
    ]);
    await runSql(env.DB, "INSERT INTO rate_limits (token_hash, window_start, count) VALUES (?, ?, 1)", [tokenHash, now]);

    expect((await call("/api/v1/users", jsonInit({ username: "mina", password: "mina-pass-1" }))).status).toBe(410);
    expect((await call(`/api/v1/users/${elderId}`, { method: "DELETE" })).status).toBe(410);
    expect(await countOf("SELECT COUNT(*) AS total FROM messages WHERE id = ?", [messageId])).toBe(1);
    expect(await countOf("SELECT COUNT(*) AS total FROM users")).toBe(2);

    const elderLogin = await call("/api/v1/auth/login", jsonInit({ username: "elder", password: "elder-pass-1" }));
    expect((await expectStatus(elderLogin, 409)).error).toContain("无法确定管理员");
    expect(await countOf("SELECT COUNT(*) AS total FROM users")).toBe(2);
    expect(await countOf("SELECT COUNT(*) AS total FROM devices WHERE user_id = ?", [elderId])).toBe(1);
    expect(await countOf("SELECT COUNT(*) AS total FROM sessions WHERE id = ?", ["elder-session"])).toBe(1);
    expect(await countOf("SELECT COUNT(*) AS total FROM messages WHERE id = ?", [messageId])).toBe(1);
    expect(await countOf("SELECT COUNT(*) AS total FROM notify_channels WHERE id = ? AND user_id = ?", [channelId, elderId])).toBe(1);
    expect(await countOf("SELECT COUNT(*) AS total FROM schema_meta WHERE key = ?", ["single_user_merged_at"])).toBe(0);
    const adminHash = await env.DB.prepare("SELECT password_hash FROM users WHERE id = ?")
      .bind(adminId)
      .first<{ password_hash: string }>();
    expect(adminHash?.password_hash).toBe("not-a-password-hash");
    const elderRow = await env.DB.prepare("SELECT password_hash FROM users WHERE id = ?")
      .bind(elderId)
      .first<{ password_hash: string }>();
    expect(await verifyPassword("elder-pass-1", elderRow?.password_hash ?? "")).toBe(true);

    const login = await call("/api/v1/auth/login", jsonInit({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }));
    expect(login.status).toBe(409);
    expect(await countOf("SELECT COUNT(*) AS total FROM users")).toBe(2);
    const device = await env.DB.prepare("SELECT user_id, token_hash, push_token_hash FROM devices WHERE id = ?")
      .bind(deviceId)
      .first<{ user_id: string; token_hash: string; push_token_hash: string }>();
    expect(device).toEqual({ user_id: elderId, token_hash: tokenHash, push_token_hash: pushHash });

    const previous = env.ADMIN_USERNAME;
    try {
      env.ADMIN_USERNAME = "second-admin";
      const mismatched = await call(
        "/api/v1/auth/login",
        jsonInit({ username: "second-admin", password: ADMIN_PASSWORD }),
      );
      expect(mismatched.status).toBe(409);
      expect(await countOf("SELECT COUNT(*) AS total FROM users")).toBe(2);
      expect(await countOf("SELECT COUNT(*) AS total FROM messages WHERE id = ?", [messageId])).toBe(1);
    } finally {
      env.ADMIN_USERNAME = previous;
    }
  }, 30_000);
});

describe("admin account", () => {
  beforeAll(async () => {
    await resetSchema();
    await seedConfiguredAdmin();
  });

  it("rotates the password, tombstones rename, and revokes sessions without dropping devices", async () => {
    const first = await call("/api/v1/auth/login", jsonInit({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }));
    const cookieA = sessionCookie(first);
    const tokenA = /smsinbox_session=([^;]+)/.exec(first.headers.get("set-cookie") ?? "")?.[1] ?? "";
    const second = await call("/api/v1/auth/login", jsonInit({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }));
    const cookieB = sessionCookie(second);

    const listed = await expectStatus(await call("/api/v1/auth/sessions", {}, cookieA), 200);
    const sessions = listed.sessions as Array<{ id: string; current: boolean }>;
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((item) => item.current)).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(tokenA);
    expect(JSON.stringify(listed)).not.toContain("password");

    const loggedOut = await call("/api/v1/auth/logout", { method: "POST" }, cookieB);
    expect(loggedOut.status).toBe(200);
    expect(loggedOut.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await call("/api/v1/auth/me", {}, cookieB)).status).toBe(401);
    expect((await call("/api/v1/auth/me", {}, cookieA)).status).toBe(200);

    const third = await call("/api/v1/auth/login", jsonInit({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }));
    const cookieC = sessionCookie(third);
    const others = await call("/api/v1/auth/sessions/revoke-others", { method: "POST" }, cookieA);
    expect(others.status).toBe(200);
    expect((await call("/api/v1/auth/me", {}, cookieC)).status).toBe(401);
    expect((await expectStatus(await call("/api/v1/auth/sessions", {}, cookieA), 200)).sessions).toEqual([
      expect.objectContaining({ current: true }),
    ]);

    const again = await call("/api/v1/auth/login", jsonInit({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }));
    const cookieD = sessionCookie(again);
    const both = (await expectStatus(await call("/api/v1/auth/sessions", {}, cookieA), 200)).sessions as Array<{
      id: string;
      current: boolean;
    }>;
    const otherId = both.find((item) => !item.current)?.id ?? "";
    expect(otherId).toMatch(/^[0-9a-f]{64}$/);
    const removed = await call(`/api/v1/auth/sessions/${otherId}`, { method: "DELETE" }, cookieA);
    expect(removed.status).toBe(200);
    expect(removed.headers.get("set-cookie")).toBeNull();
    expect((await call("/api/v1/auth/me", {}, cookieD)).status).toBe(401);

    const created = await expectStatus(await call("/api/v1/devices", jsonInit({ name: "仍在" }), cookieA), 200);
    const deviceToken = String(created.token);
    const cross = await call(
      "/api/v1/auth/password",
      jsonInit({ current_password: ADMIN_PASSWORD, password: "replacement-pass-1" }, { origin: "https://evil.test" }),
      cookieA,
    );
    expect((await expectStatus(cross, 403)).error).toBe("跨站请求被拒绝");
    const sameSite = await call(
      "/api/v1/auth/password",
      jsonInit(
        { current_password: ADMIN_PASSWORD, password: "replacement-pass-1" },
        { origin: ORIGIN, "sec-fetch-site": "same-site" },
      ),
      cookieA,
    );
    expect((await expectStatus(sameSite, 403)).error).toBe("跨站请求被拒绝");

    expect((await expectStatus(await call("/api/v1/auth/me", {}, cookieA), 200)).user).toMatchObject({
      username: ADMIN_USERNAME,
    });
    expect(await countOf("SELECT COUNT(*) AS total FROM users")).toBe(1);

    const changed = await call(
      "/api/v1/auth/password",
      jsonInit(
        { current_password: ADMIN_PASSWORD, password: "replacement-pass-1" },
        { origin: ORIGIN, "sec-fetch-site": "none" },
      ),
      cookieA,
    );
    expect(changed.status).toBe(200);
    expect(changed.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await call("/api/v1/auth/me", {}, cookieA)).status).toBe(401);
    expect(await countOf("SELECT COUNT(*) AS total FROM sessions")).toBe(0);
    const stored = await expectStatus(
      await call("/api/v1/sms", {
        method: "POST",
        headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
        body: JSON.stringify({ from: "10086", content: "验证码 135790", device: "Android" }),
      }),
      200,
    );
    expect(stored).toMatchObject({ ok: true, code: "135790" });

    const fresh = await call(
      "/api/v1/auth/login",
      jsonInit({ username: ADMIN_USERNAME, password: "replacement-pass-1" }),
    );
    expect((await expectStatus(fresh, 200)).user).toMatchObject({ username: ADMIN_USERNAME, role: "admin" });
    expect(await countOf("SELECT COUNT(*) AS total FROM users")).toBe(1);
    expect((await call("/api/v1/users", jsonInit({ username: "mina", password: "mina-pass-1" }))).status).toBe(410);

    const userKey = await loginRateKey("user", "admin");
    const missed = await call("/api/v1/auth/login", jsonInit({ username: ADMIN_USERNAME, password: "wrong-pass-1" }));
    expect(missed.status).toBe(401);
    const row = await env.DB.prepare("SELECT count FROM rate_limits WHERE token_hash = ?")
      .bind(userKey)
      .first<{ count: number }>();
    expect(row?.count).toBe(1);
    await runSql(env.DB, "UPDATE rate_limits SET count = ? WHERE token_hash = ?", [LOGIN_FAILURE_LIMIT, userKey]);
    const limited = await call(
      "/api/v1/auth/login",
      jsonInit({ username: ADMIN_USERNAME, password: "replacement-pass-1" }),
    );
    expect((await expectStatus(limited, 429)).error).toBe("登录尝试过多，请稍后再试");
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(
      (await env.DB.prepare("SELECT count FROM rate_limits WHERE token_hash = ?").bind(userKey).first<{ count: number }>())
        ?.count,
    ).toBe(LOGIN_FAILURE_LIMIT);
    await runSql(env.DB, "DELETE FROM rate_limits WHERE token_hash = ?", [userKey]);
    const cleared = await call(
      "/api/v1/auth/login",
      jsonInit({ username: ADMIN_USERNAME, password: "replacement-pass-1" }),
    );
    expect(cleared.status).toBe(200);
    expect(await countOf("SELECT COUNT(*) AS total FROM rate_limits WHERE token_hash = ?", [userKey])).toBe(0);

    const recovered = await call(
      "/api/v1/auth/login",
      jsonInit({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
    );
    expect(recovered.status).toBe(401);
    expect(
      (await call("/api/v1/auth/login", jsonInit({ username: ADMIN_USERNAME, password: "replacement-pass-1" }))).status,
    ).toBe(200);
    expect(await countOf("SELECT COUNT(*) AS total FROM users")).toBe(1);
    const storedHash = await env.DB.prepare("SELECT password_hash FROM users WHERE username = ?")
      .bind(ADMIN_USERNAME)
      .first<{ password_hash: string }>();
    expect(await verifyPassword(ADMIN_PASSWORD, storedHash?.password_hash ?? "")).toBe(false);
    expect(await verifyPassword("replacement-pass-1", storedHash?.password_hash ?? "")).toBe(true);
  }, 30_000);

  it("keeps the hash set through the API when the env password no longer matches", async () => {
    await resetSchema();
    await seedConfiguredAdmin();
    const login = await call("/api/v1/auth/login", jsonInit({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }));
    const cookie = sessionCookie(login);
    const changed = await call(
      "/api/v1/auth/password",
      jsonInit({ current_password: ADMIN_PASSWORD, password: "replacement-pass-1" }),
      cookie,
    );
    expect(changed.status).toBe(200);
    expect((await call("/api/v1/auth/login", jsonInit({ username: ADMIN_USERNAME, password: "replacement-pass-1" }))).status).toBe(200);
    expect((await call("/api/v1/auth/login", jsonInit({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }))).status).toBe(401);
    expect((await call("/api/v1/auth/login", jsonInit({ username: ADMIN_USERNAME, password: "replacement-pass-1" }))).status).toBe(200);
    expect(await countOf("SELECT COUNT(*) AS total FROM users")).toBe(1);
  }, 30_000);
});

describe("two-factor login", () => {
  const state = { cookie: "", secret: "", codes: [] as string[] };

  async function codeFor(secret: string, offset = 0): Promise<string> {
    const raw = base32Decode(secret);
    expect(raw).not.toBeNull();
    return hotp(raw ?? new Uint8Array(), totpCounter(Date.now()) + offset);
  }

  async function challenge(): Promise<{ ticket: string; body: Record<string, unknown> }> {
    const response = await call(
      "/api/v1/auth/login",
      jsonInit({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
    );
    expect(response.headers.get("set-cookie")).toBeNull();
    const body = await expectStatus(response, 200);
    expect(body).toMatchObject({ ok: true, totp_required: true });
    return { ticket: String(body.ticket), body };
  }

  function wrongCode(good: string, digit: string): string {
    const first = good[0] === digit ? (digit === "0" ? "1" : "0") : digit;
    return `${first}${good.slice(1)}`;
  }

  // Pretend the previous 30s step has passed so a fresh code is not treated
  // as a replay.
  async function resetReplayGuard(): Promise<void> {
    await runSql(env.DB, "UPDATE users SET totp_last_counter = NULL");
  }

  beforeAll(async () => {
    await resetSchema();
    await seedConfiguredAdmin();
    const key = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    env.CONTENT_KEY = key;
    const login = await call(
      "/api/v1/auth/login",
      jsonInit({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
    );
    state.cookie = sessionCookie(login);
    await expectStatus(login, 200);
  });

  it("seals the secret, enables after one code, and shows recovery codes once", async () => {
    const before = await expectStatus(await call("/api/v1/auth/totp", {}, state.cookie), 200);
    expect(before).toMatchObject({ ok: true, enabled: false, recovery_codes_remaining: 0 });

    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      lines.push(String(message));
    });
    const err = vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
      lines.push(String(message));
    });
    let setup: Record<string, unknown>;
    let enabled: Record<string, unknown>;
    try {
      await expectStatus(
        await call("/api/v1/auth/profile", jsonInit({ username: "Admin Display" }), state.cookie),
        200,
      );
      setup = await expectStatus(await call("/api/v1/auth/totp/setup", jsonInit({}), state.cookie), 200);
      state.secret = String(setup.secret);
      expect(state.secret).toMatch(/^[A-Z2-7]{32}$/);
      const uri = String(setup.otpauth_uri);
      expect(uri.startsWith("otpauth://totp/")).toBe(true);
      // The authenticator label follows the live profile username, not the login name.
      expect(uri).toContain("SMSinBox%3AAdmin%20Display");
      expect(uri).toContain(`secret=${state.secret}`);
      expect(uri).toContain("issuer=SMSinBox");
      expect(uri).toContain("digits=6");
      expect(uri).toContain("period=30");
      expect(setup).toMatchObject({ digits: 6, period: 30, algorithm: "SHA1" });
      enabled = await expectStatus(
        await call("/api/v1/auth/totp/enable", jsonInit({ code: await codeFor(state.secret) }), state.cookie),
        200,
      );
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
    const codes = (enabled.recovery_codes as string[]).map(String);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    state.codes = codes;

    const logged = lines.join("\n");
    expect(logged).not.toContain(state.secret);
    for (const code of codes) expect(logged).not.toContain(code);

    const stored = await env.DB.prepare(
      "SELECT totp_secret, totp_pending_secret, totp_pending_created_at, totp_enabled_at, totp_last_counter FROM users WHERE username = ?",
    )
      .bind(ADMIN_USERNAME)
      .first<{
        totp_secret: string | null;
        totp_pending_secret: string | null;
        totp_pending_created_at: number | null;
        totp_enabled_at: number | null;
        totp_last_counter: number | null;
      }>();
    expect(stored?.totp_secret?.startsWith(ENCRYPTED_PREFIX)).toBe(true);
    expect(stored?.totp_secret).not.toContain(state.secret);
    expect(stored?.totp_pending_secret).toBeNull();
    expect(stored?.totp_pending_created_at).toBeNull();
    expect(stored?.totp_enabled_at).toBeGreaterThan(0);
    expect(stored?.totp_last_counter).toBeNull();
    expect(await countOf("SELECT COUNT(*) AS total FROM totp_recovery_codes WHERE used_at IS NULL")).toBe(10);

    const status = await expectStatus(await call("/api/v1/auth/totp", {}, state.cookie), 200);
    expect(status).toMatchObject({ enabled: true, recovery_codes_remaining: 10 });
    const statusText = JSON.stringify(status);
    expect(statusText).not.toContain(state.secret);
    for (const code of codes) expect(statusText).not.toContain(code);

    const again = await call("/api/v1/auth/totp/setup", jsonInit({}), state.cookie);
    expect((await expectStatus(again, 409)).error).toBe("两步验证已启用");
  }, 20_000);

  it("asks for a second factor and refuses a replayed code", async () => {
    const { ticket } = await challenge();
    const good = await codeFor(state.secret);

    const wrong = await call("/api/v1/auth/totp/verify", jsonInit({ ticket, code: wrongCode(good, "0") }));
    expect((await expectStatus(wrong, 401)).attempts_remaining).toBe(4);

    const verified = await call("/api/v1/auth/totp/verify", jsonInit({ ticket, code: good }));
    const body = await expectStatus(verified, 200);
    expect(body.user).toMatchObject({ username: ADMIN_USERNAME, role: "admin", totp_enabled: true });
    const cookie = sessionCookie(verified);
    expect((await call("/api/v1/auth/me", {}, cookie)).status).toBe(200);

    const reused = await challenge();
    const replay = await call("/api/v1/auth/totp/verify", jsonInit({ ticket: reused.ticket, code: good }));
    expect((await expectStatus(replay, 401)).error).toContain("验证码");
    const next = await call(
      "/api/v1/auth/totp/verify",
      jsonInit({ ticket: reused.ticket, code: await codeFor(state.secret, 1) }),
    );
    await expectStatus(next, 200);

    const bogus = await call(
      "/api/v1/auth/totp/verify",
      jsonInit({ ticket: `tot_${"a".repeat(43)}`, code: good }),
    );
    expect((await expectStatus(bogus, 401)).error).toBe("登录已过期，请重新登录");

    const anonymous = await call("/api/v1/auth/totp", {});
    expect(anonymous.status).toBe(401);
  }, 20_000);

  it("locks a ticket after five wrong codes", async () => {
    const { ticket } = await challenge();
    const good = await codeFor(state.secret);
    for (let index = 0; index < 4; index += 1) {
      const attempt = await call(
        "/api/v1/auth/totp/verify",
        jsonInit({ ticket, code: wrongCode(good, String(index)) }),
      );
      expect(attempt.status).toBe(401);
    }
    const fifth = await call(
      "/api/v1/auth/totp/verify",
      jsonInit({ ticket, code: wrongCode(good, "5") }),
    );
    expect((await expectStatus(fifth, 429)).error).toContain("尝试过多");
    const after = await call("/api/v1/auth/totp/verify", jsonInit({ ticket, code: good }));
    expect((await expectStatus(after, 401)).error).toBe("登录已过期，请重新登录");
    expect(await countOf("SELECT COUNT(*) AS total FROM totp_tickets")).toBe(0);
  }, 20_000);

  it("accepts a recovery code once and leaves the rest usable", async () => {
    const first = await challenge();
    const used = await call(
      "/api/v1/auth/totp/verify",
      jsonInit({ ticket: first.ticket, code: state.codes[0] }),
    );
    const body = await expectStatus(used, 200);
    expect(body.user).toMatchObject({ username: ADMIN_USERNAME, totp_enabled: true });
    const cookie = sessionCookie(used);
    expect(
      (await expectStatus(await call("/api/v1/auth/totp", {}, cookie), 200)).recovery_codes_remaining,
    ).toBe(9);
    expect(await countOf("SELECT COUNT(*) AS total FROM totp_recovery_codes WHERE used_at IS NOT NULL")).toBe(1);

    const second = await challenge();
    const replay = await call(
      "/api/v1/auth/totp/verify",
      jsonInit({ ticket: second.ticket, code: state.codes[0] }),
    );
    expect((await expectStatus(replay, 401)).error).toBe("验证码不正确");
    const fresh = await call(
      "/api/v1/auth/totp/verify",
      jsonInit({ ticket: second.ticket, code: state.codes[1] }),
    );
    await expectStatus(fresh, 200);
  }, 20_000);

  it("disables only with the password and a valid code, and drops other sessions", async () => {
    const second = await challenge();
    const secondLogin = await call(
      "/api/v1/auth/totp/verify",
      jsonInit({ ticket: second.ticket, code: state.codes[2] }),
    );
    await expectStatus(secondLogin, 200);
    const other = { cookie: sessionCookie(secondLogin) };

    await resetReplayGuard();
    const good = await codeFor(state.secret);

    const badPassword = await call(
      "/api/v1/auth/totp/disable",
      jsonInit({ password: "not-the-password", code: good }),
      state.cookie,
    );
    expect((await expectStatus(badPassword, 401)).error).toBe("密码不正确");

    const badCode = await call(
      "/api/v1/auth/totp/disable",
      jsonInit({ password: ADMIN_PASSWORD, code: wrongCode(good, "9") }),
      state.cookie,
    );
    expect((await expectStatus(badCode, 401)).error).toBe("验证码不正确");

    const disabled = await call(
      "/api/v1/auth/totp/disable",
      jsonInit({ password: ADMIN_PASSWORD, code: good }),
      state.cookie,
    );
    expect(await expectStatus(disabled, 200)).toMatchObject({ ok: true, enabled: false });

    const stored = await env.DB.prepare(
      "SELECT totp_secret, totp_pending_secret, totp_enabled_at, totp_last_counter FROM users WHERE username = ?",
    )
      .bind(ADMIN_USERNAME)
      .first<{
        totp_secret: string | null;
        totp_pending_secret: string | null;
        totp_enabled_at: number | null;
        totp_last_counter: number | null;
      }>();
    expect(stored).toEqual({
      totp_secret: null,
      totp_pending_secret: null,
      totp_enabled_at: null,
      totp_last_counter: null,
    });
    expect(await countOf("SELECT COUNT(*) AS total FROM totp_recovery_codes")).toBe(0);
    expect(await countOf("SELECT COUNT(*) AS total FROM totp_tickets")).toBe(0);
    expect(await countOf("SELECT COUNT(*) AS total FROM sessions")).toBe(1);
    expect((await call("/api/v1/auth/me", {}, other.cookie)).status).toBe(401);
    expect((await call("/api/v1/auth/me", {}, state.cookie)).status).toBe(200);

    const plain = await call(
      "/api/v1/auth/login",
      jsonInit({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
    );
    const session = await expectStatus(plain, 200);
    expect(session.totp_required).toBeUndefined();
    expect((await expectStatus(await call("/api/v1/auth/totp", {}, state.cookie), 200)).enabled).toBe(false);
  }, 20_000);

  it("regenerates recovery codes and invalidates the old list", async () => {
    const setup = await expectStatus(await call("/api/v1/auth/totp/setup", jsonInit({}), state.cookie), 200);
    state.secret = String(setup.secret);
    const enabled = await expectStatus(
      await call("/api/v1/auth/totp/enable", jsonInit({ code: await codeFor(state.secret) }), state.cookie),
      200,
    );
    const oldCodes = (enabled.recovery_codes as string[]).map(String);
    state.codes = oldCodes;

    const regenerated = await call(
      "/api/v1/auth/totp/recovery",
      jsonInit({ password: ADMIN_PASSWORD, code: await codeFor(state.secret) }),
      state.cookie,
    );
    const body = await expectStatus(regenerated, 200);
    const newCodes = (body.recovery_codes as string[]).map(String);
    expect(newCodes).toHaveLength(10);
    expect(newCodes).not.toContain(oldCodes[0]);
    expect(body.recovery_codes_remaining).toBe(10);

    const stale = await challenge();
    const rejected = await call(
      "/api/v1/auth/totp/verify",
      jsonInit({ ticket: stale.ticket, code: oldCodes[0] }),
    );
    expect((await expectStatus(rejected, 401)).error).toBe("验证码不正确");

    const fresh = await challenge();
    const accepted = await call(
      "/api/v1/auth/totp/verify",
      jsonInit({ ticket: fresh.ticket, code: newCodes[0] }),
    );
    const session = await expectStatus(accepted, 200);
    expect(session.user).toMatchObject({ totp_enabled: true });
    const cookie = sessionCookie(accepted);
    expect(
      (await expectStatus(await call("/api/v1/auth/totp", {}, cookie), 200)).recovery_codes_remaining,
    ).toBe(9);
  }, 20_000);

  it("locks password attempts, then still issues a TOTP challenge once the window is clear", async () => {
    for (let index = 0; index < LOGIN_FAILURE_LIMIT; index += 1) {
      const wrong = await call(
        "/api/v1/auth/login",
        jsonInit({ username: ADMIN_USERNAME, password: `wrong-password-${index}` }),
      );
      expect((await expectStatus(wrong, 401)).error).toBe("密码错误");
    }
    const limited = await call(
      "/api/v1/auth/login",
      jsonInit({ username: ADMIN_USERNAME, password: "wrong-password-limit" }),
    );
    expect((await expectStatus(limited, 429)).error).toBe("登录尝试过多，请稍后再试");
    expect(limited.headers.get("retry-after")).toBeTruthy();

    const blocked = await call(
      "/api/v1/auth/login",
      jsonInit({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
    );
    expect((await expectStatus(blocked, 429)).error).toBe("登录尝试过多，请稍后再试");
    expect(blocked.headers.get("set-cookie")).toBeNull();

    const userKey = await loginRateKey("user", "admin");
    await runSql(env.DB, "DELETE FROM rate_limits WHERE token_hash = ?", [userKey]);
    const right = await call(
      "/api/v1/auth/login",
      jsonInit({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
    );
    expect(right.headers.get("set-cookie")).toBeNull();
    const body = await expectStatus(right, 200);
    expect(body.totp_required).toBe(true);
    expect(String(body.ticket)).toMatch(/^tot_/);
  }, 20_000);

  it("stops checking codes after the account failure window is spent", async () => {
    const user = await env.DB.prepare("SELECT id FROM users WHERE username = ?")
      .bind(ADMIN_USERNAME)
      .first<{ id: string }>();
    const userId = String(user?.id);
    const windowStart = Math.floor(Date.now() / TOTP_FAILURE_WINDOW_MS) * TOTP_FAILURE_WINDOW_MS;
    await runSql(env.DB, "DELETE FROM rate_limits WHERE token_hash = ?", [`totp-login:${userId}`]);
    await runSql(
      env.DB,
      "INSERT INTO rate_limits (token_hash, window_start, count) VALUES (?, ?, ?)",
      [`totp-login:${userId}`, windowStart, TOTP_FAILURE_LIMIT + 1],
    );
    await resetReplayGuard();
    const good = await codeFor(state.secret);

    const locked = await call(
      "/api/v1/auth/login",
      jsonInit({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
    );
    expect(locked.headers.get("set-cookie")).toBeNull();
    expect((await expectStatus(locked, 429)).error).toContain("尝试过多");
    expect(await countOf("SELECT COUNT(*) AS total FROM totp_tickets")).toBe(0);

    const ticket = `tot_${"b".repeat(43)}`;
    const now = Date.now();
    await runSql(
      env.DB,
      "INSERT INTO totp_tickets (id, user_id, expires_at, attempts, created_at) VALUES (?, ?, ?, 0, ?)",
      [await sha256Hex(ticket), userId, now + 60_000, now],
    );
    const bypass = await call("/api/v1/auth/totp/verify", jsonInit({ ticket, code: good }));
    expect((await expectStatus(bypass, 429)).error).toContain("尝试过多");
    const counter = await env.DB.prepare("SELECT totp_last_counter FROM users WHERE id = ?")
      .bind(userId)
      .first<{ totp_last_counter: number | null }>();
    expect(counter?.totp_last_counter).toBeNull();

    await runSql(env.DB, "DELETE FROM rate_limits WHERE token_hash = ?", [`totp-login:${userId}`]);
    const fresh = await challenge();
    const verified = await call("/api/v1/auth/totp/verify", jsonInit({ ticket: fresh.ticket, code: good }));
    await expectStatus(verified, 200);
  }, 20_000);

  it("throttles password guesses before turning two-factor off", async () => {
    const user = await env.DB.prepare("SELECT id FROM users WHERE username = ?")
      .bind(ADMIN_USERNAME)
      .first<{ id: string }>();
    const userId = String(user?.id);
    const accountKey = await loginRateKey("account", userId);
    await runSql(env.DB, "DELETE FROM rate_limits WHERE token_hash = ?", [accountKey]);
    for (let index = 0; index < LOGIN_FAILURE_LIMIT; index += 1) {
      const wrong = await call(
        "/api/v1/auth/totp/disable",
        jsonInit({ password: `wrong-${index}`, code: "000000" }),
        state.cookie,
      );
      expect((await expectStatus(wrong, 401)).error).toBe("密码不正确");
    }
    await resetReplayGuard();
    const blocked = await call(
      "/api/v1/auth/totp/disable",
      jsonInit({ password: ADMIN_PASSWORD, code: await codeFor(state.secret) }),
      state.cookie,
    );
    expect((await expectStatus(blocked, 429)).error).toBe("尝试过多，请稍后再试");
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await expectStatus(await call("/api/v1/auth/totp", {}, state.cookie), 200)).enabled).toBe(true);
    const counter = await env.DB.prepare("SELECT totp_last_counter FROM users WHERE id = ?")
      .bind(userId)
      .first<{ totp_last_counter: number | null }>();
    expect(counter?.totp_last_counter).toBeNull();
  }, 20_000);
});

describe("release storage edges", () => {
  beforeAll(async () => {
    await resetSchema();
    await seedConfiguredAdmin();
  });

  it("stores ciphertext when CONTENT_KEY is set and refuses a bad key without writing", async () => {
    const key = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    env.CONTENT_KEY = key;
    const login = await call("/api/v1/auth/login", jsonInit({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }));
    const cookie = sessionCookie(login);
    await expectStatus(login, 200);
    const created = await expectStatus(await call("/api/v1/devices", jsonInit({ name: "加密机" }), cookie), 200);
    const token = String(created.token);
    const stored = await expectStatus(
      await call("/api/v1/sms", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ from: "10086", content: "验证码 135790", device: "Android" }),
      }),
      200,
    );
    expect(stored.code).toBe("135790");
    const row = await env.DB.prepare("SELECT content, encrypted FROM messages WHERE id = ?")
      .bind(String(stored.id))
      .first<{ content: string; encrypted: number }>();
    expect(row?.encrypted).toBe(1);
    expect(row?.content.startsWith(ENCRYPTED_PREFIX)).toBe(true);
    const inbox = await expectStatus(await call("/api/v1/messages", {}, cookie), 200);
    expect(JSON.stringify(inbox.messages)).toContain("验证码 135790");
    expect(JSON.stringify(inbox.messages)).not.toContain(ENCRYPTED_PREFIX);

    env.CONTENT_KEY = "aaaa";
    const before = await countOf("SELECT COUNT(*) AS total FROM messages");
    const rejected = await expectStatus(
      await call("/api/v1/sms", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ from: "10086", content: "验证码 999000", device: "Android" }),
      }),
      500,
    );
    expect(rejected.error).toBe("内容加密密钥无效");
    expect(await countOf("SELECT COUNT(*) AS total FROM messages")).toBe(before);
    env.CONTENT_KEY = "";
  }, 20_000);

  it("lists authenticated push history newest first with pagination and a total", async () => {
    await resetSchema();
    await seedConfiguredAdmin();
    const login = await call("/api/v1/auth/login", jsonInit({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }));
    const cookie = sessionCookie(login);
    const session = await expectStatus(login, 200);
    const userId = String((session.user as { id: string }).id);
    for (const [id, createdAt] of [["history-old", 100], ["history-new", 300], ["history-middle", 200]]) {
      await runSql(
        env.DB,
        "INSERT INTO push_logs (id, user_id, channel_name, channel_kind, source, preview, ok, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [id, userId, "Bark", "bark", "sms", id, 1, createdAt],
      );
    }

    const page = await expectStatus(await call("/api/v1/notify/history?limit=2&offset=1", {}, cookie), 200);
    expect(page.total).toBe(3);
    expect((page.items as Array<{ id: string; ok: boolean }>).map((item) => item.id))
      .toEqual(["history-middle", "history-old"]);
    expect((page.items as Array<{ ok: boolean }>).every((item) => item.ok)).toBe(true);
  }, 20_000);

  it("purges expired messages and push logs, sessions, and rate rows without removing the device", async () => {
    env.CONTENT_KEY = "";
    const login = await call("/api/v1/auth/login", jsonInit({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }));
    const cookie = sessionCookie(login);
    const session = await expectStatus(login, 200);
    const userId = String((session.user as { id: string }).id);
    const created = await expectStatus(await call("/api/v1/devices", jsonInit({ name: "保留测试" }), cookie), 200);
    const token = String(created.token);
    const deviceId = String((created.device as { id: string }).id);
    const old = await expectStatus(
      await call("/api/v1/sms", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ from: "10086", content: "旧短信 101010", device: "Android" }),
      }),
      200,
    );
    const fresh = await expectStatus(
      await call("/api/v1/sms", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ from: "10086", content: "新短信 202020", device: "Android" }),
      }),
      200,
    );
    const now = Date.now();
    await runSql(env.DB, "UPDATE messages SET created_at = ? WHERE id = ?", [now - 100 * 24 * 60 * 60 * 1000, String(old.id)]);
    await runSql(env.DB,
      "INSERT INTO push_logs (id, user_id, channel_name, channel_kind, source, preview, ok, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["expired-push-log", userId, "Bark", "bark", "sms", "old", 1, now - 100 * 24 * 60 * 60 * 1000],
    );
    await runSql(env.DB,
      "INSERT INTO push_logs (id, user_id, channel_name, channel_kind, source, preview, ok, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["fresh-push-log", userId, "Bark", "bark", "sms", "fresh", 1, now],
    );
    await runSql(env.DB, "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)", [
      "expired-session-hash",
      userId,
      now - 1_000,
      now - 86_400_000,
    ]);
    await runSql(env.DB, "INSERT INTO rate_limits (token_hash, window_start, count) VALUES (?, ?, 1)", [
      "old-rate-hash",
      now - 3 * 24 * 60 * 60 * 1000,
    ]);

    const ctx = executionContext();
    await worker.scheduled({ scheduledTime: now, cron: "0 0 * * *" } as ScheduledController, env, ctx);
    await ctx.drain();

    expect(await countOf("SELECT COUNT(*) AS total FROM messages WHERE id = ?", [String(old.id)])).toBe(0);
    expect(await countOf("SELECT COUNT(*) AS total FROM messages WHERE id = ?", [String(fresh.id)])).toBe(1);
    expect(await countOf("SELECT COUNT(*) AS total FROM push_logs WHERE id = ?", ["expired-push-log"])).toBe(0);
    expect(await countOf("SELECT COUNT(*) AS total FROM push_logs WHERE id = ?", ["fresh-push-log"])).toBe(1);
    expect(await countOf("SELECT COUNT(*) AS total FROM sessions WHERE id = ?", ["expired-session-hash"])).toBe(0);
    expect(await countOf("SELECT COUNT(*) AS total FROM rate_limits WHERE token_hash = ?", ["old-rate-hash"])).toBe(0);
    expect(await countOf("SELECT COUNT(*) AS total FROM devices WHERE id = ?", [deviceId])).toBe(1);
    expect((await call("/api/v1/auth/me", {}, cookie)).status).toBe(200);
  }, 20_000);

  it("stores translation columns and toggles the preference without an AI binding", async () => {
    await resetSchema();
    const sql = readFileSync("migrations/0017_message_translation.sql", "utf8");
    expect(sql).toMatch(/ADD COLUMN translated_content TEXT/);
    expect(sql).toMatch(/ADD COLUMN source_lang TEXT/);
    expect(sql).toMatch(/ADD COLUMN translate_enabled INTEGER NOT NULL DEFAULT 0/);

    const messages = await env.DB.prepare("PRAGMA table_info(messages)").all<{ name: string }>();
    expect(messages.results.map((column) => column.name)).toEqual(
      expect.arrayContaining(["translated_content", "source_lang"]),
    );
    const users = await env.DB.prepare("PRAGMA table_info(users)").all<{ name: string; dflt_value: string | null }>();
    const flag = users.results.find((column) => column.name === "translate_enabled");
    expect(flag?.dflt_value).toBe("0");

    await seedConfiguredAdmin();
    const login = await call("/api/v1/auth/login", jsonInit({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }));
    const cookie = sessionCookie(login);
    const me = await expectStatus(await call("/api/v1/me", {}, cookie), 200);
    expect(me.user).toMatchObject({ username: ADMIN_USERNAME, translate_enabled: false });
    const authMe = await expectStatus(await call("/api/v1/auth/me", {}, cookie), 200);
    expect(authMe.user).toMatchObject({ translate_enabled: false });

    const preference = (body: unknown) =>
      call(
        "/api/v1/me/preferences",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        cookie,
      );
    expect((await call("/api/v1/me/preferences", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ translate_enabled: true }) })).status).toBe(401);
    expect((await preference({ translate_enabled: "true" })).status).toBe(400);
    expect((await preference({ translate_enabled: 1 })).status).toBe(400);

    const enabled = await expectStatus(await preference({ translate_enabled: true }), 200);
    expect(enabled).toEqual({ ok: true, translate_enabled: true });
    const after = await expectStatus(await call("/api/v1/me", {}, cookie), 200);
    expect(after.user).toMatchObject({ translate_enabled: true });

    const created = await expectStatus(await call("/api/v1/devices", jsonInit({ name: "翻译测试" }), cookie), 200);
    const token = String(created.token);
    const stored = await expectStatus(
      await call("/api/v1/sms", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: "10010",
          content: "Your package arrived at the lobby this morning.",
          device: "Android",
        }),
      }),
      200,
    );
    expect(stored.ok).toBe(true);
    const row = await env.DB.prepare(
      "SELECT translated_content, source_lang FROM messages WHERE id = ?",
    )
      .bind(String(stored.id))
      .first<{ translated_content: string | null; source_lang: string | null }>();
    expect(row).toEqual({ translated_content: null, source_lang: null });
    const inbox = await expectStatus(await call("/api/v1/messages", {}, cookie), 200);
    const listed = (inbox.messages as Array<Record<string, unknown>>).find((message) => message.id === stored.id);
    expect(listed).toMatchObject({ translated_content: null, source_lang: null });
  }, 20_000);

  it("stores the UI locale and echoes it from the session", async () => {
    await resetSchema();
    const sql = readFileSync("migrations/0019_user_locale.sql", "utf8");
    expect(sql).toMatch(/ADD COLUMN locale TEXT NOT NULL DEFAULT 'zh-CN'/);

    const users = await env.DB.prepare("PRAGMA table_info(users)").all<{ name: string; dflt_value: string | null }>();
    const column = users.results.find((item) => item.name === "locale");
    expect(column?.dflt_value).toBe("'zh-CN'");

    await seedConfiguredAdmin();
    const login = await call("/api/v1/auth/login", jsonInit({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }));
    const cookie = sessionCookie(login);
    const me = await expectStatus(await call("/api/v1/me", {}, cookie), 200);
    expect(me.user).toMatchObject({ username: ADMIN_USERNAME, locale: "zh-CN" });
    const authMe = await expectStatus(await call("/api/v1/auth/me", {}, cookie), 200);
    expect(authMe.user).toMatchObject({ locale: "zh-CN" });

    const preference = (body: unknown) =>
      call(
        "/api/v1/me/preferences",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        cookie,
      );
    expect((await call("/api/v1/me/preferences", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ locale: "en" }) })).status).toBe(401);
    for (const bad of ["zh", "EN", "en-US", "", 1, true, null]) {
      expect((await preference({ locale: bad })).status).toBe(400);
    }
    expect((await preference({})).status).toBe(400);

    const english = await expectStatus(await preference({ locale: "en" }), 200);
    expect(english).toEqual({ ok: true, locale: "en" });
    const after = await expectStatus(await call("/api/v1/auth/me", {}, cookie), 200);
    expect(after.user).toMatchObject({ locale: "en", translate_enabled: false });

    const both = await expectStatus(await preference({ locale: "zh-CN", translate_enabled: true }), 200);
    expect(both).toEqual({ ok: true, locale: "zh-CN", translate_enabled: true });
    const restored = await expectStatus(await call("/api/v1/me", {}, cookie), 200);
    expect(restored.user).toMatchObject({ locale: "zh-CN", translate_enabled: true });
  }, 20_000);
});

describe("release checklist", () => {
  it("matches the operator document and the pages operators will ship", () => {
    const doc = readFileSync("docs/RELEASE_IOS_V2.md", "utf8");
    for (const file of EXPECTED_MIGRATIONS) expect(doc).toContain(file);
    expect(doc).toContain("先迁移再部署");
    expect(doc).toContain("不要在本次准备中部署生产");
    expect(doc).toContain("iCloud");
    expect(doc).toContain("未签名");
    expect(doc).toContain("/api/v1/sms");
    expect(doc).toContain("/api/v1/ingest/:secret");
    expect(doc).toContain("iPhone");

    const readme = readFileSync("README.md", "utf8");
    expect(readme).toContain("docs/RELEASE_IOS_V2.md");
    expect(readme).toContain("0005_device_push.sql");

    const devicesHtml = readFileSync("public/devices.html", "utf8");
    const devicesJs = readFileSync("public/devices.js", "utf8");
    const setup = readFileSync("docs/ios-setup.md", "utf8");
    expect(devicesHtml).toContain('id="sms-url"');
    expect(devicesJs).toContain("/api/v1/sms");
    expect(setup).toContain("https://www.icloud.com/shortcuts/f7880f724c5443aebffc1ab5c5b7788f");
    expect(setup).toContain("信息 › 内容");
    expect(devicesHtml).toContain("https://www.icloud.com/shortcuts/f7880f724c5443aebffc1ab5c5b7788f");
    expect(setup).not.toContain("尚未发布");
    // Unsigned downloadable template must not embed the share URL.
    expect(readFileSync("shortcuts/SMSinBox-iOS.shortcut", "utf8")).not.toContain("icloud.com/shortcuts");
  });
});
