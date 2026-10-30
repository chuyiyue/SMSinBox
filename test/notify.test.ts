import { describe, expect, it, vi } from "vitest";
import { handleApi } from "../src/routes/api";
import {
  channelFromRow,
  deliverChannels,
  parseChannelInput,
  redactConfig,
  renderNotification,
  scheduleNotify,
  scrub,
  type StoredChannel,
} from "../src/notify";
import { notifyStoredSms } from "../src/notify";
import { dotStuff, renderData, sendSmtp, type LineSocket } from "../src/smtp";
import type { NotifyChannelRow } from "../src/types";

const TOKEN = "123456789:AAHabcdefghijklmnopqrstuvwxyz0123456789";
const WEBHOOK = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcDEF123456";

class ScriptedSocket implements LineSocket {
  written: string[] = [];
  closed = false;
  private index = 0;

  constructor(private readonly replies: string[]) {}

  async readLine(): Promise<string> {
    const line = this.replies[this.index];
    this.index += 1;
    if (line === undefined) throw new Error("SMTP 没有更多响应");
    return line;
  }

  async write(data: string): Promise<void> {
    this.written.push(data);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function channel(partial: Partial<StoredChannel> & Pick<StoredChannel, "kind" | "config">): StoredChannel {
  return {
    id: partial.id ?? "11111111-1111-4111-8111-111111111111",
    userId: "user-1",
    enabled: partial.enabled ?? true,
    createdAt: partial.createdAt ?? 1,
    kind: partial.kind,
    config: partial.config,
  };
}

function fakeDb(options: { first?: unknown; all?: unknown[]; changes?: number } = {}): D1Database {
  return {
    prepare() {
      const statement = {
        bind() {
          return statement;
        },
        async first() {
          return options.first ?? null;
        },
        async all() {
          return { results: options.all ?? [] };
        },
        async run() {
          return { meta: { changes: options.changes ?? 1 } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

function authedEnv(db: D1Database): Env {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response(null) },
    RETENTION_DAYS: "90",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "secret",
  } as unknown as Env;
}

function sessionUser(extra: Record<string, unknown> = {}) {
  return { id: "user-1", username: "admin", expires_at: Date.now() + 60_000, ...extra };
}

describe("notification text and config", () => {
  it("renders a short title with the code and truncates the body", () => {
    const note = renderNotification({
      from: "10086",
      content: "验".repeat(600),
      code: "654321",
      deviceName: "pixel",
      receivedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
    });
    expect(note.title).toBe("验证码 654321");
    expect(note.text).toContain("pixel · 10086");
    expect(note.text).toContain("2026-01-02T03:04:05.000Z");
    expect([...note.text].length).toBe(501);
    expect(note.text.endsWith("…")).toBe(true);
  });

  it("accepts the four channels and rejects unsafe endpoints", () => {
    expect(parseChannelInput({ kind: "telegram", bot_token: TOKEN, chat_id: "-100123" }).ok).toBe(true);
    expect(parseChannelInput({ kind: "telegram", bot_token: TOKEN, chat_id: "@alerts" }).ok).toBe(true);
    expect(parseChannelInput({ kind: "telegram", bot_token: "nope", chat_id: "1" }).ok).toBe(false);
    expect(parseChannelInput({ kind: "wecom", webhook_url: WEBHOOK }).ok).toBe(true);
    expect(parseChannelInput({ kind: "wecom", webhook_url: "http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcDEF123456" }).ok).toBe(false);
    expect(parseChannelInput({ kind: "wecom", webhook_url: "https://evil.example/cgi-bin/webhook/send?key=abcDEF123456" }).ok).toBe(false);
    expect(parseChannelInput({ kind: "bark", device_key: "abcd1234" }).ok).toBe(true);
    expect(parseChannelInput({ kind: "bark", device_key: "abcd1234", server: "https://127.0.0.1" }).ok).toBe(false);
    expect(parseChannelInput({ kind: "bark", device_key: "abcd1234", server: "https://10.1.2.3" }).ok).toBe(false);
    expect(parseChannelInput({ kind: "bark", device_key: "abcd1234", server: "http://api.day.app" }).ok).toBe(false);
    expect(parseChannelInput({ kind: "bark", device_key: "abcd1234", server: "https://[::1]" }).ok).toBe(false);
    const email = parseChannelInput({
      kind: "email",
      to: "you@example.com",
      from: "sms@example.com",
      smtp_host: "smtp.example.com",
      smtp_username: "sms@example.com",
      smtp_password: "secret",
    });
    expect(email.ok).toBe(true);
    if (email.ok) expect(email.config).toMatchObject({ smtp_port: 465 });
    expect(parseChannelInput({
      kind: "email",
      to: "you@example.com",
      from: "sms@example.com",
      smtp_host: "smtp.example.com",
      smtp_port: 587,
      smtp_username: "sms",
      smtp_password: "secret",
    }).ok).toBe(false);
    expect(parseChannelInput({
      kind: "email",
      to: "you@example.com",
      from: "sms@example.com",
      webhook_url: "https://mail.example.com/hook",
      smtp_host: "smtp.example.com",
    }).ok).toBe(false);
    expect(parseChannelInput({
      kind: "email",
      to: "you@example.com",
      from: "sms@example.com",
      webhook_url: "https://169.254.169.254/mail",
    }).ok).toBe(false);
  });

  it("masks secrets but keeps the address that the user needs to recognize", () => {
    const parsed = parseChannelInput({ kind: "telegram", bot_token: TOKEN, chat_id: "42" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const redacted = redactConfig(parsed.kind, parsed.config);
    expect(redacted.bot_token).toBe("****6789");
    expect(redacted.chat_id).toBe("42");
    expect(JSON.stringify(redacted)).not.toContain("AAHabc");
    const wecom = parseChannelInput({ kind: "wecom", webhook_url: WEBHOOK });
    expect(wecom.ok).toBe(true);
    if (!wecom.ok) return;
    expect(JSON.stringify(redactConfig(wecom.kind, wecom.config))).not.toContain("abcDEF123456");
    expect(scrub(`failed bot${TOKEN} key=abcDEF123456`)).toBe("failed bot*** key=***");
    expect(scrub(`failed bot${TOKEN} key=abcDEF123456`)).not.toContain("AAHabc");
  });
});

describe("delivery", () => {
  it("keeps going when one channel fails", async () => {
    const calls: string[] = [];
    const results = await deliverChannels(
      [
        channel({ kind: "telegram", config: { bot_token: TOKEN, chat_id: "1" } }),
        channel({
          id: "22222222-2222-4222-8222-222222222222",
          kind: "wecom",
          config: { webhook_url: WEBHOOK },
        }),
        channel({
          id: "33333333-3333-4333-8333-333333333333",
          kind: "bark",
          config: { device_key: "abcd1234", server: "https://api.day.app" },
        }),
        channel({
          id: "44444444-4444-4444-8444-444444444444",
          kind: "email",
          config: {
            to: "you@example.com",
            from: "sms@example.com",
            smtp_host: "smtp.example.com",
            smtp_port: 465,
            smtp_username: "user",
            smtp_password: "secret",
          },
        }),
      ],
      { title: "验证码 123456", text: "正文" },
      {
        fetch: async (input) => {
          const url = String(input);
          calls.push(url);
          if (url.includes("api.telegram.org")) return new Response("no", { status: 500 });
          if (url.includes("qyapi.weixin.qq.com")) return Response.json({ errcode: 0 });
          return Response.json({ code: 200 });
        },
        openSmtp: async () => {
          throw new Error(`connect bot${TOKEN}`);
        },
      },
    );
    expect(results.map((result) => result.ok)).toEqual([false, true, true, false]);
    expect(results[0]?.error).toBe("Telegram 返回 500");
    expect(results[3]?.error).toContain("bot***");
    expect(results[3]?.error).not.toContain("AAHabc");
    expect(calls.some((url) => url.startsWith(`https://api.telegram.org/bot${encodeURIComponent(TOKEN)}/sendMessage`))).toBe(true);
    expect(calls.some((url) => url === "https://api.day.app/push")).toBe(true);
  });

  it("treats provider redirects and wecom error codes as failures", async () => {
    const results = await deliverChannels(
      [
        channel({ kind: "wecom", config: { webhook_url: WEBHOOK } }),
        channel({
          id: "22222222-2222-4222-8222-222222222222",
          kind: "email",
          config: { to: "you@example.com", from: "sms@example.com", webhook_url: "https://mail.example.com/hook" },
        }),
      ],
      { title: "测试", text: "不含短信" },
      {
        fetch: async (input, init) => {
          const url = String(input);
          expect(init?.redirect).toBe("manual");
          if (url.includes("qyapi")) return Response.json({ errcode: 93000, errmsg: WEBHOOK });
          return new Response(null, { status: 302, headers: { location: "https://evil.example/bot-secret" } });
        },
        openSmtp: async () => {
          throw new Error("should not send smtp");
        },
      },
    );
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.error).toBe("企业微信拒绝了这条通知");
    expect(results[0]?.error).not.toContain("abcDEF");
    expect(results[1]?.ok).toBe(false);
    expect(results[1]?.error).toBe("邮件 返回 302");
    expect(results[1]?.error).not.toContain("evil.example");
  });

  it("skips disabled and unreadable channels", async () => {
    let fetches = 0;
    const env = authedEnv(fakeDb({
      all: [
        row({ enabled: 0, config: JSON.stringify({ bot_token: TOKEN, chat_id: "1" }) }),
        row({ id: "22222222-2222-4222-8222-222222222222", kind: "telegram", config: "{", enabled: 1 }),
        row({
          id: "33333333-3333-4333-8333-333333333333",
          kind: "bark",
          config: JSON.stringify({ device_key: "abcd1234", server: "https://api.day.app" }),
          enabled: 1,
        }),
      ],
    }));
    const results = await notifyStoredSms(env, "user-1", {
      from: "10086",
      content: "验证码 123456",
      code: "123456",
      deviceName: "pixel",
      receivedAt: 1_700_000_000_000,
    }, {
      fetch: async () => {
        fetches += 1;
        return Response.json({ code: 200 });
      },
      openSmtp: async () => {
        throw new Error("unused");
      },
    });
    expect(fetches).toBe(1);
    expect(results).toEqual([
      { id: "33333333-3333-4333-8333-333333333333", kind: "bark", ok: true },
    ]);
  });
});

describe("SMTP", () => {
  it("dot-stuffs the body and speaks AUTH LOGIN", async () => {
    const socket = new ScriptedSocket([
      "220 ready",
      "250-hello",
      "250 AUTH LOGIN",
      "334 VXNlcm5hbWU6",
      "334 UGFzc3dvcmQ6",
      "235 ok",
      "250 ok",
      "250 ok",
      "354 go",
      "250 queued",
      "221 bye",
    ]);
    await sendSmtp(socket, {
      username: "user",
      password: "secret",
      from: "sms@example.com",
      to: "you@example.com",
      subject: "验证码 123456",
      text: ".\nhello",
    });
    const transcript = socket.written.join("");
    expect(transcript).toContain("EHLO smsinbox\r\n");
    expect(transcript).toContain("AUTH LOGIN\r\n");
    expect(transcript).toContain("dXNlcg==\r\n");
    expect(transcript).toContain("MAIL FROM:<sms@example.com>\r\n");
    expect(transcript).toContain("\r\n..");
    expect(transcript).toContain("\r\n.\r\n");
    expect(socket.closed).toBe(true);
    expect(dotStuff(".\n.hidden")).toBe("..\r\n..hidden");
    expect(renderData({
      username: "user",
      password: "secret",
      from: "sms@example.com",
      to: "you@example.com",
      subject: "验证码",
      text: "hi",
    })).toContain("Subject: =?UTF-8?B?");
    expect(renderData({
      username: "user",
      password: "secret",
      from: "sms@example.com",
      to: "you@example.com",
      subject: "验证码",
      text: "hi",
    })).not.toContain("secret");
  });

  it("does not include the password when the server rejects the message", async () => {
    const socket = new ScriptedSocket(["550 no"]);
    await expect(sendSmtp(socket, {
      username: "user",
      password: "super-secret-password",
      from: "sms@example.com",
      to: "you@example.com",
      subject: "hi",
      text: "body",
    })).rejects.toThrow("SMTP 返回 550");
  });
});

describe("failure isolation", () => {
  it("resolves after a notify task throws and scrubs secrets from the log", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line) => {
      errors.push(String(line));
    });
    const jobs: Promise<unknown>[] = [];
    let stored = true;
    scheduleNotify(
      { waitUntil: (job) => jobs.push(job) },
      async () => {
        throw new Error(`provider down bot${TOKEN}`);
      },
    );
    expect(stored).toBe(true);
    await Promise.all(jobs);
    expect(errors.join("")).toContain("bot***");
    expect(errors.join("")).not.toContain("AAHabc");
    expect(() => scheduleNotify({ waitUntil: () => { throw new Error("no waitUntil"); } }, async () => undefined)).not.toThrow();
    spy.mockRestore();
  });
});

describe("notification API", () => {
  it("requires a session", async () => {
    const response = await handleApi(
      new Request("https://sms.example/api/v1/notifications"),
      authedEnv(fakeDb()),
    );
    expect(response.status).toBe(401);
  });

  it("returns a redacted channel and refuses the eleventh one", async () => {
    const request = new Request("https://sms.example/api/v1/notifications", {
      method: "POST",
      headers: { cookie: "smsinbox_session=sms_session_token_value", "content-type": "application/json" },
      body: JSON.stringify({ kind: "telegram", bot_token: TOKEN, chat_id: "42" }),
    });
    const created = await handleApi(request, authedEnv(fakeDb({ first: sessionUser() })));
    expect(created.status).toBe(200);
    const body = await created.json() as { channel: { config: { bot_token: string } } };
    expect(body.channel.config.bot_token).toBe("****6789");
    expect(JSON.stringify(body)).not.toContain("AAHabc");

    const limited = await handleApi(
      new Request("https://sms.example/api/v1/notifications", {
        method: "POST",
        headers: { cookie: "smsinbox_session=sms_session_token_value", "content-type": "application/json" },
        body: JSON.stringify({ kind: "telegram", bot_token: TOKEN, chat_id: "42" }),
      }),
      authedEnv(fakeDb({ first: sessionUser({ total: 10 }) })),
    );
    expect(limited.status).toBe(400);
  });

  it("lists stored channels without the bot token", async () => {
    const stored = row({ config: JSON.stringify({ bot_token: TOKEN, chat_id: "42" }) });
    expect(channelFromRow(stored)?.kind).toBe("telegram");
    const response = await handleApi(
      new Request("https://sms.example/api/v1/notifications", {
        headers: { cookie: "smsinbox_session=sms_session_token_value" },
      }),
      authedEnv(fakeDb({ first: sessionUser(), all: [stored] })),
    );
    const body = await response.json() as { channels: Array<{ config: { bot_token: string } }> };
    expect(body.channels[0]?.config.bot_token).toBe("****6789");
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });
});

function row(overrides: Partial<NotifyChannelRow> = {}): NotifyChannelRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    user_id: "user-1",
    kind: "telegram",
    config: JSON.stringify({ bot_token: TOKEN, chat_id: "1" }),
    enabled: 1,
    created_at: 1,
    ...overrides,
  };
}
