import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { sha256Hex } from "../src/auth";
import { seedAdmin } from "./seed-admin";
import worker from "../src/index";
import { APP_VERSION } from "../src/version";

const ORIGIN = "http://smsinbox.test";
const ADMIN_PASSWORD = "admin-secret-password";
const MIGRATION_DIR = "migrations";

let mf: Miniflare;
let env: Env;

type TestContext = ExecutionContext & { drain(): Promise<void> };
const contexts: TestContext[] = [];

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

async function call(path: string, init: RequestInit = {}, cookie?: string, bearer?: string): Promise<Response> {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
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
  return `smsinbox_session=${match?.[1] ?? ""}`;
}

function jsonInit(body: unknown, extra?: HeadersInit): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...(extra ? Object.fromEntries(new Headers(extra).entries()) : {}) },
    body: JSON.stringify(body),
  };
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
  const prepared = db.prepare(statement);
  await (args.length > 0 ? prepared.bind(...args) : prepared).run();
}

async function applyMigrations(db: D1Database): Promise<void> {
  const files = readdirSync(MIGRATION_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    for (const statement of statementsIn(file)) {
      await runSql(db, statement);
    }
  }
}

let adminCookie = "";
let deviceAId = "11111111-1111-4111-8111-111111111111";
let deviceBId = "22222222-2222-4222-8222-222222222222";
let msgA1Id = "33333333-3333-4333-8333-333333333331";
let msgA2Id = "33333333-3333-4333-8333-333333333332";
let msgB1Id = "33333333-3333-4333-8333-333333333333";
let adminUserId = "";

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
          env: { DB: { type: "d1", id: "smsinbox-api-mcp" } },
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
  const db = (await mf.getD1Database("DB")) as unknown as D1Database;
  env = {
    DB: db,
    ASSETS: {
      fetch: async () => new Response("asset", { status: 200 }),
      connect() {
        throw new Error("assets connect is not used");
      },
    } as Fetcher,
    RETENTION_DAYS: "90",
    CONTENT_KEY: "",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD,
    DEVICE_JWT_SECRET: "integration-device-jwt-secret-mcp-0001",
  };

  await applyMigrations(db);
  await seedAdmin(db, { username: "admin", password: ADMIN_PASSWORD });

  const loginRes = await call("/api/v1/auth/login", jsonInit({ username: "admin", password: ADMIN_PASSWORD }));
  expect(loginRes.status).toBe(200);
  adminCookie = sessionCookie(loginRes);
  const meRes = await expectStatus(await call("/api/v1/auth/me", {}, adminCookie), 200);
  adminUserId = (meRes.user as { id: string }).id;

  // Insert two devices
  const now = Date.now();
  await runSql(
    db,
    `INSERT INTO devices (id, user_id, name, platform, token_hash, secret, token_version, last_seen_at, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
    [deviceAId, adminUserId, "Device Alpha", "ios", "hash_a", now - 5_000, now - 100_000],
  );
  await runSql(
    db,
    `INSERT INTO devices (id, user_id, name, platform, token_hash, secret, token_version, last_seen_at, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
    [deviceBId, adminUserId, "Device Beta", "android", "hash_b", now - 30 * 60 * 1000, now - 200_000],
  );

  // Insert sample messages
  // Device A: msg 1 (with OTP)
  await runSql(
    db,
    `INSERT INTO messages (id, device_id, from_number, to_number, content, content_hash, code, code_source, raw_payload, received_at, created_at, encrypted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [msgA1Id, deviceAId, "10086", "13800000000", "【中国移动】您的验证码是 889900，请勿泄露给他人。", "chash_a1", "889900", "regex", "{}", now - 20_000, now - 20_000],
  );
  // Device A: msg 2 (regular notification)
  await runSql(
    db,
    `INSERT INTO messages (id, device_id, from_number, to_number, content, content_hash, code, code_source, raw_payload, received_at, created_at, encrypted)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, 0)`,
    [msgA2Id, deviceAId, "顺丰速运", "13800000000", "您的快递已放置于蜂巢快递柜，取件码 1234。", "chash_a2", "{}", now - 10_000, now - 10_000],
  );
  // Device B: msg 1 (with OTP)
  await runSql(
    db,
    `INSERT INTO messages (id, device_id, from_number, to_number, content, content_hash, code, code_source, raw_payload, received_at, created_at, encrypted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [msgB1Id, deviceBId, "10010", "13900000000", "【中国联通】登录验证码 654321，5分钟内有效。", "chash_b1", "654321", "regex", "{}", now - 15_000, now - 15_000],
  );
}, 30_000);

afterAll(async () => {
  await Promise.all(contexts.map((ctx) => ctx.drain()));
  await mf.dispose();
});

