// Release gate: the worker runs against local D1 and the real migration files.
// The other suites stub SQL text, so they cannot catch a missing column or a rewritten 0005.

import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { bytesToBase64Url, hashPassword, sha256Hex, signHmacHex } from "../src/auth";
import { ENCRYPTED_PREFIX } from "../src/crypto";
import worker from "../src/index";

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
];
const TABLES = ["schema_meta", "notify_channels", "messages", "rate_limits", "sessions", "devices", "users"];

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
  expect(secret.startsWith("psh_")).toBe(true);
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

    const login = await call("/api/v1/auth/login", jsonInit({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }));
    const cookie = sessionCookie(login);
    const session = await expectStatus(login, 200);
    expect(session.user).toMatchObject({ username: ADMIN_USERNAME, role: "admin" });

    const listed = await expectStatus(await call("/api/v1/devices", {}, cookie), 200);
    const devices = listed.devices as Array<Record<string, unknown>>;
    const old = devices.find((device) => device.id === LEGACY_DEVICE);
    expect(old).toMatchObject({ name: "旧手机", push: "none", has_secret: false });
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
    expect(pushSecret(issuedUrl).startsWith("psh_")).toBe(true);
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
});

describe("release journey", () => {
  const state: {
    cookie: string;
    deviceId: string;
    token: string;
    pushUrl: string;
    secret: string;
    messageId: string;
    hmacId: string;
    hmacToken: string;
    hmacPush: string;
  } = {
    cookie: "",
    deviceId: "",
    token: "",
    pushUrl: "",
    secret: "",
    messageId: "",
    hmacId: "",
    hmacToken: "",
    hmacPush: "",
  };

  beforeAll(async () => {
    await resetSchema();
  });

  it("rejects a logged-out reader and a cross-site login, then bootstraps the admin", async () => {
    expect((await call("/api/v1/devices")).status).toBe(401);
    const cross = await call(
      "/api/v1/auth/login",
      jsonInit({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }, { origin: "https://evil.test" }),
    );
    expect((await expectStatus(cross, 403)).error).toBe("跨站请求被拒绝");

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

  it("returns a bearer and a push link once, then hides both", async () => {
    const created = await expectStatus(
      await call("/api/v1/devices", jsonInit({ name: "iPhone" }), state.cookie),
      200,
    );
    state.deviceId = String((created.device as { id: string }).id);
    state.token = String(created.token);
    state.pushUrl = String(created.push_url);
    state.secret = pushSecret(state.pushUrl);
    expect(state.token.startsWith("sms_")).toBe(true);
    expect(created.device).toMatchObject({ name: "iPhone", push: "active", has_secret: false });

    const listed = await expectStatus(await call("/api/v1/devices", {}, state.cookie), 200);
    const text = JSON.stringify(listed);
    expect(text).not.toContain(state.token);
    expect(text).not.toContain(state.secret);
    expect(text).not.toContain("push_url");
    expect(listed.devices).toContainEqual(expect.objectContaining({ id: state.deviceId, push: "active" }));
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

  it("keeps HMAC on the bearer door and skips it for the push link", async () => {
    const created = await expectStatus(
      await call("/api/v1/devices", jsonInit({ name: "Pixel", secret: "signing-secret" }), state.cookie),
      200,
    );
    state.hmacId = String((created.device as { id: string }).id);
    state.hmacToken = String(created.token);
    state.hmacPush = String(created.push_url);
    expect(created.device).toMatchObject({ has_secret: true, push: "active" });

    const unsigned = await expectStatus(
      await call("/api/v1/sms", {
        method: "POST",
        headers: { authorization: `Bearer ${state.hmacToken}`, "content-type": "application/json" },
        body: JSON.stringify({ from: "10000", content: "验证码 222333", device: "Pixel" }),
      }),
      401,
    );
    expect(unsigned.error).toBe("该设备要求 HMAC 签名");

    const openDoor = await expectStatus(
      await call(new URL(state.hmacPush).pathname, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "10000", content: "验证码 222333", device: "Pixel" }),
      }),
      200,
    );
    expect(openDoor).toMatchObject({ ok: true, code: "222333" });

    const body = JSON.stringify({ from: "10000", content: "验证码 333444", device: "Pixel" });
    const bytes = new TextEncoder().encode(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await signHmacHex("signing-secret", timestamp, bytes);
    const signed = await expectStatus(
      await call("/api/v1/sms", {
        method: "POST",
        headers: {
          authorization: `Bearer ${state.hmacToken}`,
          "content-type": "application/json",
          "x-timestamp": timestamp,
          "x-signature": signature,
        },
        body,
      }),
      200,
    );
    expect(signed).toMatchObject({ ok: true, code: "333444" });
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
    expect(JSON.stringify(listed)).not.toContain(state.secret);
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
    const tokenHash = await sha256Hex(state.token);
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

  it("keeps messages and credentials when the configured admin logs in", async () => {
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
    expect((await expectStatus(elderLogin, 401)).error).toBe("仅管理员可以登录");
    expect(await countOf("SELECT COUNT(*) AS total FROM users")).toBe(2);
    expect(await countOf("SELECT COUNT(*) AS total FROM devices WHERE user_id = ?", [elderId])).toBe(1);

    const login = await call("/api/v1/auth/login", jsonInit({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }));
    const cookie = sessionCookie(login);
    expect((await expectStatus(login, 200)).user).toMatchObject({ username: ADMIN_USERNAME, role: "admin" });

    expect(await countOf("SELECT COUNT(*) AS total FROM users")).toBe(1);
    expect(await countOf("SELECT COUNT(*) AS total FROM users WHERE id = ?", [adminId])).toBe(1);
    expect(await countOf("SELECT COUNT(*) AS total FROM users WHERE id = ?", [elderId])).toBe(0);
    expect(await countOf("SELECT COUNT(*) AS total FROM sessions WHERE id = ?", ["elder-session"])).toBe(0);
    expect(await countOf("SELECT COUNT(*) AS total FROM messages WHERE id = ?", [messageId])).toBe(1);
    expect(await countOf("SELECT COUNT(*) AS total FROM notify_channels WHERE id = ? AND user_id = ?", [channelId, adminId])).toBe(1);
    expect(await countOf("SELECT COUNT(*) AS total FROM rate_limits WHERE token_hash = ?", [tokenHash])).toBe(1);
    expect(await countOf("SELECT COUNT(*) AS total FROM schema_meta WHERE key = ?", ["single_user_merged_at"])).toBe(1);
    const device = await env.DB.prepare("SELECT user_id, token_hash, push_token_hash FROM devices WHERE id = ?")
      .bind(deviceId)
      .first<{ user_id: string; token_hash: string; push_token_hash: string }>();
    expect(device).toEqual({ user_id: adminId, token_hash: tokenHash, push_token_hash: pushHash });

    const inbox = await expectStatus(await call("/api/v1/messages", {}, cookie), 200);
    expect(JSON.stringify(inbox.messages)).toContain("旧成员短信 246810");
    const stored = await expectStatus(
      await call("/api/v1/sms", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ from: "10086", content: "验证码 135790", device: "Android" }),
      }),
      200,
    );
    expect(stored).toMatchObject({ ok: true, code: "135790" });
    const still = await env.DB.prepare("SELECT token_hash, push_token_hash FROM devices WHERE id = ?")
      .bind(deviceId)
      .first<{ token_hash: string; push_token_hash: string }>();
    expect(still).toEqual({ token_hash: tokenHash, push_token_hash: pushHash });

    const again = await call("/api/v1/auth/login", jsonInit({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }));
    expect(again.status).toBe(200);
    expect(await countOf("SELECT COUNT(*) AS total FROM users")).toBe(1);
    expect(await countOf("SELECT COUNT(*) AS total FROM messages WHERE id = ?", [messageId])).toBe(1);

    const previous = env.ADMIN_USERNAME;
    try {
      env.ADMIN_USERNAME = "second-admin";
      const created = await call(
        "/api/v1/auth/login",
        jsonInit({ username: "second-admin", password: ADMIN_PASSWORD }),
      );
      expect((await expectStatus(created, 409)).error).toContain("不会再创建管理员");
      expect(await countOf("SELECT COUNT(*) AS total FROM users")).toBe(1);
    } finally {
      env.ADMIN_USERNAME = previous;
    }
  }, 30_000);
});

describe("release storage edges", () => {
  beforeAll(async () => {
    await resetSchema();
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

  it("purges expired messages, sessions, and rate rows without removing the device", async () => {
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
    await worker.scheduled({ scheduledTime: now, cron: "15 3 * * *" } as ScheduledController, env, ctx);
    await ctx.drain();

    expect(await countOf("SELECT COUNT(*) AS total FROM messages WHERE id = ?", [String(old.id)])).toBe(0);
    expect(await countOf("SELECT COUNT(*) AS total FROM messages WHERE id = ?", [String(fresh.id)])).toBe(1);
    expect(await countOf("SELECT COUNT(*) AS total FROM sessions WHERE id = ?", ["expired-session-hash"])).toBe(0);
    expect(await countOf("SELECT COUNT(*) AS total FROM rate_limits WHERE token_hash = ?", ["old-rate-hash"])).toBe(0);
    expect(await countOf("SELECT COUNT(*) AS total FROM devices WHERE id = ?", [deviceId])).toBe(1);
    expect((await call("/api/v1/auth/me", {}, cookie)).status).toBe(200);
  }, 20_000);
});

describe("release checklist", () => {
  it("matches the operator document and the pages operators will ship", () => {
    const doc = readFileSync("docs/RELEASE_IOS_V2.md", "utf8");
    for (const file of EXPECTED_MIGRATIONS) expect(doc).toContain(file);
    expect(doc).toContain("先迁移再部署");
    expect(doc).toContain("不要在本次准备中部署生产");
    expect(doc).toContain("尚未发布");
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
    expect(setup).toContain("尚未发布");
    for (const file of [devicesHtml, setup, readFileSync("shortcuts/SMSinBox-iOS.shortcut", "utf8")]) {
      expect(file).not.toContain("icloud.com/shortcuts");
    }
  });
});
