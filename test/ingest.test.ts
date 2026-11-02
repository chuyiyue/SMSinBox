import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64Url, sha256Hex, signHmacHex } from "../src/auth";
import {
  deleteDevice,
  deleteUserCascade,
  findDeviceByPushTokenHash,
  findDeviceByTokenHash,
  insertDevice,
  listDevices,
  replaceDevicePushToken,
  revokeDevicePush,
} from "../src/db";
import { ENCRYPTED_PREFIX } from "../src/crypto";
import { MAX_BODY_BYTES } from "../src/http";
import worker from "../src/index";
import { handleApi } from "../src/routes/api";
import { handleSms } from "../src/routes/sms";

const NOW = 1_700_000_000_000;
const USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DEVICE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOKEN = "sms_bearer_token_for_tests_0001";

type DeviceRow = {
  id: string;
  user_id: string;
  name: string;
  platform: string | null;
  token_hash: string;
  secret: string | null;
  token_version: number;
  last_seen_at: number | null;
  created_at: number;
  push_token_hash: string | null;
  push_revoked_at: number | null;
};

type MessageRow = {
  id: string;
  device_id: string;
  from_number: string;
  to_number: string;
  content: string;
  content_hash: string;
  code: string | null;
  raw_payload: string;
  received_at: number;
  created_at: number;
  encrypted: number;
};

type UserRow = {
  id: string;
  username: string;
  role: string;
  disabled_at: number | null;
};

type SessionRow = {
  id: string;
  user_id: string;
  expires_at: number;
};

type State = {
  devices: DeviceRow[];
  messages: MessageRow[];
  rates: Map<string, number>;
  users: UserRow[];
  sessions: SessionRow[];
  pushLookups: number;
  throwOnPushLookup: boolean;
};

function rateHash(key: string): string {
  return key.slice(0, key.lastIndexOf(":"));
}