describe("Admin API Token Management (/api/v1/api-tokens)", () => {
  it("requires login and rejects unauthenticated requests", async () => {
    const listRes = await call("/api/v1/api-tokens");
    expect(listRes.status).toBe(401);

    const createRes = await call("/api/v1/api-tokens", jsonInit({ name: "test", permissions: ["messages:read"] }));
    expect(createRes.status).toBe(401);
  });

  it("rejects cross-site CSRF write requests", async () => {
    const res = await call(
      "/api/v1/api-tokens",
      jsonInit({ name: "csrf", permissions: ["messages:read"] }, { "sec-fetch-site": "cross-site" }),
      adminCookie,
    );
    expect(res.status).toBe(403);
  });

  it("validates input name and permissions on creation", async () => {
    const noName = await expectStatus(
      await call("/api/v1/api-tokens", jsonInit({ name: "", permissions: ["messages:read"] }), adminCookie),
      400,
    );
    expect(noName.ok).toBe(false);

    const noPerms = await expectStatus(
      await call("/api/v1/api-tokens", jsonInit({ name: "token1", permissions: [] }), adminCookie),
      400,
    );
    expect(noPerms.ok).toBe(false);
  });

  it("creates, lists, disables, enables, revokes, and deletes a token", async () => {
    // 1. Create token
    const created = await expectStatus(
      await call(
        "/api/v1/api-tokens",
        jsonInit({
          name: "Test Admin Token",
          permissions: ["messages:read", "otp:read", "devices:read", "devices:status"],
          device_scope: [],
          expires_in_days: 30,
        }),
        adminCookie,
      ),
      200,
    );
    expect(created.ok).toBe(true);
    const plaintext = created.token as string;
    expect(plaintext.startsWith("smsx_")).toBe(true);
    const record = created.record as Record<string, unknown>;
    expect(record.name).toBe("Test Admin Token");
    expect(record.status).toBe("active");
    expect(record.permissions).toEqual(["messages:read", "otp:read", "devices:read", "devices:status"]);
    expect(record.device_scope).toEqual([]);
    expect(record.expires_at).toBeGreaterThan(Date.now());
    const tokenId = record.id as string;

    // 2. List tokens: the owner's list carries the full plaintext (0013)
    //    but never the hash.
    const list = await expectStatus(await call("/api/v1/api-tokens", {}, adminCookie), 200);
    expect(list.ok).toBe(true);
    const tokens = list.tokens as Array<Record<string, unknown>>;
    const found = tokens.find((t) => t.id === tokenId);
    expect(found).toBeTruthy();
    expect(found?.token).toBe(plaintext);
    expect(found).not.toHaveProperty("token_hash");
    expect(found?.status).toBe("active");

    // 2b. Rename the token; invalid names and unknown ids are rejected.
    const renamed = await expectStatus(
      await call(
        `/api/v1/api-tokens/${tokenId}`,
        { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "改名后的令牌" }) },
        adminCookie,
      ),
      200,
    );
    expect(renamed.name).toBe("改名后的令牌");
    await expectStatus(
      await call(
        `/api/v1/api-tokens/${tokenId}`,
        { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "  " }) },
        adminCookie,
      ),
      400,
    );
    await expectStatus(
      await call(
        "/api/v1/api-tokens/99999999-9999-4999-8999-999999999999",
        { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) },
        adminCookie,
      ),
      404,
    );
    const listRenamed = await expectStatus(await call("/api/v1/api-tokens", {}, adminCookie), 200);
    expect(
      (listRenamed.tokens as Array<Record<string, unknown>>).find((t) => t.id === tokenId)?.name,
    ).toBe("改名后的令牌");

    // 3. Disable token
    const disableRes = await expectStatus(
      await call(`/api/v1/api-tokens/${tokenId}/disable`, { method: "POST" }, adminCookie),
      200,
    );
    expect(disableRes.ok).toBe(true);

    // Verify status becomes "disabled" and external API request immediately returns 401
    const listDisabled = await expectStatus(await call("/api/v1/api-tokens", {}, adminCookie), 200);
    const foundDisabled = (listDisabled.tokens as Array<Record<string, unknown>>).find((t) => t.id === tokenId);
    expect(foundDisabled?.status).toBe("disabled");

    const disabledExtRes = await call("/api/ext/v1/health", {}, undefined, plaintext);
    expect(disabledExtRes.status).toBe(401);
    const disabledJson = (await disabledExtRes.json()) as { error: { code: string } };
    expect(disabledJson.error.code).toBe("TOKEN_DISABLED");

    // 4. Enable token
    const enableRes = await expectStatus(
      await call(`/api/v1/api-tokens/${tokenId}/enable`, { method: "POST" }, adminCookie),
      200,
    );
    expect(enableRes.ok).toBe(true);

    const extResEnabled = await expectStatus(await call("/api/ext/v1/health", {}, undefined, plaintext), 200);
    expect(extResEnabled.ok).toBe(true);

    // 5. Revoke token
    const revokeRes = await expectStatus(
      await call(`/api/v1/api-tokens/${tokenId}/revoke`, { method: "POST" }, adminCookie),
      200,
    );
    expect(revokeRes.ok).toBe(true);

    const revokedExtRes = await call("/api/ext/v1/health", {}, undefined, plaintext);
    expect(revokedExtRes.status).toBe(401);
    const revokedJson = (await revokedExtRes.json()) as { error: { code: string } };
    expect(revokedJson.error.code).toBe("TOKEN_REVOKED");

    // 6. Delete token
    const deleteRes = await expectStatus(
      await call(`/api/v1/api-tokens/${tokenId}`, { method: "DELETE" }, adminCookie),
      200,
    );
    expect(deleteRes.ok).toBe(true);

    const listAfterDelete = await expectStatus(await call("/api/v1/api-tokens", {}, adminCookie), 200);
    const foundDeleted = (listAfterDelete.tokens as Array<Record<string, unknown>>).find((t) => t.id === tokenId);
    expect(foundDeleted).toBeUndefined();
  });
});

