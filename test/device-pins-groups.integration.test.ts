// Device pins + groups against local D1 and the real migration files,
// driving the worker's HTTP surface end to end.
import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import worker from "../src/index";

const ORIGIN = "http://smsinbox.test";
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "<MASKED_SECRET_002>";

let mf: Miniflare;
let env: Env;
let cookie = "";

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

async function call(path: string, init: RequestInit = {}): Promise<Response> {
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

async function createDevice(name: string): Promise<string> {
  const response = await call("/api/v1/devices", jsonInit("POST", { name }));
  expect(response.status).toBe(200);
  const created = await body(response);
  return created.device.id as string;
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
          env: { DB: { type: "d1", id: "smsinbox-pins-groups" } },
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
    DEVICE_JWT_SECRET: "<MASKED_SECRET_003>",
  } as Env;
  const files = readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = readFileSync(`migrations/${file}`, "utf8");
    for (const statement of sql.split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
      await env.DB.prepare(statement).run();
    }
  }
  const login = await call("/api/v1/auth/login", jsonInit("POST", { username: ADMIN_USERNAME, password: ADMIN_PASSWORD }));
  expect(login.status).toBe(200);
  const raw = login.headers.get("set-cookie") ?? "";
  const match = /smsinbox_session=([^;]+)/.exec(raw);
  expect(match?.[1]).toBeTruthy();
  cookie = `smsinbox_session=${match?.[1] ?? ""}`;
}, 30_000);

afterAll(async () => {
  await Promise.all(contexts.map((ctx) => ctx.drain()));
  await mf.dispose();
});

describe("device pins", () => {
  it("pins up to five devices and refuses a sixth", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) ids.push(await createDevice(`pin-${i}`));
    for (let i = 0; i < 5; i += 1) {
      const response = await call(`/api/v1/devices/${ids[i]}/pin`, jsonInit("POST"));
      expect(response.status).toBe(200);
      expect((await body(response)).pinned).toBe(true);
    }
    const sixth = await call(`/api/v1/devices/${ids[5]}/pin`, jsonInit("POST"));
    expect(sixth.status).toBe(400);
    expect((await body(sixth)).error).toContain("最多置顶 5");

    const listed = await body(await call("/api/v1/devices"));
    const devices = listed.devices as Array<Record<string, any>>;
    expect(devices.filter((d) => d.pinned_at != null)).toHaveLength(5);
    expect(devices.find((d) => d.id === ids[5])?.pinned_at).toBeNull();

    // Unpinning frees a slot; re-pinning an already pinned device is a no-op.
    expect((await call(`/api/v1/devices/${ids[0]}/unpin`, jsonInit("POST"))).status).toBe(200);
    expect((await call(`/api/v1/devices/${ids[5]}/pin`, jsonInit("POST"))).status).toBe(200);
    expect((await call(`/api/v1/devices/${ids[5]}/pin`, jsonInit("POST"))).status).toBe(200);
    const after = await body(await call("/api/v1/devices"));
    expect((after.devices as Array<Record<string, any>>).filter((d) => d.pinned_at != null)).toHaveLength(5);

    const missing = await call("/api/v1/devices/99999999-9999-4999-8999-999999999999/pin", jsonInit("POST"));
    expect(missing.status).toBe(404);
  });
});

describe("device groups", () => {
  it("creates, assigns, renames, and deletes groups without touching devices", async () => {
    const deviceId = await createDevice("grouped-one");
    const created = await call("/api/v1/device-groups", jsonInit("POST", { name: "主力机" }));
    expect(created.status).toBe(200);
    const group = (await body(created)).group as Record<string, any>;
    expect(group.name).toBe("主力机");
    expect(group.device_count).toBe(0);

    const invalid = await call("/api/v1/device-groups", jsonInit("POST", { name: "  " }));
    expect(invalid.status).toBe(400);

    const assigned = await call(`/api/v1/devices/${deviceId}`, jsonInit("PATCH", { group_id: group.id }));
    expect(assigned.status).toBe(200);
    expect((await body(assigned)).group_id).toBe(group.id);

    let listed = await body(await call("/api/v1/devices"));
    expect((listed.devices as Array<Record<string, any>>).find((d) => d.id === deviceId)?.group_id).toBe(group.id);
    let groups = await body(await call("/api/v1/device-groups"));
    expect((groups.groups as Array<Record<string, any>>).find((g) => g.id === group.id)?.device_count).toBe(1);

    const renamed = await call(`/api/v1/device-groups/${group.id}`, jsonInit("PATCH", { name: "备用机" }));
    expect(renamed.status).toBe(200);
    groups = await body(await call("/api/v1/device-groups"));
    expect((groups.groups as Array<Record<string, any>>).find((g) => g.id === group.id)?.name).toBe("备用机");

    // Deleting the group ungroups the device instead of deleting it.
    expect((await call(`/api/v1/device-groups/${group.id}`, { method: "DELETE" })).status).toBe(200);
    listed = await body(await call("/api/v1/devices"));
    const survivor = (listed.devices as Array<Record<string, any>>).find((d) => d.id === deviceId);
    expect(survivor).toBeTruthy();
    expect(survivor?.group_id).toBeNull();

    const gone = await call(`/api/v1/device-groups/${group.id}`, jsonInit("PATCH", { name: "x" }));
    expect(gone.status).toBe(404);
  });

  it("rejects assigning a device to a group that does not exist", async () => {
    const deviceId = await createDevice("orphan");
    const response = await call(`/api/v1/devices/${deviceId}`, jsonInit("PATCH", {
      group_id: "88888888-8888-4888-8888-888888888888",
    }));
    expect(response.status).toBe(404);
    // A name-only patch still works, and an empty patch is refused.
    const renamed = await call(`/api/v1/devices/${deviceId}`, jsonInit("PATCH", { name: "orphan-2" }));
    expect(renamed.status).toBe(200);
    expect((await body(renamed)).name).toBe("orphan-2");
    const empty = await call(`/api/v1/devices/${deviceId}`, jsonInit("PATCH", {}));
    expect(empty.status).toBe(400);
  });
});