function createDb() {
  const state: State = {
    devices: [],
    messages: [],
    rates: new Map(),
    users: [],
    sessions: [],
    pushLookups: 0,
    throwOnPushLookup: false,
  };
  function dropRates(match: (hash: string) => boolean): number {
    let removed = 0;
    for (const key of state.rates.keys()) {
      if (!match(rateHash(key))) continue;
      state.rates.delete(key);
      removed += 1;
    }
    return removed;
  }
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        bind(...bound: unknown[]) {
          args = bound;
          return statement;
        },
        async first() {
          if (sql.includes("INSERT INTO rate_limits")) {
            const key = `${String(args[0])}:${String(args[1])}`;
            const count = (state.rates.get(key) ?? 0) + 1;
            state.rates.set(key, count);
            return { count };
          }
          if (sql.includes("FROM sessions")) {
            const session = state.sessions.find((row) => row.id === args[0]);
            const user = session ? state.users.find((row) => row.id === session.user_id) : undefined;
            if (!session || !user) return null;
            return {
              id: user.id,
              username: user.username,
              role: user.role,
              disabled_at: user.disabled_at,
              expires_at: session.expires_at,
            };
          }
          if (sql.includes("COUNT(*)") && sql.includes("FROM devices")) {
            return { total: state.devices.filter((device) => device.user_id === args[0]).length };
          }
          if (sql.includes("FROM devices") && sql.includes("push_token_hash = ?")) {
            state.pushLookups += 1;
            if (state.throwOnPushLookup) throw new Error("d1 exploded");
            return state.devices.find((device) => device.push_token_hash === args[0]) ?? null;
          }
          if (sql.includes("SELECT id, token_hash, push_token_hash")) {
            const device = state.devices.find((row) => row.id === args[0] && row.user_id === args[1]);
            return device
              ? { id: device.id, token_hash: device.token_hash, push_token_hash: device.push_token_hash }
              : null;
          }
          if (sql.includes("SELECT id, name, push_token_hash, push_revoked_at")) {
            const device = state.devices.find((row) => row.id === args[0] && row.user_id === args[1]);
            return device
              ? {
                  id: device.id,
                  name: device.name,
                  push_token_hash: device.push_token_hash,
                  push_revoked_at: device.push_revoked_at,
                }
              : null;
          }
          if (sql.includes("SELECT id, name FROM devices")) {
            const device = state.devices.find((row) => row.id === args[0] && row.user_id === args[1]);
            return device ? { id: device.id, name: device.name } : null;
          }
          if (sql.trim().endsWith("WHERE id = ?")) {
            return state.devices.find((device) => device.id === args[0]) ?? null;
          }
          if (sql.includes("FROM devices") && sql.includes("WHERE token_hash = ?")) {
            return state.devices.find((device) => device.token_hash === args[0]) ?? null;
          }
          if (sql.includes("FROM messages") && sql.includes("content_hash = ?")) {
            const row = state.messages.find((message) => message.content_hash === args[0]);
            return row ? { id: row.id, code: row.code, encrypted: row.encrypted } : null;
          }
          throw new Error(`unhandled first: ${sql}`);
        },
        async all() {
          if (sql.includes("FROM notify_channels")) return { results: [] };
          if (sql.includes("FROM devices") && sql.includes("user_id = ?")) {
            return {
              results: state.devices
                .filter((device) => device.user_id === args[0])
                .sort((left, right) => right.created_at - left.created_at)
                .map((device) => ({
                  id: device.id,
                  name: device.name,
                  platform: device.platform,
                  created_at: device.created_at,
                  last_seen_at: device.last_seen_at,
                  secret: device.secret,
                  push_token_hash: device.push_token_hash,
                  push_revoked_at: device.push_revoked_at,
                })),
            };
          }
          throw new Error(`unhandled all: ${sql}`);
        },
        async run() {
          if (sql.includes("INSERT INTO messages")) {
            state.messages.push({
              id: String(args[0]),
              device_id: String(args[1]),
              from_number: String(args[2]),
              to_number: String(args[3]),
              content: String(args[4]),
              content_hash: String(args[5]),
              code: args[6] == null ? null : String(args[6]),
              raw_payload: String(args[7]),
              received_at: Number(args[8]),
              created_at: Number(args[9]),
              encrypted: Number(args[10]),
            });
            return { meta: { changes: 1 } };
          }
          if (sql.includes("INSERT INTO devices")) {
            state.devices.push({
              id: String(args[0]),
              user_id: String(args[1]),
              name: String(args[2]),
              platform: args[3] == null ? null : String(args[3]),
              token_hash: String(args[4]),
              secret: args[5] == null ? null : String(args[5]),
              token_version: Number(args[6]),
              last_seen_at: null,
              created_at: Number(args[7]),
              push_token_hash: args[8] == null ? null : String(args[8]),
              push_revoked_at: null,
            });
            return { meta: { changes: 1 } };
          }
          if (sql.includes("SET last_seen_at")) {
            const device = state.devices.find((row) => row.id === args[1]);
            if (device) device.last_seen_at = Number(args[0]);
            return { meta: { changes: device ? 1 : 0 } };
          }
          if (sql.includes("SET push_token_hash = ?")) {
            const device = state.devices.find((row) => row.id === args[1] && row.user_id === args[2]);
            const issue = sql.includes("push_token_hash IS NULL OR push_revoked_at IS NOT NULL");
            const allowed =
              device != null &&
              (issue
                ? device.push_token_hash == null || device.push_revoked_at != null
                : device.push_token_hash != null);
            if (!device || !allowed) return { meta: { changes: 0 } };
            device.push_token_hash = String(args[0]);
            device.push_revoked_at = null;
            return { meta: { changes: 1 } };
          }
          if (sql.includes("SET push_revoked_at = ?")) {
            const device = state.devices.find((row) => row.id === args[1] && row.user_id === args[2]);
            if (!device || device.push_token_hash == null || device.push_revoked_at != null) {
              return { meta: { changes: 0 } };
            }
            device.push_revoked_at = Number(args[0]);
            return { meta: { changes: 1 } };
          }
          if (sql.includes("DELETE FROM messages") && sql.includes("device_id = ?")) {
            const before = state.messages.length;
            state.messages = state.messages.filter((message) => message.device_id !== args[0]);
            return { meta: { changes: before - state.messages.length } };
          }
          if (sql.includes("DELETE FROM messages") && sql.includes("device_id IN")) {
            const ids = new Set(
              state.devices.filter((device) => device.user_id === args[0]).map((device) => device.id),
            );
            const before = state.messages.length;
            state.messages = state.messages.filter((message) => !ids.has(message.device_id));
            return { meta: { changes: before - state.messages.length } };
          }
          if (sql.includes("DELETE FROM rate_limits") && sql.includes("OR token_hash = ?")) {
            const push = args[1] == null ? null : String(args[1]);
            return { meta: { changes: dropRates((hash) => hash === args[0] || hash === push) } };
          }
          if (sql.includes("DELETE FROM rate_limits") && sql.includes("SELECT push_token_hash")) {
            const hashes = new Set(
              state.devices
                .filter((device) => device.user_id === args[0] && device.push_token_hash)
                .map((device) => device.push_token_hash),
            );
            return { meta: { changes: dropRates((hash) => hashes.has(hash)) } };
          }
          if (sql.includes("DELETE FROM rate_limits") && sql.includes("SELECT token_hash")) {
            const hashes = new Set(
              state.devices.filter((device) => device.user_id === args[0]).map((device) => device.token_hash),
            );
            return { meta: { changes: dropRates((hash) => hashes.has(hash)) } };
          }
          if (sql.includes("DELETE FROM devices") && sql.includes("id = ? AND user_id = ?")) {
            const before = state.devices.length;
            state.devices = state.devices.filter((device) => !(device.id === args[0] && device.user_id === args[1]));
            return { meta: { changes: before - state.devices.length } };
          }
          if (sql.includes("DELETE FROM devices") && sql.includes("user_id = ?")) {
            const before = state.devices.length;
            state.devices = state.devices.filter((device) => device.user_id !== args[0]);
            return { meta: { changes: before - state.devices.length } };
          }
          if (
            sql.includes("DELETE FROM sessions") ||
            sql.includes("DELETE FROM notify_channels") ||
            sql.includes("DELETE FROM users")
          ) {
            return { meta: { changes: 0 } };
          }
          throw new Error(`unhandled run: ${sql}`);
        },
      };
      return statement;
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      for (const statement of statements) await statement.run();
    },
  };
  return { db: db as unknown as D1Database, state };
}

function envFor(db: D1Database, contentKey = ""): Env {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response("") },
    RETENTION_DAYS: "90",
    CONTENT_KEY: contentKey,
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "secret",
    DEVICE_JWT_SECRET: "ingest-device-jwt-secret-00000001",
  } as unknown as Env;
}

const SESSION = "sms_session_token_value_for_push";

function workerEntry() {
  return worker as {
    fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
  };
}

async function seedSession(state: State): Promise<void> {
  state.users.push({ id: USER_ID, username: "ada", role: "admin", disabled_at: null });
  state.sessions.push({ id: await sha256Hex(SESSION), user_id: USER_ID, expires_at: NOW + 60_000 });
}