describe("External REST API (/api/ext/v1)", () => {
  let fullToken = "";
  let scopedDevAToken = "";
  let noMessagesToken = "";

  beforeAll(async () => {
    // Token with full permissions and all devices
    const res1 = await expectStatus(
      await call(
        "/api/v1/api-tokens",
        jsonInit({
          name: "Full Token",
          permissions: ["messages:read", "otp:read", "devices:read", "devices:status"],
          device_scope: [],
        }),
        adminCookie,
      ),
      200,
    );
    fullToken = res1.token as string;

    // Token scoped only to Device A
    const res2 = await expectStatus(
      await call(
        "/api/v1/api-tokens",
        jsonInit({
          name: "Scoped Device A Token",
          permissions: ["messages:read", "otp:read", "devices:read", "devices:status"],
          device_scope: [deviceAId],
        }),
        adminCookie,
      ),
      200,
    );
    scopedDevAToken = res2.token as string;

    // Token without messages:read permission
    const res3 = await expectStatus(
      await call(
        "/api/v1/api-tokens",
        jsonInit({
          name: "No Messages Token",
          permissions: ["devices:read"],
          device_scope: [],
        }),
        adminCookie,
      ),
      200,
    );
    noMessagesToken = res3.token as string;
  });

  it("requires a valid Bearer token and rejects invalid or missing tokens", async () => {
    const noToken = await call("/api/ext/v1/health");
    expect(noToken.status).toBe(401);

    const badToken = await call("/api/ext/v1/health", {}, undefined, "smsx_invalid_token_xyz");
    expect(badToken.status).toBe(401);
  });

  it("serves /health and /me with token details", async () => {
    const health = await expectStatus(await call("/api/ext/v1/health", {}, undefined, fullToken), 200);
    expect(health).toMatchObject({ ok: true, data: { status: "ok", version: APP_VERSION } });

    const me = await expectStatus(await call("/api/ext/v1/me", {}, undefined, scopedDevAToken), 200);
    expect(me).toMatchObject({
      ok: true,
      data: {
        name: "Scoped Device A Token",
        permissions: ["messages:read", "otp:read", "devices:read", "devices:status"],
        device_scope: [deviceAId],
      },
    });
  });

  it("serves OpenAPI 3.0 specification without authentication", async () => {
    const openapi = await expectStatus(await call("/api/ext/v1/openapi.json"), 200);
    expect(openapi.openapi).toBe("3.0.3");
    expect((openapi.paths as Record<string, unknown>)["/messages"]).toBeTruthy();
  });

  it("enforces permission checks (returns 403 on missing permission)", async () => {
    const res = await call("/api/ext/v1/messages", {}, undefined, noMessagesToken);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PERMISSION_DENIED");
  });

  it("enforces SQL-level device scope filtering on messages list and get", async () => {
    // Full token sees messages from both device A and device B
    const fullRes = await expectStatus(await call("/api/ext/v1/messages", {}, undefined, fullToken), 200);
    expect(fullRes.ok).toBe(true);
    const allMessages = fullRes.data as Array<{ id: string; device_id: string; from: string }>;
    expect(allMessages.length).toBe(3);

    // Scoped token ONLY sees Device A messages (2 messages)
    const scopedRes = await expectStatus(await call("/api/ext/v1/messages", {}, undefined, scopedDevAToken), 200);
    expect(scopedRes.ok).toBe(true);
    const scopedMessages = scopedRes.data as Array<{ id: string; device_id: string; from: string }>;
    expect(scopedMessages.length).toBe(2);
    for (const msg of scopedMessages) {
      expect(msg.device_id).toBe(deviceAId);
    }

    // Scoped token reading Device A message by ID returns 200
    const devAMsgRes = await expectStatus(
      await call(`/api/ext/v1/messages/${msgA1Id}`, {}, undefined, scopedDevAToken),
      200,
    );
    expect(devAMsgRes.ok).toBe(true);

    // Scoped token reading Device B message by ID returns 404 (prevent enumeration!)
    const devBMsgRes = await call(`/api/ext/v1/messages/${msgB1Id}`, {}, undefined, scopedDevAToken);
    expect(devBMsgRes.status).toBe(404);
  });

  it("supports pagination and search filters", async () => {
    const paged = await expectStatus(
      await call("/api/ext/v1/messages?limit=1&offset=0", {}, undefined, fullToken),
      200,
    );
    expect(paged.page).toMatchObject({ limit: 1, offset: 0, total: 3 });
    expect((paged.data as unknown[]).length).toBe(1);

    const searchFrom = await expectStatus(
      await call("/api/ext/v1/messages?from=10086", {}, undefined, fullToken),
      200,
    );
    expect((searchFrom.data as unknown[]).length).toBe(1);

    const searchQ = await expectStatus(
      await call("/api/ext/v1/messages?q=验证码", {}, undefined, fullToken),
      200,
    );
    expect((searchQ.data as unknown[]).length).toBe(2);
  });

  it("handles /otp/latest with clear not-found semantics and recognized regex status", async () => {
    // Latest OTP across all devices
    const latest = await expectStatus(await call("/api/ext/v1/otp/latest", {}, undefined, fullToken), 200);
    expect(latest.ok).toBe(true);
    const data = latest.data as Record<string, unknown>;
    expect(data.code).toBeTruthy();
    expect(data.code_source).toBe("regex");
    expect(data.code_status).toBe("recognized");

    // Scoped token only gets Device A's OTP
    const scopedLatest = await expectStatus(await call("/api/ext/v1/otp/latest", {}, undefined, scopedDevAToken), 200);
    expect(scopedLatest.ok).toBe(true);
    expect((scopedLatest.data as Record<string, unknown>).code).toBe("889900");
    expect((scopedLatest.data as Record<string, unknown>).device_id).toBe(deviceAId);

    // Filtering for a non-existent sender returns data: null (clear not found semantics, no hallucination)
    const noneFound = await expectStatus(
      await call("/api/ext/v1/otp/latest?from=99999999", {}, undefined, fullToken),
      200,
    );
    expect(noneFound.ok).toBe(true);
    expect(noneFound.data).toBeNull();
  });

  it("handles /otp/search with pagination", async () => {
    const searchRes = await expectStatus(await call("/api/ext/v1/otp/search", {}, undefined, fullToken), 200);
    expect(searchRes.ok).toBe(true);
    expect((searchRes.data as unknown[]).length).toBe(2);
    expect(searchRes.page).toMatchObject({ total: 2 });
  });

  it("lists authorized devices and returns derived online/offline status", async () => {
    // Scoped token only sees Device A
    const scopedDevs = await expectStatus(await call("/api/ext/v1/devices", {}, undefined, scopedDevAToken), 200);
    expect(scopedDevs.ok).toBe(true);
    const devs = scopedDevs.data as Array<Record<string, unknown>>;
    expect(devs.length).toBe(1);
    expect(devs[0].id).toBe(deviceAId);
    expect(devs[0].status).toBe("online"); // last seen within 15 min

    // Full token sees both devices
    const fullDevs = await expectStatus(await call("/api/ext/v1/devices", {}, undefined, fullToken), 200);
    const allDevs = fullDevs.data as Array<Record<string, unknown>>;
    expect(allDevs.length).toBe(2);
    const devB = allDevs.find((d) => d.id === deviceBId);
    expect(devB?.status).toBe("offline"); // last seen 30 min ago (> 15 min)

    // Device status endpoint
    const statusA = await expectStatus(
      await call(`/api/ext/v1/devices/${deviceAId}/status`, {}, undefined, scopedDevAToken),
      200,
    );
    expect(statusA.data).toMatchObject({
      id: deviceAId,
      status: "online",
    });

    // Out of scope device status returns 404
    const statusB = await call(`/api/ext/v1/devices/${deviceBId}/status`, {}, undefined, scopedDevAToken);
    expect(statusB.status).toBe(404);
  });
});

