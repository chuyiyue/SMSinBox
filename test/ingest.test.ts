import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex, signHmacHex } from "../src/auth";
import { MAX_BODY_BYTES } from "../src/http";
import worker from "../src/index";
import { handleSms } from "../src/routes/sms";

const NOW = 1_700_000_000_000;
const USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DEVICE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOKEN = "sms_bearer_token_for_tests_0001";

type DeviceRow = {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  secret: string | null;
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

type State = {
  devices: DeviceRow[];
  messages: MessageRow[];
  rates: Map<string, number>;
};

function createDb() {
  const state: State = { devices: [], messages: [], rates: new Map() };
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
          if (sql.includes("SET last_seen_at")) {
            const device = state.devices.find((row) => row.id === args[1]);
            if (device) device.last_seen_at = Number(args[0]);
            return { meta: { changes: device ? 1 : 0 } };
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

function envFor(db: D1Database): Env {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response("") },
    RETENTION_DAYS: "90",
    CONTENT_KEY: "",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "secret",
  } as unknown as Env;
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
    token_hash: await sha256Hex(token),
    secret,
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
