import { describe, expect, it } from "vitest";
import { handleApi } from "../src/routes/api";
import {
  advanceCursor,
  createInboxStream,
  encodeCursor,
  formatSseComment,
  formatSseEvent,
  isAfterCursor,
  parseCursor,
  resolveCursor,
  type SseCursor,
} from "../src/sse";
import type { MessageView } from "../src/types";

const MESSAGE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function sample(overrides: Partial<MessageView> = {}): MessageView {
  return {
    id: MESSAGE_ID,
    device_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    device_name: "pixel",
    from_number: "10086",
    to_number: "",
    content: "验证码 123456",
    code: "123456",
    sim: "1",
    reported_device: "pixel",
    received_at: 2_000,
    created_at: 2_000,
    ...overrides,
  };
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) text += decoder.decode(value, { stream: true });
  }
  return text;
}

function fakeDb(first: unknown): D1Database {
  return {
    prepare() {
      const statement = {
        bind() {
          return statement;
        },
        async first() {
          return first;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return { meta: { changes: 0 } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

function envWith(db: D1Database): Env {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response("") },
    RETENTION_DAYS: "90",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "secret",
  } as unknown as Env;
}

describe("SSE frames and cursors", () => {
  it("writes one event with an id and keeps newlines inside data fields", () => {
    expect(formatSseEvent("message", { message: "a\nb" }, "10:abc")).toBe(
      'id: 10:abc\nevent: message\ndata: {"message":"a\\nb"}\n\n',
    );
    expect(formatSseEvent("message", { ok: true }, "bad\nid")).toBe('id: badid\nevent: message\ndata: {"ok":true}\n\n');
    expect(formatSseComment("connected\nping")).toBe(": connectedping\n\n");
  });

  it("parses created_at cursors and ignores the query when Last-Event-ID is present", () => {
    expect(parseCursor("1700000000000:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).toEqual({
      createdAt: 1_700_000_000_000,
      id: MESSAGE_ID,
    });
    expect(parseCursor("1000:")).toEqual({ createdAt: 1000, id: "" });
    expect(parseCursor("nope")).toBeNull();
    expect(parseCursor("10:not a uuid")).toBeNull();
    expect(encodeCursor({ createdAt: 10, id: MESSAGE_ID })).toBe(`10:${MESSAGE_ID}`);
    expect(resolveCursor(`20:${MESSAGE_ID}`, "10:", 99)).toEqual({ createdAt: 20, id: MESSAGE_ID });
    expect(resolveCursor(null, "10:", 99)).toEqual({ createdAt: 10, id: "" });
    expect(resolveCursor(null, null, 99)).toEqual({ createdAt: 99, id: "" });
  });

  it("orders messages by created_at and then id", () => {
    const cursor: SseCursor = { createdAt: 100, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    expect(isAfterCursor({ created_at: 101, id: "00000000-0000-4000-8000-000000000000" }, cursor)).toBe(true);
    expect(isAfterCursor({ created_at: 99, id: "ffffffff-ffff-4fff-8fff-ffffffffffff" }, cursor)).toBe(false);
    expect(isAfterCursor({ created_at: 100, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, cursor)).toBe(true);
    expect(isAfterCursor({ created_at: 100, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, cursor)).toBe(false);
    expect(advanceCursor(cursor, { created_at: 100, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa0" })).toEqual(cursor);
    expect(advanceCursor(cursor, { created_at: 100, id: MESSAGE_ID }).id).toBe(MESSAGE_ID);
  });
});

describe("inbox stream", () => {
  it("emits a new message and then bye when the hold window ends", async () => {
    let now = 1_000;
    const seen: SseCursor[] = [];
    const stream = createInboxStream({
      cursor: { createdAt: 1_000, id: "" },
      signal: new AbortController().signal,
      holdMs: 5_000,
      pollMs: 1_000,
      now: () => now,
      sleep: async () => {
        now += 3_000;
      },
      poll: async (cursor) => {
        seen.push({ ...cursor });
        if (seen.length === 1) return [sample()];
        return [];
      },
    });
    const text = await readStream(stream);
    expect(text.startsWith(": connected\n\n")).toBe(true);
    expect(text).toContain(`id: 2000:${MESSAGE_ID}\n`);
    expect(text).toContain('"from_number":"10086"');
    expect(text).toContain("event: bye");
    expect(text).toContain(": ping");
    expect(seen[0]).toEqual({ createdAt: 1_000, id: "" });
    expect(seen[1]).toEqual({ createdAt: 2_000, id: MESSAGE_ID });
    expect(seen).toHaveLength(2);
  });

  it("stops without bye when the client aborts", async () => {
    const controller = new AbortController();
    let polls = 0;
    const stream = createInboxStream({
      cursor: { createdAt: 0, id: "" },
      signal: controller.signal,
      holdMs: 60_000,
      pollMs: 30_000,
      now: () => 0,
      sleep: (_ms, signal) =>
        new Promise((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          const timer = setTimeout(resolve, 30_000);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        }),
      poll: async () => {
        polls += 1;
        controller.abort();
        return [];
      },
    });
    const text = await readStream(stream);
    expect(polls).toBe(1);
    expect(text).toContain(": connected");
    expect(text).not.toContain("event: bye");
  });

  it("ends the stream when polling fails and does not throw", async () => {
    const stream = createInboxStream({
      cursor: { createdAt: 0, id: "" },
      signal: new AbortController().signal,
      holdMs: 10_000,
      pollMs: 1_000,
      now: () => 0,
      sleep: async () => {},
      poll: async () => {
        throw new Error("d1 down");
      },
    });
    const text = await readStream(stream);
    expect(text).toContain(": poll-error");
    expect(text).not.toContain("d1 down");
    expect(text).not.toContain("event: bye");
  });
});

describe("GET /api/v1/events", () => {
  it("requires a session", async () => {
    const response = await handleApi(
      new Request("https://sms.example/api/v1/events"),
      envWith(fakeDb(null)),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false });
  });

  it("opens a text/event-stream for a logged-in user and stops when aborted", async () => {
    const controller = new AbortController();
    const request = new Request("https://sms.example/api/v1/events?cursor=10:", {
      headers: { cookie: "smsinbox_session=sms_session_token_value" },
      signal: controller.signal,
    });
    const response = await handleApi(
      request,
      envWith(
        fakeDb({
          id: "user-1",
          username: "admin",
          role: "admin",
          expires_at: Date.now() + 60_000,
        }),
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-store");
    const reader = response.body?.getReader();
    expect(reader).toBeTruthy();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toContain(": connected");
    controller.abort();
    await reader?.cancel();
    const finished = await Promise.race([
      reader?.read().then(() => "done"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 1_000)),
    ]);
    expect(finished).toBe("done");
  });
});