describe("MCP Server (/mcp)", () => {
  let mcpToken = "";
  let scopedMcpToken = "";

  beforeAll(async () => {
    const res1 = await expectStatus(
      await call(
        "/api/v1/api-tokens",
        jsonInit({
          name: "MCP Full Token",
          permissions: ["messages:read", "otp:read", "devices:read", "devices:status"],
          device_scope: [],
        }),
        adminCookie,
      ),
      200,
    );
    mcpToken = res1.token as string;

    const res2 = await expectStatus(
      await call(
        "/api/v1/api-tokens",
        jsonInit({
          name: "MCP Scoped Token",
          permissions: ["messages:read", "otp:read", "devices:read", "devices:status"],
          device_scope: [deviceAId],
        }),
        adminCookie,
      ),
      200,
    );
    scopedMcpToken = res2.token as string;
  });

  it("requires POST method and Bearer token", async () => {
    const getRes = await call("/mcp", { method: "GET" }, undefined, mcpToken);
    expect(getRes.status).toBe(405);

    const noAuth = await call("/mcp", jsonInit({ jsonrpc: "2.0", method: "ping", id: 1 }));
    expect(noAuth.status).toBe(401);
  });

  it("handles initialize, notifications/initialized, and ping", async () => {
    const initRes = await expectStatus(
      await call(
        "/mcp",
        jsonInit({ jsonrpc: "2.0", method: "initialize", id: 1, params: { clientInfo: { name: "test-client" } } }),
        undefined,
        mcpToken,
      ),
      200,
    );
    expect(initRes.result).toMatchObject({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "smsinbox-mcp", version: APP_VERSION },
    });

    const notifRes = await call(
      "/mcp",
      jsonInit({ jsonrpc: "2.0", method: "notifications/initialized" }),
      undefined,
      mcpToken,
    );
    expect(notifRes.status).toBe(202);

    const pingRes = await expectStatus(
      await call("/mcp", jsonInit({ jsonrpc: "2.0", method: "ping", id: 2 }), undefined, mcpToken),
      200,
    );
    expect(pingRes.result).toEqual({});
  });

  it("lists all 10 tools on tools/list", async () => {
    const toolsRes = await expectStatus(
      await call("/mcp", jsonInit({ jsonrpc: "2.0", method: "tools/list", id: 3 }), undefined, mcpToken),
      200,
    );
    const tools = (toolsRes.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.length).toBe(10);
    const names = tools.map((t) => t.name);
    expect(names).toEqual([
      "list_messages",
      "search_messages",
      "get_message",
      "get_latest_otp",
      "search_otp",
      "list_devices",
      "get_device_status",
      "create_device",
      "get_device_push_url",
      "rotate_device_push_url",
    ]);
  });

  it("calls list_messages and get_message within scope", async () => {
    const listCall = await expectStatus(
      await call(
        "/mcp",
        jsonInit({
          jsonrpc: "2.0",
          method: "tools/call",
          id: 4,
          params: { name: "list_messages", arguments: { limit: 10 } },
        }),
        undefined,
        scopedMcpToken,
      ),
      200,
    );
    const listResult = listCall.result as { content: Array<{ text: string }>; structuredContent: { total: number } };
    expect(listResult.structuredContent.total).toBe(2);
    expect(listResult.content[0].text).toContain("共 2 条短信");

    // Call get_message on Device A message
    const getCall = await expectStatus(
      await call(
        "/mcp",
        jsonInit({
          jsonrpc: "2.0",
          method: "tools/call",
          id: 5,
          params: { name: "get_message", arguments: { id: msgA1Id } },
        }),
        undefined,
        scopedMcpToken,
      ),
      200,
    );
    expect((getCall.result as { isError?: boolean }).isError).toBeFalsy();

    // Call get_message on Device B message (out of scope) -> returns isError: true
    const getCallB = await expectStatus(
      await call(
        "/mcp",
        jsonInit({
          jsonrpc: "2.0",
          method: "tools/call",
          id: 6,
          params: { name: "get_message", arguments: { id: msgB1Id } },
        }),
        undefined,
        scopedMcpToken,
      ),
      200,
    );
    expect((getCallB.result as { isError: boolean }).isError).toBe(true);
  });

  it("calls get_latest_otp, search_otp, list_devices, and get_device_status", async () => {
    const otpCall = await expectStatus(
      await call(
        "/mcp",
        jsonInit({
          jsonrpc: "2.0",
          method: "tools/call",
          id: 7,
          params: { name: "get_latest_otp", arguments: {} },
        }),
        undefined,
        scopedMcpToken,
      ),
      200,
    );
    const otpResult = otpCall.result as {
      content: Array<{ text: string }>;
      structuredContent: { code: string; code_source: string; code_status: string };
    };
    expect(otpResult.structuredContent.code).toBe("889900");
    expect(otpResult.structuredContent.code_source).toBe("regex");
    expect(otpResult.structuredContent.code_status).toBe("recognized");
    expect(otpResult.content[0].text).toContain("889900");

    // Device status tool
    const devStatusCall = await expectStatus(
      await call(
        "/mcp",
        jsonInit({
          jsonrpc: "2.0",
          method: "tools/call",
          id: 8,
          params: { name: "get_device_status", arguments: { id: deviceAId } },
        }),
        undefined,
        scopedMcpToken,
      ),
      200,
    );
    const devStatus = (devStatusCall.result as { structuredContent: { status: string } }).structuredContent;
    expect(devStatus.status).toBe("online");
  });

  it("handles token expiration and rate limiting", async () => {
    // 1. Create expired token directly in DB
    const expiredPlaintext = "smsx_expired_token_value_123456789";
    const expiredHash = await sha256Hex(expiredPlaintext);
    await runSql(
      env.DB,
      `INSERT INTO api_tokens (id, user_id, name, token_hash, token_prefix, permissions, device_scope, expires_at, created_at)
       VALUES (?, ?, 'Expired Token', ?, 'smsx_exp...', '["messages:read"]', '[]', ?, ?)`,
      ["exp-token-id", adminUserId, expiredHash, Date.now() - 1000, Date.now() - 10_000],
    );

    const expRes = await call("/api/ext/v1/health", {}, undefined, expiredPlaintext);
    expect(expRes.status).toBe(401);
    const expJson = (await expRes.json()) as { error: { code: string } };
    expect(expJson.error.code).toBe("TOKEN_EXPIRED");

    // 2. Rate limiting test: consume rate limit up to limit (120)
    const rateTokenPlaintext = "smsx_rate_limited_token_12345678";
    const rateHash = await sha256Hex(rateTokenPlaintext);
    await runSql(
      env.DB,
      `INSERT INTO api_tokens (id, user_id, name, token_hash, token_prefix, permissions, device_scope, expires_at, created_at)
       VALUES (?, ?, 'Rate Token', ?, 'smsx_rat...', '["messages:read"]', '[]', NULL, ?)`,
      ["rate-token-id", adminUserId, rateHash, Date.now()],
    );

    // Pre-fill rate limit window to 120
    const windowStart = Math.floor(Date.now() / 60_000) * 60_000;
    await runSql(
      env.DB,
      `INSERT INTO rate_limits (token_hash, window_start, count) VALUES (?, ?, 120)`,
      [`ext:${rateHash}`, windowStart],
    );

    // Next request should return 429
    const rateLimitedRes = await call("/api/ext/v1/health", {}, undefined, rateTokenPlaintext);
    expect(rateLimitedRes.status).toBe(429);
    const rateJson = (await rateLimitedRes.json()) as { error: { code: string } };
    expect(rateJson.error.code).toBe("RATE_LIMITED");
  });

  it("handles MCP permission denial and unknown tools", async () => {
    // Create token with ONLY messages:read
    const onlyMsgRes = await expectStatus(
      await call(
        "/api/v1/api-tokens",
        jsonInit({
          name: "MCP Only Messages",
          permissions: ["messages:read"],
          device_scope: [],
        }),
        adminCookie,
      ),
      200,
    );
    const onlyMsgToken = onlyMsgRes.token as string;

    // Call list_devices without devices:read
    const devCall = await expectStatus(
      await call(
        "/mcp",
        jsonInit({
          jsonrpc: "2.0",
          method: "tools/call",
          id: 9,
          params: { name: "list_devices", arguments: {} },
        }),
        undefined,
        onlyMsgToken,
      ),
      200,
    );
    expect((devCall.result as { isError: boolean }).isError).toBe(true);

    // Call unknown tool
    const unknownTool = await expectStatus(
      await call(
        "/mcp",
        jsonInit({
          jsonrpc: "2.0",
          method: "tools/call",
          id: 10,
          params: { name: "delete_everything", arguments: {} },
        }),
        undefined,
        mcpToken,
      ),
      200,
    );
    expect((unknownTool.result as { isError: boolean }).isError).toBe(true);

    // Call unknown method
    const unknownMethod = await expectStatus(
      await call(
        "/mcp",
        jsonInit({
          jsonrpc: "2.0",
          method: "unknown_method",
          id: 11,
        }),
        undefined,
        mcpToken,
      ),
      404,
    );
    expect(unknownMethod.error).toMatchObject({ code: -32601 });
  });
});

