// Manual message deletion against local D1 and the real migration
// files, driving the worker's HTTP surface end to end.
import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import worker from "../src/index";
import { seedAdmin } from "./seed-admin";

const ORIGIN = "http://smsinbox.test";
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "delete-test-password-1";

let mf: Miniflare;
let env: Env;
let cookie = "";
let deviceId = "";

const MESSAGE_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];

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

async function call(path: string, init: RequestInit = {}, withCookie = true): Promise<Response> {
  const headers = new Headers(init.headers);
  if (withCookie && cookie) headers.set("cookie", cookie);
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

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

async function body(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

async function messageCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS total FROM messages").first<{ total: number }>();
  return row?.total ?? -1;
}

async function seedMessage(id: string, index: number): Promise<void> {
  const now = 1_700_000_000_000 + index * 1000;
  await env.DB.prepare(
    `INSERT INTO messages (
       id, device_id, from_number, to_number, content, content_hash, code, raw_payload,
       received_at, created_at, encrypted
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  )
    .bind(id, deviceId, "+442071234567", "", `delete test ${index}`, `hash-delete-${index}`, null, "{}", now, now)
    .run();
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
          env: { DB: { type: "d1", id: "smsinbox-message-delete" } },
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
    DEVICE_JWT_SECRET: "delete-test-jwt-secret-0123456789",
  } as Env;
  const files = readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = readFileSync(`migrations/${file}`, "utf8");
    for (const statement of sql.split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
      await env.DB.prepare(statement).run();
    }
  }
  await seedAdmin(env.DB, { username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
  const login = await call(
    "/api/v1/auth/login",
    jsonInit("POST", { username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
    false,
  );
  expect(login.status).toBe(200);
  const raw = login.headers.get("set-cookie") ?? "";
  const match = /smsinbox_session=([^;]+)/.exec(raw);
  expect(match?.[1]).toBeTruthy();
  cookie = `smsinbox_session=${match?.[1]}`;

  const created = await call("/api/v1/devices", jsonInit("POST", { name: "delete-phone" }));
  expect(created.status).toBe(200);
  deviceId = (await body(created)).device.id as string;
  for (let i = 0; i < MESSAGE_IDS.length; i += 1) await seedMessage(MESSAGE_IDS[i], i);
  expect(await messageCount()).toBe(3);
}, 30_000);

afterAll(async () => {
  await Promise.all(contexts.map((ctx) => ctx.drain()));
  await mf.dispose();
});

describe("POST /api/v1/messages/delete", () => {
  it("requires a login session", async () => {
    const response = await call("/api/v1/messages/delete", jsonInit("POST", { ids: [MESSAGE_IDS[0]] }), false);
    expect(response.status).toBe(401);
    expect(await messageCount()).toBe(3);
  });

  it("rejects an empty id list", async () => {
    const response = await call("/api/v1/messages/delete", jsonInit("POST", { ids: [] }));
    expect(response.status).toBe(400);
    expect((await body(response)).ok).toBe(false);
  });

  it("rejects more than 100 ids", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `44444444-4444-4444-8444-${String(i).padStart(12, "0")}`);
    const response = await call("/api/v1/messages/delete", jsonInit("POST", { ids }));
    expect(response.status).toBe(400);
  });

  it("rejects non-string or blank ids", async () => {
    for (const ids of [[""], ["   "], [42], [MESSAGE_IDS[0], null]]) {
      const response = await call("/api/v1/messages/delete", jsonInit("POST", { ids }));
      expect(response.status).toBe(400);
    }
    expect(await messageCount()).toBe(3);
  });

  it("ignores ids that do not exist", async () => {
    const response = await call(
      "/api/v1/messages/delete",
      jsonInit("POST", { ids: ["99999999-9999-4999-8999-999999999999"] }),
    );
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ ok: true, deleted: 0 });
    expect(await messageCount()).toBe(3);
  });

  it("deletes the listed messages and reports the real count", async () => {
    const response = await call(
      "/api/v1/messages/delete",
      jsonInit("POST", { ids: [MESSAGE_IDS[0], MESSAGE_IDS[1], "99999999-9999-4999-8999-999999999999"] }),
    );
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ ok: true, deleted: 2 });
    expect(await messageCount()).toBe(1);

    const listed = await body(await call("/api/v1/messages?page=1&page_size=20"));
    expect(listed.total).toBe(1);
    expect((listed.messages as Array<Record<string, any>>).map((m) => m.id)).toEqual([MESSAGE_IDS[2]]);

    const detail = await call(`/api/v1/messages/${MESSAGE_IDS[0]}`);
    expect(detail.status).toBe(404);
  });
});