function authed(path: string, method = "GET", body?: unknown): Request {
  return new Request(`https://sms.example${path}`, {
    method,
    headers: {
      cookie: `smsinbox_session=${SESSION}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function waitCtx() {
  const jobs: Promise<unknown>[] = [];
  return {
    jobs,
    ctx: {
      waitUntil(job: Promise<unknown>) {
        jobs.push(job);
      },
    },
  };
}

function smsBody(content: string, from = "10086"): string {
  return JSON.stringify({ from, content, timestamp: NOW, device: "pixel" });
}

function smsRequest(token: string | null, body: string, headers?: HeadersInit): Request {
  const requestHeaders = new Headers(headers);
  if (!requestHeaders.has("content-type")) requestHeaders.set("content-type", "application/json");
  if (token) requestHeaders.set("authorization", `Bearer ${token}`);
  return new Request("https://sms.example/api/v1/sms", {
    method: "POST",
    headers: requestHeaders,
    body,
  });
}

async function seedDevice(state: State, token: string, secret: string | null = null): Promise<void> {
  state.devices.push({
    id: DEVICE_ID,
    user_id: USER_ID,
    name: "pixel",
    platform: "other",
    token_hash: await sha256Hex(token),
    secret,
    token_version: 0,
    last_seen_at: null,
    created_at: NOW,
    push_token_hash: null,
    push_revoked_at: null,
  });
}

describe("handleSms bearer", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects a missing or malformed bearer before touching the database", async () => {
    const harness = createDb();
    await seedDevice(harness.state, TOKEN);
    const missing = await handleSms(smsRequest(null, smsBody("验证码 123456")), envFor(harness.db), waitCtx().ctx);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ ok: false, error: "缺少设备 token" });

    const malformed = await handleSms(
      smsRequest(null, smsBody("验证码 123456"), { authorization: "Bearer short" }),
      envFor(harness.db),
      waitCtx().ctx,
    );
    expect(malformed.status).toBe(401);
    expect(await malformed.json()).toEqual({ ok: false, error: "缺少设备 token" });
    expect(harness.state.messages).toHaveLength(0);
    expect(harness.state.rates.size).toBe(0);
  });

  it("rejects an unknown bearer and a push-shaped token", async () => {
    const harness = createDb();
    await seedDevice(harness.state, TOKEN);
    const unknown = await handleSms(
      smsRequest("sms_this_token_is_not_the_device", smsBody("验证码 123456")),
      envFor(harness.db),
      waitCtx().ctx,
    );
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual({ ok: false, error: "设备 token 无效" });

    const pushShaped = await handleSms(
      smsRequest("psh_not_a_bearer_token_value_01", smsBody("验证码 123456")),
      envFor(harness.db),
      waitCtx().ctx,
    );
    expect(pushShaped.status).toBe(401);
    expect(await pushShaped.json()).toEqual({ ok: false, error: "设备 token 无效" });
    expect(harness.state.messages).toHaveLength(0);
  });

  it("stores a message and returns ok, id, and the extracted code", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line) => {
      logs.push(String(line));
    });
    const harness = createDb();
    await seedDevice(harness.state, TOKEN);
    const pending = waitCtx();
    const response = await handleSms(
      smsRequest(TOKEN, smsBody("您的验证码 123456，请勿泄露")),
      envFor(harness.db),
      pending.ctx,
    );
    await Promise.all(pending.jobs);
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; id: string; code: string; duplicate?: boolean };
    expect(body.ok).toBe(true);
    expect(body.code).toBe("123456");
    expect(body.duplicate).toBeUndefined();
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(harness.state.messages).toHaveLength(1);
    expect(harness.state.messages[0]).toMatchObject({
      device_id: DEVICE_ID,
      from_number: "10086",
      content: "您的验证码 123456，请勿泄露",
      code: "123456",
      encrypted: 0,
    });
    expect(harness.state.devices[0]?.last_seen_at).toBe(NOW);
    expect(pending.jobs).toHaveLength(1);
    expect(logs.join("")).toContain("sms_stored");
    expect(logs.join("")).not.toContain(TOKEN);
    expect(logs.join("")).not.toContain("123456");
  });

  it("keeps the HMAC rules for devices with and without a secret", async () => {
    const plain = createDb();
    await seedDevice(plain.state, TOKEN, null);
    const unsigned = await handleSms(
      smsRequest(TOKEN, smsBody("验证码 123456"), { "x-signature": "aa", "x-timestamp": String(NOW) }),
      envFor(plain.db),
      waitCtx().ctx,
    );
    expect(unsigned.status).toBe(401);
    expect(await unsigned.json()).toEqual({ ok: false, error: "该设备未启用签名" });
    expect(plain.state.rates.size).toBe(0);

    const secret = "hmac-secret-value";
    const signed = createDb();
    await seedDevice(signed.state, TOKEN, secret);
    const body = smsBody("验证码 654321");
    const missing = await handleSms(smsRequest(TOKEN, body), envFor(signed.db), waitCtx().ctx);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ ok: false, error: "该设备要求 HMAC 签名" });

    const stale = String(NOW - 10 * 60 * 1000);
    const staleSignature = await signHmacHex(secret, stale, new TextEncoder().encode(body));
    const expired = await handleSms(
      smsRequest(TOKEN, body, { "x-timestamp": stale, "x-signature": staleSignature }),
      envFor(signed.db),
      waitCtx().ctx,
    );
    expect(expired.status).toBe(401);
    expect(await expired.json()).toEqual({ ok: false, error: "签名无效" });

    const bad = await handleSms(
      smsRequest(TOKEN, body, { "x-timestamp": String(NOW), "x-signature": "ab".repeat(32) }),
      envFor(signed.db),
      waitCtx().ctx,
    );
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ ok: false, error: "签名无效" });
    expect(signed.state.messages).toHaveLength(0);

    const signature = await signHmacHex(secret, String(NOW), new TextEncoder().encode(body));
    const accepted = await handleSms(
      smsRequest(TOKEN, body, { "x-timestamp": String(NOW), "x-signature": signature }),
      envFor(signed.db),
      waitCtx().ctx,
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ ok: true, code: "654321" });
    expect(signed.state.messages).toHaveLength(1);
  });

  it("returns the existing id when the same bucket is reported again", async () => {
    const harness = createDb();
    await seedDevice(harness.state, TOKEN);
    const body = smsBody("验证码 123456");
    const pending = waitCtx();
    const first = await handleSms(smsRequest(TOKEN, body), envFor(harness.db), pending.ctx);
    const created = await first.json() as { id: string; code: string };
    const again = waitCtx();
    const second = await handleSms(smsRequest(TOKEN, body), envFor(harness.db), again.ctx);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, id: created.id, code: created.code, duplicate: true });
    expect(harness.state.messages).toHaveLength(1);
    expect(again.jobs).toHaveLength(0);
    expect(pending.jobs).toHaveLength(1);
  });

  it("returns 429 after 60 requests in the same minute", async () => {
    const harness = createDb();
    await seedDevice(harness.state, TOKEN);
    for (let index = 0; index < 60; index += 1) {
      const response = await handleSms(
        smsRequest(TOKEN, smsBody(`验证码 ${100000 + index}`)),
        envFor(harness.db),
        waitCtx().ctx,
      );
      expect(response.status).toBe(200);
    }
    const limited = await handleSms(
      smsRequest(TOKEN, smsBody("验证码 999999")),
      envFor(harness.db),
      waitCtx().ctx,
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await limited.json()).toEqual({ ok: false, error: "请求过于频繁" });
    expect(harness.state.messages).toHaveLength(60);
  });

  it("rejects an oversized body before looking up a device", async () => {
    const harness = createDb();
    await seedDevice(harness.state, TOKEN);
    const response = await handleSms(
      smsRequest(TOKEN, "x".repeat(MAX_BODY_BYTES + 1)),
      envFor(harness.db),
      waitCtx().ctx,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ ok: false, error: "请求体过大" });
    expect(harness.state.messages).toHaveLength(0);
    expect(harness.state.rates.size).toBe(0);
  });
});

describe("sms route", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts POST /api/v1/sms and rejects other methods", async () => {
    const harness = createDb();
    await seedDevice(harness.state, TOKEN);
    const pending = waitCtx();
    const entry = worker as {
      fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
    };
    const response = await entry.fetch(
      smsRequest(TOKEN, smsBody("验证码 123456")),
      envFor(harness.db),
      pending.ctx as ExecutionContext,
    );
    await Promise.all(pending.jobs);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, code: "123456" });

    const rejected = await entry.fetch(
      new Request("https://sms.example/api/v1/sms", { method: "GET" }),
      envFor(harness.db),
      pending.ctx as ExecutionContext,
    );
    expect(rejected.status).toBe(405);
    expect(rejected.headers.get("allow")).toBe("POST");
  });
});

describe("device push rows", () => {
  const issued = "psh_issued_token_value_000000000000000000";
  const rotated = "psh_rotated_token_value_00000000000000000";
  const otherUser = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const otherDevice = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

  async function seed(pushTokenHash: string | null = null) {
    const harness = createDb();
    await insertDevice(harness.db, {
      id: DEVICE_ID,
      userId: USER_ID,
      name: "pixel",
      tokenHash: await sha256Hex(TOKEN),
      secret: null,
      createdAt: NOW,
      pushTokenHash,
    });
    return harness;
  }

  it("lists none, active, and revoked without the hash or the secret", async () => {
    const none = await seed(null);
    expect(await listDevices(none.db, USER_ID)).toMatchObject([{ id: DEVICE_ID, push: "none", has_secret: false }]);

    const activeHash = await sha256Hex(issued);
    const active = await seed(activeHash);
    const listed = await listDevices(active.db, USER_ID);
    expect(listed[0]?.push).toBe("active");
    expect(JSON.stringify(listed)).not.toContain(issued);
    expect(JSON.stringify(listed)).not.toContain(activeHash);

    expect(await revokeDevicePush(active.db, USER_ID, DEVICE_ID, NOW)).toBe(true);
    expect((await listDevices(active.db, USER_ID))[0]?.push).toBe("revoked");
    const found = await findDeviceByPushTokenHash(active.db, activeHash);
    expect(found?.push_revoked_at).toBe(NOW);
    expect(found?.token_hash).toBe(await sha256Hex(TOKEN));
  });

  it("issues and rotates without rewriting the bearer hash", async () => {
    const harness = await seed(null);
    const bearerHash = await sha256Hex(TOKEN);
    const firstHash = await sha256Hex(issued);
    expect(await replaceDevicePushToken(harness.db, USER_ID, DEVICE_ID, firstHash, "rotate")).toBe(false);
    expect(await replaceDevicePushToken(harness.db, USER_ID, DEVICE_ID, firstHash, "issue")).toBe(true);
    expect(await replaceDevicePushToken(harness.db, USER_ID, DEVICE_ID, await sha256Hex(rotated), "issue")).toBe(false);
    expect((await findDeviceByTokenHash(harness.db, bearerHash))?.token_hash).toBe(bearerHash);
    expect((await findDeviceByPushTokenHash(harness.db, firstHash))?.id).toBe(DEVICE_ID);

    const nextHash = await sha256Hex(rotated);
    expect(await replaceDevicePushToken(harness.db, USER_ID, DEVICE_ID, nextHash, "rotate")).toBe(true);
    expect(await findDeviceByPushTokenHash(harness.db, firstHash)).toBeNull();
    expect((await findDeviceByPushTokenHash(harness.db, nextHash))?.push_revoked_at ?? null).toBeNull();
    expect((await findDeviceByTokenHash(harness.db, bearerHash))?.token_hash).toBe(bearerHash);

    expect(await revokeDevicePush(harness.db, USER_ID, DEVICE_ID, NOW)).toBe(true);
    expect(await revokeDevicePush(harness.db, USER_ID, DEVICE_ID, NOW + 1)).toBe(false);
    expect(await replaceDevicePushToken(harness.db, USER_ID, DEVICE_ID, firstHash, "issue")).toBe(true);
    expect(await findDeviceByPushTokenHash(harness.db, nextHash)).toBeNull();
    expect((await listDevices(harness.db, USER_ID))[0]?.push).toBe("active");
  });

  it("clears bearer and push rate limits when a device or its user is deleted", async () => {
    const pushHash = await sha256Hex(issued);
    const harness = await seed(pushHash);
    const bearerHash = await sha256Hex(TOKEN);
    const stranger = await sha256Hex("sms_someone_else_token_value_0001");
    harness.state.rates.set(`${bearerHash}:${NOW}`, 2);
    harness.state.rates.set(`${pushHash}:${NOW}`, 4);
    harness.state.rates.set(`${stranger}:${NOW}`, 1);
    harness.state.messages.push({
      id: "message-1",
      device_id: DEVICE_ID,
      from_number: "10086",
      to_number: "",
      content: "验证码 123456",
      content_hash: "hash-1",
      code: "123456",
      raw_payload: "{}",
      received_at: NOW,
      created_at: NOW,
      encrypted: 0,
    });

    expect(await deleteDevice(harness.db, USER_ID, DEVICE_ID)).toBe(true);
    expect(harness.state.devices).toHaveLength(0);
    expect(harness.state.messages).toHaveLength(0);
    expect(harness.state.rates.has(`${bearerHash}:${NOW}`)).toBe(false);
    expect(harness.state.rates.has(`${pushHash}:${NOW}`)).toBe(false);
    expect(harness.state.rates.has(`${stranger}:${NOW}`)).toBe(true);
    expect(await deleteDevice(harness.db, USER_ID, DEVICE_ID)).toBe(false);

    const cascade = await seed(pushHash);
    await insertDevice(cascade.db, {
      id: otherDevice,
      userId: otherUser,
      name: "other",
      tokenHash: stranger,
      secret: null,
      createdAt: NOW,
      pushTokenHash: null,
    });
    cascade.state.rates.set(`${bearerHash}:${NOW}`, 2);
    cascade.state.rates.set(`${pushHash}:${NOW}`, 4);
    cascade.state.rates.set(`${stranger}:${NOW}`, 1);
    await deleteUserCascade(cascade.db, USER_ID);
    expect(cascade.state.devices.map((device) => device.id)).toEqual([otherDevice]);
    expect(cascade.state.rates.has(`${bearerHash}:${NOW}`)).toBe(false);
    expect(cascade.state.rates.has(`${pushHash}:${NOW}`)).toBe(false);
    expect(cascade.state.rates.has(`${stranger}:${NOW}`)).toBe(true);
  });
});

describe("push ingest", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function captureLogs() {
    const info: string[] = [];
    const errors: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line) => {
      info.push(String(line));
    });
    vi.spyOn(console, "error").mockImplementation((line) => {
      errors.push(String(line));
    });
    return { info, errors };
  }

  function posted(url: string, body = smsBody("验证码 123456"), headers?: HeadersInit): Request {
    const requestHeaders = new Headers(headers);
    if (!requestHeaders.has("content-type")) requestHeaders.set("content-type", "application/json");
    return new Request(url, { method: "POST", headers: requestHeaders, body });
  }

  async function createDevice(harness: ReturnType<typeof createDb>) {
    await seedSession(harness.state);
    const response = await handleApi(
      authed("/api/v1/devices", "POST", { name: "pixel", platform: "android" }),
      envFor(harness.db),
    );
    expect(response.status).toBe(200);
    return response.json() as Promise<{
      token: string;
      token_type: string;
      token_expires_at: number;
      push_url: string;
      device: { id: string; push: string; has_secret: boolean; platform: string };
    }>;
  }

  it("returns a one-time push URL and keeps it out of later reads", async () => {
    const logs = captureLogs();
    const harness = createDb();
    const created = await createDevice(harness);
    expect(created.token.startsWith("eyJ")).toBe(true);
    expect(created.token.split(".")).toHaveLength(3);
    expect(created.token_type).toBe("Bearer");
    expect(created.token_expires_at).toBeGreaterThan(NOW);
    expect(created.push_url).toMatch(/^https:\/\/sms\.example\/api\/v1\/ingest\/psh_[A-Za-z0-9_-]{20,}$/);
    expect(created.device).toMatchObject({ push: "active", has_secret: false, platform: "android" });
    const secret = created.push_url.split("/").pop() ?? "";
    expect(harness.state.devices[0]?.push_token_hash).toBe(await sha256Hex(secret));
    expect(harness.state.devices[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(harness.state.devices[0]?.token_hash).not.toBe(await sha256Hex(created.token));
    expect(harness.state.devices[0]?.token_version).toBe(0);
    expect(JSON.stringify(harness.state.devices[0])).not.toContain(secret);
    expect(JSON.stringify(harness.state.devices[0])).not.toContain(created.token);

    const listed = await handleApi(authed("/api/v1/devices"), envFor(harness.db));
    const body = await listed.json() as { devices: Array<{ push: string }> };
    expect(body.devices[0]?.push).toBe("active");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(created.token);
    expect(serialized).not.toContain(created.push_url);
    expect(logs.info.join("")).not.toContain(secret);
    expect(logs.info.join("")).not.toContain(created.token);
  });

  it("revokes a system JWT by bumping token_version or deleting the device", async () => {
    const harness = createDb();
    const created = await createDevice(harness);
    const good = await handleSms(
      smsRequest(created.token, smsBody("验证码 111111")),
      envFor(harness.db),
      waitCtx().ctx,
    );
    expect(good.status).toBe(200);

    harness.state.devices[0]!.token_version = 1;
    const revoked = await handleSms(
      smsRequest(created.token, smsBody("验证码 222222")),
      envFor(harness.db),
      waitCtx().ctx,
    );
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toEqual({ ok: false, error: "设备 token 无效" });

    harness.state.devices[0]!.token_version = 0;
    harness.state.devices = [];
    const deleted = await handleSms(
      smsRequest(created.token, smsBody("验证码 333333")),
      envFor(harness.db),
      waitCtx().ctx,
    );
    expect(deleted.status).toBe(401);
    expect(await deleted.json()).toEqual({ ok: false, error: "设备 token 无效" });
    expect(harness.state.messages).toHaveLength(1);
  });

  it("stores through the push URL and still accepts the old bearer", async () => {
    const logs = captureLogs();
    const harness = createDb();
    const created = await createDevice(harness);
    const secret = created.push_url.split("/").pop() ?? "";
    const pending = waitCtx();
    const response = await workerEntry().fetch(
      posted(`${created.push_url}?leak=${secret}`, smsBody("您的验证码 123456")),
      envFor(harness.db),
      pending.ctx as ExecutionContext,
    );
    await Promise.all(pending.jobs);
    expect(response.status).toBe(200);
    const stored = await response.json() as { ok: boolean; id: string; code: string; duplicate?: boolean };
    expect(stored).toMatchObject({ ok: true, code: "123456" });
    expect(stored.duplicate).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(harness.state.messages).toHaveLength(1);
    expect(harness.state.messages[0]?.device_id).toBe(created.device.id);
    expect(pending.jobs).toHaveLength(1);

    const lines = [...logs.info, ...logs.errors];
    expect(lines.join("")).not.toContain(secret);
    expect(lines.join("")).not.toContain("123456");
    const requestLog = logs.info
      .map((line) => JSON.parse(line) as { message?: string; path?: string })
      .find((line) => line.message === "request");
    expect(requestLog?.path).toBe("/api/v1/ingest/:secret");

    const bearer = await workerEntry().fetch(
      smsRequest(created.token, smsBody("验证码 654321")),
      envFor(harness.db),
      waitCtx().ctx as ExecutionContext,
    );
    expect(bearer.status).toBe(200);
    const bearerLog = logs.info
      .map((line) => JSON.parse(line) as { message?: string; path?: string })
      .filter((line) => line.message === "request")
      .at(-1);
    expect(bearerLog?.path).toBe("/api/v1/sms");

    const asBearer = await handleSms(
      smsRequest(secret, smsBody("验证码 111111")),
      envFor(harness.db),
      waitCtx().ctx,
    );
    expect(asBearer.status).toBe(401);
    expect(await asBearer.json()).toEqual({ ok: false, error: "设备 token 无效" });
  });

  it("ignores Authorization, skips HMAC, and deduplicates with the bearer path", async () => {
    const harness = createDb();
    const created = await createDevice(harness);
    const other = await handleApi(authed("/api/v1/devices", "POST", { name: "other" }), envFor(harness.db));
    const second = await other.json() as { token: string; device: { id: string } };
    const body = smsBody("验证码 123456");
    const pending = waitCtx();
    const ingested = await workerEntry().fetch(
      posted(created.push_url, body, { authorization: `Bearer ${second.token}` }),
      envFor(harness.db),
      pending.ctx as ExecutionContext,
    );
    expect(ingested.status).toBe(200);
    expect(harness.state.messages[0]?.device_id).toBe(created.device.id);
    expect(harness.state.messages[0]?.device_id).not.toBe(second.device.id);

    const duplicate = await workerEntry().fetch(
      posted(created.push_url, body),
      envFor(harness.db),
      waitCtx().ctx as ExecutionContext,
    );
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ duplicate: true, code: "123456" });
    expect(harness.state.messages).toHaveLength(1);

    // New devices use the system JWT and never sign, so the bearer door needs
    // no X-Signature. The HMAC path is covered for legacy rows below.
    const unsigned = await handleSms(smsRequest(created.token, smsBody("验证码 222222")), envFor(harness.db), waitCtx().ctx);
    expect(unsigned.status).toBe(200);
    expect(await unsigned.json()).toMatchObject({ ok: true, code: "222222" });

    const crossSite = await workerEntry().fetch(
      posted(created.push_url, smsBody("验证码 333333"), {
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      }),
      envFor(harness.db),
      waitCtx().ctx as ExecutionContext,
    );
    expect(crossSite.status).toBe(200);
  });

  it("rejects a bad, unknown, or revoked secret and does not hash a malformed path", async () => {
    const logs = captureLogs();
    const harness = createDb();
    const created = await createDevice(harness);
    const secret = created.push_url.split("/").pop() ?? "";
    harness.state.throwOnPushLookup = true;

    const malformed = [
      `https://sms.example/api/v1/ingest/${"psh_" + "a".repeat(300)}`,
      "https://sms.example/api/v1/ingest/psh_short",
      `https://sms.example/api/v1/ingest/psh_${"a".repeat(12)}+bad`,
      `https://sms.example/api/v1/ingest/${"a".repeat(32)}`,
      `https://sms.example/api/v1/ingest/${secret}/extra`,
    ];
    for (const url of malformed) {
      const response = await workerEntry().fetch(posted(url), envFor(harness.db), waitCtx().ctx as ExecutionContext);
      expect(response.status).toBe(401);
      const payload = await response.json() as { ok: boolean; error: string };
      expect(payload).toEqual({ ok: false, error: "推送链接无效" });
      expect(JSON.stringify(payload)).not.toContain(secret);
    }
    expect(harness.state.pushLookups).toBe(0);
    expect(logs.info.join("") + logs.errors.join("")).not.toContain(secret);

    harness.state.throwOnPushLookup = false;
    const unknown = await workerEntry().fetch(
      posted(`https://sms.example/api/v1/ingest/psh_${"b".repeat(32)}`),
      envFor(harness.db),
      waitCtx().ctx as ExecutionContext,
    );
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual({ ok: false, error: "推送链接无效" });
    expect(harness.state.pushLookups).toBe(1);

    const revoked = await handleApi(
      authed(`/api/v1/devices/${created.device.id}/push`, "POST", { action: "revoke" }),
      envFor(harness.db),
    );
    expect(revoked.status).toBe(200);
    const revokedBody = await revoked.json() as { push_url?: string; device: { push: string } };
    expect(revokedBody.push_url).toBeUndefined();
    expect(revokedBody.device.push).toBe("revoked");
    const rejected = await workerEntry().fetch(posted(created.push_url), envFor(harness.db), waitCtx().ctx as ExecutionContext);
    expect(rejected.status).toBe(401);
    const rejectedBody = await rejected.json() as { error: string };
    expect(rejectedBody).toEqual({ ok: false, error: "推送链接已撤销" });
    expect(JSON.stringify(rejectedBody)).not.toContain(secret);

    const bearer = await handleSms(smsRequest(created.token, smsBody("验证码 123456")), envFor(harness.db), waitCtx().ctx);
    expect(bearer.status).toBe(200);
  });

  it("rotates and issues without deleting messages, and refuses the wrong state", async () => {
    const harness = createDb();
    const created = await createDevice(harness);
    const oldSecret = created.push_url.split("/").pop() ?? "";
    await workerEntry().fetch(posted(created.push_url), envFor(harness.db), waitCtx().ctx as ExecutionContext);
    expect(harness.state.messages).toHaveLength(1);

    const activeIssue = await handleApi(
      authed(`/api/v1/devices/${created.device.id}/push`, "POST", { action: "issue" }),
      envFor(harness.db),
    );
    expect(activeIssue.status).toBe(409);
    expect(await activeIssue.json()).toMatchObject({ error: "推送链接仍有效，请改用轮换" });
    const still = await workerEntry().fetch(posted(created.push_url, smsBody("验证码 222222")), envFor(harness.db), waitCtx().ctx as ExecutionContext);
    expect(still.status).toBe(200);

    const rotated = await handleApi(
      authed(`/api/v1/devices/${created.device.id}/push`, "POST", { action: "rotate" }),
      envFor(harness.db),
    );
    expect(rotated.status).toBe(200);
    const next = await rotated.json() as { push_url: string; token?: string; device: { push: string } };
    expect(next.token).toBeUndefined();
    expect(next.device.push).toBe("active");
    expect(next.push_url).not.toBe(created.push_url);
    expect(harness.state.messages).toHaveLength(2);
    // Push rotation never rewrites the bearer credential.
    expect(harness.state.devices[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(harness.state.devices[0]?.token_version).toBe(0);

    const retired = await workerEntry().fetch(posted(created.push_url), envFor(harness.db), waitCtx().ctx as ExecutionContext);
    expect(retired.status).toBe(401);
    expect(await retired.json()).toEqual({ ok: false, error: "推送链接无效" });
    const fresh = await workerEntry().fetch(posted(next.push_url, smsBody("验证码 333333")), envFor(harness.db), waitCtx().ctx as ExecutionContext);
    expect(fresh.status).toBe(200);

    await handleApi(authed(`/api/v1/devices/${created.device.id}/push`, "POST", { action: "revoke" }), envFor(harness.db));
    const issued = await handleApi(
      authed(`/api/v1/devices/${created.device.id}/push`, "POST", { action: "issue" }),
      envFor(harness.db),
    );
    expect(issued.status).toBe(200);
    const reissued = await issued.json() as { push_url: string };
    const oldRevokedUrl = await workerEntry().fetch(posted(next.push_url), envFor(harness.db), waitCtx().ctx as ExecutionContext);
    expect(oldRevokedUrl.status).toBe(401);
    expect(await oldRevokedUrl.json()).toEqual({ ok: false, error: "推送链接无效" });
    expect((await workerEntry().fetch(posted(reissued.push_url, smsBody("验证码 444444")), envFor(harness.db), waitCtx().ctx as ExecutionContext)).status).toBe(200);

    const again = await handleApi(
      authed(`/api/v1/devices/${created.device.id}/push`, "POST", { action: "revoke" }),
      envFor(harness.db),
    );
    expect(again.status).toBe(200);
    const twice = await handleApi(
      authed(`/api/v1/devices/${created.device.id}/push`, "POST", { action: "revoke" }),
      envFor(harness.db),
    );
    expect(twice.status).toBe(409);

    await insertDevice(harness.db, {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      userId: USER_ID,
      name: "blank",
      tokenHash: await sha256Hex("sms_blank_device_token_value_0001"),
      secret: null,
      createdAt: NOW,
      pushTokenHash: null,
    });
    const rotateBlank = await handleApi(
      authed("/api/v1/devices/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/push", "POST", { action: "rotate" }),
      envFor(harness.db),
    );
    expect(rotateBlank.status).toBe(409);
    expect(await rotateBlank.json()).toMatchObject({ error: "还没有推送链接" });
    const revokeBlank = await handleApi(
      authed("/api/v1/devices/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/push", "POST", { action: "revoke" }),
      envFor(harness.db),
    );
    expect(revokeBlank.status).toBe(409);

    const missing = await handleApi(
      authed("/api/v1/devices/ffffffff-ffff-4fff-8fff-ffffffffffff/push", "POST", { action: "issue" }),
      envFor(harness.db),
    );
    expect(missing.status).toBe(404);
    const badAction = await handleApi(
      authed(`/api/v1/devices/${created.device.id}/push`, "POST", { action: "show" }),
      envFor(harness.db),
    );
    expect(badAction.status).toBe(400);
    const anonymous = await handleApi(
      new Request(`https://sms.example/api/v1/devices/${created.device.id}/push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "rotate" }),
      }),
      envFor(harness.db),
    );
    expect(anonymous.status).toBe(401);
    const cross = await handleApi(
      new Request(`https://sms.example/api/v1/devices/${created.device.id}/push`, {
        method: "POST",
        headers: {
          cookie: `smsinbox_session=${SESSION}`,
          "content-type": "application/json",
          "sec-fetch-site": "cross-site",
        },
        body: JSON.stringify({ action: "rotate" }),
      }),
      envFor(harness.db),
    );
    expect(cross.status).toBe(403);
    expect(harness.state.messages.length).toBeGreaterThan(0);
    expect(oldSecret.length).toBeGreaterThan(16);
  });

  it("limits each credential to 60 requests and redacts a failed lookup", async () => {
    const logs = captureLogs();
    const harness = createDb();
    const created = await createDevice(harness);
    const secret = created.push_url.split("/").pop() ?? "";
    const pushHash = await sha256Hex(secret);
    const windowStart = Math.floor(NOW / 60_000) * 60_000;
    harness.state.rates.set(`${pushHash}:${windowStart}`, 60);

    const limited = await workerEntry().fetch(posted(created.push_url), envFor(harness.db), waitCtx().ctx as ExecutionContext);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    const bearer = await handleSms(smsRequest(created.token, smsBody("验证码 123456")), envFor(harness.db), waitCtx().ctx);
    expect(bearer.status).toBe(200);

    harness.state.throwOnPushLookup = true;
    const crashed = await workerEntry().fetch(
      posted(`${created.push_url}?leak=${secret}`),
      envFor(harness.db),
      waitCtx().ctx as ExecutionContext,
    );
    expect(crashed.status).toBe(500);
    expect(JSON.stringify(await crashed.json())).not.toContain(secret);
    const failed = logs.errors.map((line) => JSON.parse(line) as { path?: string; message?: string }).at(-1);
    expect(failed?.message).toBe("request_failed");
    expect(failed?.path).toBe("/api/v1/ingest/:secret");
    expect(logs.info.join("") + logs.errors.join("")).not.toContain(secret);

    const blocked = await workerEntry().fetch(
      new Request(created.push_url, { method: "GET" }),
      envFor(harness.db),
      waitCtx().ctx as ExecutionContext,
    );
    expect(blocked.status).toBe(405);
    expect(blocked.headers.get("allow")).toBe("POST");
    expect(harness.state.messages).toHaveLength(1);
    const getLog = logs.info
      .map((line) => JSON.parse(line) as { method?: string; path?: string })
      .filter((line) => line.method === "GET")
      .at(-1);
    expect(getLog?.path).toBe("/api/v1/ingest/:secret");
  });

  it("encrypts an ingested message when CONTENT_KEY is set and rejects a huge body first", async () => {
    const harness = createDb();
    const created = await createDevice(harness);
    const key = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const response = await workerEntry().fetch(
      posted(created.push_url),
      envFor(harness.db, key),
      waitCtx().ctx as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, code: "123456" });
    expect(harness.state.messages[0]?.encrypted).toBe(1);
    expect(harness.state.messages[0]?.content.startsWith(ENCRYPTED_PREFIX)).toBe(true);

    const huge = await workerEntry().fetch(
      posted(created.push_url, "x".repeat(MAX_BODY_BYTES + 1)),
      envFor(harness.db, key),
      waitCtx().ctx as ExecutionContext,
    );
    expect(huge.status).toBe(413);
    expect(harness.state.messages).toHaveLength(1);
  });

  it("does not treat a session cookie as a push credential", async () => {
    const harness = createDb();
    await createDevice(harness);
    const response = await workerEntry().fetch(
      posted("https://sms.example/api/v1/ingest/psh_" + "c".repeat(32), smsBody("验证码 123456"), {
        cookie: `smsinbox_session=${SESSION}`,
      }),
      envFor(harness.db),
      waitCtx().ctx as ExecutionContext,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "推送链接无效" });
    expect(harness.state.messages).toHaveLength(0);
  });
});