describe("External device management (REST + MCP)", () => {
  // Legacy device: push link active on paper, but the plaintext secret was
  // never stored (pre-0012 row), so its URL cannot be rebuilt.
  const deviceCId = "44444444-4444-4444-8444-444444444444";
  // Device whose push link was revoked.
  const deviceDId = "55555555-5555-4555-8555-555555555555";
  let fullToken = "";
  let createToken = "";
  let pushScopedToken = "";
  let createPushScopedToken = "";
  let readToken = "";
  let groupId = "";
  let createdDeviceId = "";
  let createdPushUrl = "";

  async function makeToken(name: string, permissions: string[], deviceScope: string[]): Promise<string> {
    const res = await expectStatus(
      await call("/api/v1/api-tokens", jsonInit({ name, permissions, device_scope: deviceScope }), adminCookie),
      200,
    );
    return res.token as string;
  }

  function pushTokenOf(pushUrl: string): string {
    return pushUrl.split("/ingest/")[1] ?? "";
  }

  async function mcpCall(token: string, name: string, args: Record<string, unknown>) {
    const res = await expectStatus(
      await call(
        "/mcp",
        jsonInit({ jsonrpc: "2.0", method: "tools/call", id: 42, params: { name, arguments: args } }),
        undefined,
        token,
      ),
      200,
    );
    return res.result as {
      isError?: boolean;
      content: Array<{ text: string }>;
      structuredContent?: { push_url?: string; device?: { id: string } } | null;
    };
  }

  beforeAll(async () => {
    fullToken = await makeToken(
      "Mgmt Full",
      ["messages:read", "otp:read", "devices:read", "devices:status", "devices:create", "devices:push"],
      [],
    );
    createToken = await makeToken("Mgmt Create Only", ["devices:create"], []);
    pushScopedToken = await makeToken("Mgmt Push Scoped", ["devices:push"], [deviceAId]);
    createPushScopedToken = await makeToken("Mgmt Create+Push Scoped", ["devices:create", "devices:push"], [deviceAId]);
    readToken = await makeToken("Mgmt Read Only", ["devices:read"], []);

    const now = Date.now();
    await runSql(
      env.DB,
      `INSERT INTO devices (id, user_id, name, platform, token_hash, secret, token_version, last_seen_at, created_at, push_token_hash)
       VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?, ?)`,
      [deviceCId, adminUserId, "Device Legacy", "other", "hash_c", now - 60_000, now - 300_000, "legacy_push_hash"],
    );
    await runSql(
      env.DB,
      `INSERT INTO devices (id, user_id, name, platform, token_hash, secret, token_version, last_seen_at, created_at, push_token_hash, push_revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, ?)`,
      [deviceDId, adminUserId, "Device Revoked", "other", "hash_d", now - 60_000, now - 300_000, "revoked_push_hash", now - 50_000],
    );

    const groupRes = await expectStatus(
      await call("/api/v1/device-groups", jsonInit({ name: "Ext Group" }), adminCookie),
      200,
    );
    groupId = (groupRes.group as { id: string }).id;
  });

  it("rejects device creation without devices:create (403)", async () => {
    const denied = await expectStatus(
      await call("/api/ext/v1/devices", jsonInit({ name: "Nope" }), undefined, readToken),
      403,
    );
    expect((denied.error as { code: string }).code).toBe("PERMISSION_DENIED");

    const deniedPushOnly = await expectStatus(
      await call("/api/ext/v1/devices", jsonInit({ name: "Nope" }), undefined, pushScopedToken),
      403,
    );
    expect((deniedPushOnly.error as { code: string }).code).toBe("PERMISSION_DENIED");
  });

  it("creates a device with devices:create and returns the full push_url", async () => {
    const res = await expectStatus(
      await call("/api/ext/v1/devices", jsonInit({ name: "Ext Phone", platform: "android" }), undefined, createToken),
      200,
    );
    const data = res.data as {
      device: { id: string; name: string; platform: string; group_id: string | null };
      push_url: string;
      token: string;
    };
    expect(data.device.name).toBe("Ext Phone");
    expect(data.device.platform).toBe("android");
    expect(data.device.group_id).toBeNull();
    expect(data.push_url).toMatch(/^http:\/\/smsinbox\.test\/api\/v1\/ingest\/[0-9a-f]{32}$/);
    expect(typeof data.token).toBe("string");
    expect(data.token.length).toBeGreaterThan(10);
    createdDeviceId = data.device.id;
    createdPushUrl = data.push_url;

    // `type` works as an alias for `platform`, like the payload field name.
    const alias = await expectStatus(
      await call("/api/ext/v1/devices", jsonInit({ name: "Type Alias", type: "ios" }), undefined, fullToken),
      200,
    );
    expect((alias.data as { device: { platform: string } }).device.platform).toBe("ios");
  });

  it("validates the create body with the console rules", async () => {
    const emptyName = await expectStatus(
      await call("/api/ext/v1/devices", jsonInit({ name: "  " }), undefined, fullToken),
      400,
    );
    expect((emptyName.error as { code: string }).code).toBe("BAD_REQUEST");

    const longName = await expectStatus(
      await call("/api/ext/v1/devices", jsonInit({ name: "x".repeat(65) }), undefined, fullToken),
      400,
    );
    expect((longName.error as { code: string }).code).toBe("BAD_REQUEST");

    const badGroup = await expectStatus(
      await call(
        "/api/ext/v1/devices",
        jsonInit({ name: "Grouped", group_id: "99999999-9999-4999-8999-999999999999" }),
        undefined,
        fullToken,
      ),
      400,
    );
    expect((badGroup.error as { code: string }).code).toBe("BAD_REQUEST");
  });

  it("creates into a group when group_id is given", async () => {
    const res = await expectStatus(
      await call("/api/ext/v1/devices", jsonInit({ name: "Grouped Phone", group_id: groupId }), undefined, createToken),
      200,
    );
    expect((res.data as { device: { group_id: string | null } }).device.group_id).toBe(groupId);
  });

  it("serves the stored push_url to devices:push and hides out-of-scope devices", async () => {
    const got = await expectStatus(
      await call(`/api/ext/v1/devices/${createdDeviceId}/push-url`, {}, undefined, fullToken),
      200,
    );
    expect((got.data as { push_url: string }).push_url).toBe(createdPushUrl);

    const denied = await expectStatus(
      await call(`/api/ext/v1/devices/${createdDeviceId}/push-url`, {}, undefined, createToken),
      403,
    );
    expect((denied.error as { code: string }).code).toBe("PERMISSION_DENIED");

    // In-scope device that never had a link: state error, not a 404.
    const none = await expectStatus(
      await call(`/api/ext/v1/devices/${deviceAId}/push-url`, {}, undefined, pushScopedToken),
      409,
    );
    expect((none.error as { code: string }).code).toBe("PUSH_NOT_ISSUED");

    // Out-of-scope and nonexistent devices are indistinguishable.
    const outOfScope = await call(`/api/ext/v1/devices/${deviceBId}/push-url`, {}, undefined, pushScopedToken);
    expect(outOfScope.status).toBe(404);
    const missing = await call(
      "/api/ext/v1/devices/99999999-9999-4999-8999-999999999999/push-url",
      {},
      undefined,
      pushScopedToken,
    );
    expect(missing.status).toBe(404);
  });

  it("reports legacy devices whose push secret was never stored", async () => {
    const res = await expectStatus(
      await call(`/api/ext/v1/devices/${deviceCId}/push-url`, {}, undefined, fullToken),
      409,
    );
    expect((res.error as { code: string }).code).toBe("PUSH_URL_NOT_STORED");
  });

  it("rotates: the new URL replaces the old one and the old ingest token dies", async () => {
    const denied = await expectStatus(
      await call(`/api/ext/v1/devices/${createdDeviceId}/push-url/rotate`, jsonInit({}), undefined, createToken),
      403,
    );
    expect((denied.error as { code: string }).code).toBe("PERMISSION_DENIED");

    const outOfScope = await call(
      `/api/ext/v1/devices/${deviceBId}/push-url/rotate`,
      jsonInit({}),
      undefined,
      pushScopedToken,
    );
    expect(outOfScope.status).toBe(404);

    const noPush = await expectStatus(
      await call(`/api/ext/v1/devices/${deviceAId}/push-url/rotate`, jsonInit({}), undefined, fullToken),
      409,
    );
    expect((noPush.error as { code: string }).code).toBe("PUSH_NOT_ISSUED");

    const oldToken = pushTokenOf(createdPushUrl);
    const rotated = await expectStatus(
      await call(`/api/ext/v1/devices/${createdDeviceId}/push-url/rotate`, jsonInit({}), undefined, fullToken),
      200,
    );
    const newPushUrl = (rotated.data as { push_url: string }).push_url;
    expect(newPushUrl).not.toBe(createdPushUrl);
    expect(pushTokenOf(newPushUrl)).not.toBe(oldToken);

    const got = await expectStatus(
      await call(`/api/ext/v1/devices/${createdDeviceId}/push-url`, {}, undefined, fullToken),
      200,
    );
    expect((got.data as { push_url: string }).push_url).toBe(newPushUrl);

    const oldIngest = await call(`/api/v1/ingest/${oldToken}`, jsonInit({ from: "10086", content: "您的验证码是 123456" }));
    expect(oldIngest.status).toBe(401);
    const newIngest = await call(
      `/api/v1/ingest/${pushTokenOf(newPushUrl)}`,
      jsonInit({ from: "10086", content: "您的验证码是 123456" }),
    );
    expect(newIngest.status).toBe(200);
    createdPushUrl = newPushUrl;
  });

  it("revoked devices report PUSH_REVOKED and rotation revives them", async () => {
    const revoked = await expectStatus(
      await call(`/api/ext/v1/devices/${deviceDId}/push-url`, {}, undefined, fullToken),
      409,
    );
    expect((revoked.error as { code: string }).code).toBe("PUSH_REVOKED");

    const rotated = await expectStatus(
      await call(`/api/ext/v1/devices/${deviceDId}/push-url/rotate`, jsonInit({}), undefined, fullToken),
      200,
    );
    const newPushUrl = (rotated.data as { push_url: string }).push_url;
    const got = await expectStatus(
      await call(`/api/ext/v1/devices/${deviceDId}/push-url`, {}, undefined, fullToken),
      200,
    );
    expect((got.data as { push_url: string }).push_url).toBe(newPushUrl);
  });

  it("scope-limited tokens may create, but the new device stays out of their scope", async () => {
    const created = await expectStatus(
      await call("/api/ext/v1/devices", jsonInit({ name: "Scoped Created" }), undefined, createPushScopedToken),
      200,
    );
    const data = created.data as { device: { id: string }; push_url: string };
    expect(data.push_url).toContain("/api/v1/ingest/");

    const got = await call(`/api/ext/v1/devices/${data.device.id}/push-url`, {}, undefined, createPushScopedToken);
    expect(got.status).toBe(404);
    const rotated = await call(
      `/api/ext/v1/devices/${data.device.id}/push-url/rotate`,
      jsonInit({}),
      undefined,
      createPushScopedToken,
    );
    expect(rotated.status).toBe(404);
  });

  it("denies the MCP management tools without their permissions", async () => {
    const createDenied = await mcpCall(readToken, "create_device", { name: "Nope" });
    expect(createDenied.isError).toBe(true);
    expect(createDenied.content[0]?.text).toContain("devices:create");

    const pushDenied = await mcpCall(createToken, "get_device_push_url", { id: createdDeviceId });
    expect(pushDenied.isError).toBe(true);
    expect(pushDenied.content[0]?.text).toContain("devices:push");
  });

  it("creates and rotates through the MCP tools, mirroring REST", async () => {
    const created = await mcpCall(fullToken, "create_device", { name: "MCP Phone", platform: "android" });
    expect(created.isError).toBeFalsy();
    const mcpDeviceId = created.structuredContent?.device?.id ?? "";
    const mcpPushUrl = created.structuredContent?.push_url ?? "";
    expect(mcpDeviceId).toBeTruthy();
    expect(mcpPushUrl).toMatch(/\/api\/v1\/ingest\/[0-9a-f]{32}$/);
    expect(created.content[0]?.text).toContain(mcpPushUrl);

    const got = await mcpCall(fullToken, "get_device_push_url", { id: mcpDeviceId });
    expect(got.isError).toBeFalsy();
    expect(got.structuredContent?.push_url).toBe(mcpPushUrl);

    const rotated = await mcpCall(fullToken, "rotate_device_push_url", { id: mcpDeviceId });
    expect(rotated.isError).toBeFalsy();
    expect(rotated.structuredContent?.push_url).toBeTruthy();
    expect(rotated.structuredContent?.push_url).not.toBe(mcpPushUrl);
  });

  it("keeps MCP push tools inside the token scope", async () => {
    const got = await mcpCall(pushScopedToken, "get_device_push_url", { id: deviceBId });
    expect(got.isError).toBe(true);

    const rotated = await mcpCall(pushScopedToken, "rotate_device_push_url", { id: deviceBId });
    expect(rotated.isError).toBe(true);

    // The legacy in-scope device surfaces the not-stored state, not the URL.
    const legacy = await mcpCall(fullToken, "get_device_push_url", { id: deviceCId });
    expect(legacy.isError).toBe(true);
    expect(legacy.content[0]?.text).toContain("未保存明文");
  });
});
