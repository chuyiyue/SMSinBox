import { describe, expect, it, vi } from "vitest";
import { handleApi } from "../src/routes/api";
import {
  channelFromRow,
  defaultDeps,
  deliverChannels,
  parseChannelInput,
  recordPushResults,
  redactConfig,
  renderNotification,
  scheduleNotify,
  scrub,
  signDingtalk,
  signFeishu,
  type StoredChannel,
} from "../src/notify";
import { notifyStoredSms } from "../src/notify";
import { dotStuff, renderData, sendSmtp, type LineSocket } from "../src/smtp";
import type { NotifyChannelRow } from "../src/types";

const TOKEN = "123456789:AAHabcdefghijklmnopqrstuvwxyz0123456789";
const WEBHOOK = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcDEF123456";
const FEISHU_WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/abcd1234-efgh-5678";
const FEISHU_SECRET = "feishu-secret";
const DINGTALK_WEBHOOK = "https://oapi.dingtalk.com/robot/send?access_token=abcDEF1234567890";
const DINGTALK_SECRET = "SECtestsecret";

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
    note: partial.note ?? "",
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
  return { id: "user-1", username: "admin", role: "admin", expires_at: Date.now() + 60_000, ...extra };
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

  it("accepts the supported channels and rejects unsafe endpoints", () => {
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
    const resend = parseChannelInput({
      kind: "email",
      to: "you@example.com",
      from: "sms@resend.dev",
      resend_api_key: "re_1234567890",
    });
    expect(resend.ok).toBe(true);
    if (resend.ok) expect(resend.config).toMatchObject({ resend_api_key: "re_1234567890" });
    expect(parseChannelInput({
      kind: "email",
      to: "you@example.com",
      from: "sms@resend.dev",
      resend_api_key: "",
    }).ok).toBe(false);
    const webhook = parseChannelInput({ kind: "webhook", url: "https://example.com/hook?token=abc123" });
    expect(webhook.ok).toBe(true);
    if (webhook.ok) expect(webhook.config).toEqual({ url: "https://example.com/hook?token=abc123" });
    expect(parseChannelInput({ kind: "webhook", url: "ftp://example.com/hook" }).ok).toBe(false);
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
    const webhook = parseChannelInput({ kind: "webhook", url: "https://example.com/hook?token=abc123" });
    expect(webhook.ok).toBe(true);
    if (webhook.ok) expect(JSON.stringify(redactConfig(webhook.kind, webhook.config))).not.toContain("abc123");
    expect(scrub(`failed bot${TOKEN} key=abcDEF123456`)).toBe("failed bot*** key=***");
    expect(scrub(`failed bot${TOKEN} key=abcDEF123456`)).not.toContain("AAHabc");
    expect(scrub(`failed https://oapi.dingtalk.com/robot/send?access_token=abcDEF&timestamp=1&sign=xyz`))
      .toBe("failed https://oapi.dingtalk.com/robot/send?access_token=***&timestamp=1&sign=***");
  });

  it("sends Resend email requests and scrubs invalid API key errors", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const results = await deliverChannels(
      [channel({ kind: "email", config: { to: "you@example.com", from: "sms@resend.dev", resend_api_key: "re_1234567890" } })],
      { title: "验证码 123456", text: "pixel · 10086\n2026-01-02T03:04:05.000Z\n您的验证码是 123456" },
      {
        fetch: async (input, init) => {
          const headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
          calls.push({ url: String(input), headers, body: String(init?.body ?? "") });
          return Response.json({ id: "mail_123" }, { status: 200 });
        },
        openSmtp: async () => {
          throw new Error("unused");
        },
      },
    );
    expect(results[0]?.ok).toBe(true);
    expect(calls[0]?.url).toBe("https://api.resend.com/emails");
    expect(calls[0]?.headers.authorization).toBe("Bearer re_1234567890");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({
      from: "sms@resend.dev",
      to: "you@example.com",
      subject: "验证码 123456",
      text: "pixel · 10086\n2026-01-02T03:04:05.000Z\n您的验证码是 123456",
    });

    const failed = await deliverChannels(
      [channel({ kind: "email", config: { to: "you@example.com", from: "sms@resend.dev", resend_api_key: "re_bad" } })],
      { title: "验证码 123456", text: "正文" },
      {
        fetch: async () => Response.json({ message: "invalid API key" }, { status: 401 }),
        openSmtp: async () => {
          throw new Error("unused");
        },
      },
    );
    expect(failed[0]?.ok).toBe(false);
    expect(failed[0]?.error).toBe("invalid API key");
    expect(JSON.stringify(failed)).not.toContain("re_bad");
  });

  it("records webhook delivery results in push logs using the webhook kind", async () => {
    const calls: unknown[][] = [];
    const db = {
      prepare(_sql: string) {
        let args: unknown[] = [];
        const statement = {
          bind(...values: unknown[]) {
            args = values;
            return statement;
          },
          async run() {
            calls.push(args);
            return { meta: { changes: 1 } };
          },
        };
        return statement;
      },
    } as unknown as D1Database;
    await recordPushResults(
      authedEnv(db),
      "user-1",
      "sms",
      { title: "Webhook 测试", text: "正文" },
      [channel({ id: "webhook-result", kind: "webhook", config: { url: "https://example.com/hook?token=abc123" } })],
      [{ id: "webhook-result", kind: "webhook", ok: true }],
      "sms-1",
      "10086",
    );
    expect(calls[0]?.[4]).toBe("webhook");
    expect(String(calls[0]?.[8])).toContain("正文");
    expect(JSON.stringify(calls[0])).not.toContain("abc123");
  });
});

describe("feishu and dingtalk", () => {
  it("parses official webhook hosts and validates optional secrets", () => {
    const feishu = parseChannelInput({ kind: "feishu", webhook_url: FEISHU_WEBHOOK, secret: FEISHU_SECRET });
    expect(feishu.ok).toBe(true);
    if (feishu.ok) expect(feishu.config).toEqual({ webhook_url: FEISHU_WEBHOOK, secret: FEISHU_SECRET });
    expect(parseChannelInput({
      kind: "feishu",
      webhook_url: "https://open.larksuite.com/open-apis/bot/v2/hook/abcd1234",
    }).ok).toBe(true);
    expect(parseChannelInput({
      kind: "feishu",
      webhook_url: "http://open.feishu.cn/open-apis/bot/v2/hook/abcd1234",
    }).ok).toBe(false);
    expect(parseChannelInput({
      kind: "feishu",
      webhook_url: "https://evil.example/open-apis/bot/v2/hook/abcd1234",
    }).ok).toBe(false);
    expect(parseChannelInput({
      kind: "feishu",
      webhook_url: "https://open.feishu.cn/other/abcd1234",
    }).ok).toBe(false);
    expect(parseChannelInput({
      kind: "feishu",
      webhook_url: `${FEISHU_WEBHOOK}?from=1`,
    }).ok).toBe(false);
    expect(parseChannelInput({
      kind: "feishu",
      webhook_url: FEISHU_WEBHOOK,
      secret: "short",
    }).ok).toBe(false);

    const dingtalk = parseChannelInput({ kind: "dingtalk", webhook_url: DINGTALK_WEBHOOK, secret: DINGTALK_SECRET });
    expect(dingtalk.ok).toBe(true);
    if (dingtalk.ok) expect(dingtalk.config).toEqual({ webhook_url: DINGTALK_WEBHOOK, secret: DINGTALK_SECRET });
    expect(parseChannelInput({
      kind: "dingtalk",
      webhook_url: "https://oapi.dingtalk.com/robot/send",
    }).ok).toBe(false);
    expect(parseChannelInput({
      kind: "dingtalk",
      webhook_url: "http://oapi.dingtalk.com/robot/send?access_token=abcDEF1234567890",
    }).ok).toBe(false);
    expect(parseChannelInput({
      kind: "dingtalk",
      webhook_url: "https://evil.example/robot/send?access_token=abcDEF1234567890",
    }).ok).toBe(false);
    expect(parseChannelInput({
      kind: "dingtalk",
      webhook_url: DINGTALK_WEBHOOK,
      secret: "short",
    }).ok).toBe(false);
    const legacy = parseChannelInput({
      kind: "dingtalk",
      webhook_url: `${DINGTALK_WEBHOOK}&timestamp=1&sign=old`,
    });
    expect(legacy.ok).toBe(true);
    if (legacy.ok) expect((legacy.config as { webhook_url: string }).webhook_url).toBe(DINGTALK_WEBHOOK);
  });

  it("masks Feishu path tokens and DingTalk access tokens", () => {
    const feishu = parseChannelInput({ kind: "feishu", webhook_url: FEISHU_WEBHOOK, secret: FEISHU_SECRET });
    expect(feishu.ok).toBe(true);
    if (feishu.ok) {
      const redacted = redactConfig(feishu.kind, feishu.config);
      expect(JSON.stringify(redacted)).not.toContain("abcd1234-efgh");
      expect(redacted.secret).toBe("****cret");
    }
    const dingtalk = parseChannelInput({ kind: "dingtalk", webhook_url: DINGTALK_WEBHOOK, secret: DINGTALK_SECRET });
    expect(dingtalk.ok).toBe(true);
    if (dingtalk.ok) {
      const redacted = redactConfig(dingtalk.kind, dingtalk.config);
      expect(JSON.stringify(redacted)).not.toContain("abcDEF1234567890");
      expect(JSON.stringify(redacted)).not.toContain(DINGTALK_SECRET);
      expect(redacted.secret).toBe("****cret");
    }
  });

  it("computes Feishu and DingTalk signatures with the official rules", async () => {
    expect(await signFeishu("feishu-secret", 1_700_000_000)).toBe("OrBzY1Y01Gq+HgJsl+7OfWcMVwc7YocohQm5iiZwjhU=");
    expect(await signDingtalk("SECtestsecret", 1_700_000_000_000)).toBe("7LVwF0dAF3/+MRRulbpE4y72Ogzykc6bS2nG4I99T4s=");
  });

  it("builds and signs Feishu interactive card requests", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const results = await deliverChannels(
      [channel({ kind: "feishu", config: { webhook_url: FEISHU_WEBHOOK, secret: FEISHU_SECRET } })],
      { title: "验证码 123456", text: "pixel · 10086\n2026-01-02T03:04:05.000Z\n您的验证码是 123456" },
      {
        fetch: async (input, init) => {
          calls.push({ url: String(input), init: init ?? {} });
          return Response.json({ code: 0 });
        },
        openSmtp: async () => {
          throw new Error("unused");
        },
      },
    );
    expect(results[0]?.ok).toBe(true);
    expect(calls[0]?.url).toBe(FEISHU_WEBHOOK);
    expect(calls[0]?.init.method).toBe("POST");
    expect((calls[0]?.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    const body = JSON.parse(String(calls[0]?.init.body)) as {
      msg_type: string;
      timestamp: string;
      sign: string;
      card: { header: { title: { content: string } }; elements: Array<{ text?: { content: string } }> };
    };
    expect(body.msg_type).toBe("interactive");
    expect(body.card.header.title.content).toBe("验证码 123456");
    expect(body.card.elements[0]?.text?.content).toContain("10086");
    expect(body.timestamp).toBe("1700000000");
    expect(body.sign).toBe("OrBzY1Y01Gq+HgJsl+7OfWcMVwc7YocohQm5iiZwjhU=");
    now.mockRestore();
  });

  it("builds and signs DingTalk ActionCard requests", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const results = await deliverChannels(
      [channel({ kind: "dingtalk", config: { webhook_url: DINGTALK_WEBHOOK, secret: DINGTALK_SECRET } })],
      { title: "验证码 123456", text: "pixel · 10086\n2026-01-02T03:04:05.000Z\n您的验证码是 123456" },
      {
        fetch: async (input, init) => {
          calls.push({ url: String(input), init: init ?? {} });
          return Response.json({ errcode: 0, errmsg: "ok" });
        },
        openSmtp: async () => {
          throw new Error("unused");
        },
      },
    );
    expect(results[0]?.ok).toBe(true);
    const url = new URL(calls[0]?.url ?? "");
    expect(url.origin + url.pathname).toBe("https://oapi.dingtalk.com/robot/send");
    expect(url.searchParams.get("access_token")).toBe("abcDEF1234567890");
    expect(url.searchParams.get("timestamp")).toBe("1700000000000");
    expect(url.searchParams.get("sign")).toBe("7LVwF0dAF3/+MRRulbpE4y72Ogzykc6bS2nG4I99T4s=");
    const body = JSON.parse(String(calls[0]?.init.body)) as {
      msgtype: string;
      actionCard: { title: string; text: string };
    };
    expect(body.msgtype).toBe("actionCard");
    expect(body.actionCard.title).toBe("验证码 123456");
    expect(body.actionCard.text).toContain("10086");
    expect(body.actionCard.text).toContain("您的验证码是 123456");
    now.mockRestore();
  });

  it("treats provider error codes as failures without leaking webhook secrets", async () => {
    const results = await deliverChannels(
      [
        channel({ kind: "feishu", config: { webhook_url: FEISHU_WEBHOOK, secret: FEISHU_SECRET } }),
        channel({
          id: "22222222-2222-4222-8222-222222222222",
          kind: "dingtalk",
          config: { webhook_url: DINGTALK_WEBHOOK, secret: DINGTALK_SECRET },
        }),
      ],
      { title: "测试", text: "不含短信" },
      {
        fetch: async (input) => {
          if (String(input).includes("open.feishu.cn")) {
            return Response.json({ code: 19001, msg: "bad request" });
          }
          return Response.json({ errcode: 310000, errmsg: "bad request" });
        },
        openSmtp: async () => {
          throw new Error("unused");
        },
      },
    );
    expect(results.map((result) => result.ok)).toEqual([false, false]);
    expect(results[0]?.error).toBe("飞书拒绝了这条通知");
    expect(results[1]?.error).toBe("钉钉拒绝了这条通知");
    expect(JSON.stringify(results)).not.toContain(FEISHU_SECRET);
    expect(JSON.stringify(results)).not.toContain(DINGTALK_SECRET);
    expect(JSON.stringify(results)).not.toContain("abcDEF1234567890");
  });
});

describe("delivery", () => {
  it("default deps invoke fetch through a wrapper, never as a bare global", async () => {
    // workerd rejects deps.fetch(...) when deps.fetch IS the global
    // fetch ("Illegal invocation"); defaultDeps must hand out a
    // wrapper that is safe to call as another object's method.
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown) => {
      seen.push(String(input));
      return new Response("{}", { status: 200 });
    });
    try {
      const deps = defaultDeps();
      const holder: { f: typeof deps.fetch } = { f: deps.fetch };
      await holder.f("https://example.com/hook");
      expect(seen).toEqual(["https://example.com/hook"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

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
      messageId: "sms-123",
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

  it("stores an optional remark on create and updates it via PATCH", async () => {
    const headers = { cookie: "smsinbox_session=sms_session_token_value", "content-type": "application/json" };
    const created = await handleApi(
      new Request("https://sms.example/api/v1/notifications", {
        method: "POST",
        headers,
        body: JSON.stringify({ kind: "telegram", bot_token: TOKEN, chat_id: "42", note: "  主力 TG  " }),
      }),
      authedEnv(fakeDb({ first: sessionUser() })),
    );
    expect(created.status).toBe(200);
    expect((await created.json() as { channel: { note: string } }).channel.note).toBe("主力 TG");

    const id = "11111111-1111-4111-8111-111111111111";
    const patched = await handleApi(
      new Request(`https://sms.example/api/v1/notifications/${id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ note: "备用" }),
      }),
      authedEnv(fakeDb({ first: sessionUser() })),
    );
    expect(patched.status).toBe(200);
    expect((await patched.json() as { note: string }).note).toBe("备用");

    const tooLong = await handleApi(
      new Request(`https://sms.example/api/v1/notifications/${id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ note: "长".repeat(81) }),
      }),
      authedEnv(fakeDb({ first: sessionUser() })),
    );
    expect(tooLong.status).toBe(400);

    expect(channelFromRow(row({ note: "备注" }))?.note).toBe("备注");
    expect(channelFromRow(row())?.note).toBe("");
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

  it("lists push history newest first with pagination and boolean outcomes", async () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const entries = [
      { id: "new", created_at: 20, channel_name: "主力", channel_kind: "bark", source: "sms", message_id: "sms-2", sender: "10086", preview: "new", ok: 1, error: null },
      { id: "old", created_at: 10, channel_name: "备用", channel_kind: "email", source: "test", message_id: null, sender: null, preview: "old", ok: 0, error: "failed" },
    ];
    const db = {
      prepare(sql: string) {
        let args: unknown[] = [];
        const statement = {
          bind(...values: unknown[]) {
            args = values;
            return statement;
          },
          async first() {
            if (sql.includes("FROM sessions s")) return sessionUser();
            if (sql.includes("COUNT(*) AS total FROM push_logs")) return { total: 7 };
            return null;
          },
          async all() {
            calls.push({ sql, args });
            return { results: entries };
          },
          async run() {
            return { meta: { changes: 1 } };
          },
        };
        return statement;
      },
    } as unknown as D1Database;
    const response = await handleApi(
      new Request("https://sms.example/api/v1/notify/history?limit=2&offset=1", {
        headers: { cookie: "smsinbox_session=sms_session_token_value" },
      }),
      authedEnv(db),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; total: number; items: Array<{ id: string; ok: boolean }> };
    expect(body).toMatchObject({
      ok: true,
      total: 7,
      items: [{ id: "new", ok: true }, { id: "old", ok: false }],
    });
    expect(calls[0]?.sql).toContain("ORDER BY created_at DESC");
    expect(calls[0]?.args).toEqual(["user-1", 2, 1]);
  });

  it("records test-send outcomes with channel snapshots", async () => {
    const stored: unknown[][] = [];
    const bark = row({
      kind: "bark",
      note: "备用 Bark",
      config: JSON.stringify({ device_key: "abcd1234", server: "https://api.day.app" }),
    });
    const db = {
      prepare(sql: string) {
        let args: unknown[] = [];
        const statement = {
          bind(...values: unknown[]) {
            args = values;
            return statement;
          },
          async first() {
            if (sql.includes("FROM sessions s")) return sessionUser();
            if (sql.includes("FROM notify_channels")) return bark;
            return null;
          },
          async all() {
            return { results: [] };
          },
          async run() {
            stored.push(args);
            return { meta: { changes: 1 } };
          },
        };
        return statement;
      },
    } as unknown as D1Database;
    vi.stubGlobal("fetch", async () => Response.json({ code: 200 }));
    try {
      const response = await handleApi(
        new Request("https://sms.example/api/v1/notifications/11111111-1111-4111-8111-111111111111/test", {
          method: "POST",
          headers: {
            cookie: "smsinbox_session=sms_session_token_value",
            "content-type": "application/json",
          },
          body: "{}",
        }),
        authedEnv(db),
      );
      expect(response.status).toBe(200);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(stored).toHaveLength(1);
    expect(stored[0]?.slice(1, 8)).toEqual([
      "user-1",
      bark.id,
      "备用 Bark",
      "bark",
      "test",
      null,
      null,
    ]);
    expect(stored[0]?.[8]).toBe("这是一条测试通知，不包含短信内容。");
    expect(stored[0]?.[9]).toBe(1);
    expect(stored[0]?.[10]).toBeNull();
  });
});

describe("push history recording", () => {
  it("stores successful and failed SMS results with safe snapshot fields", async () => {
    const stored: unknown[][] = [];
    const rows = [
      row({
        kind: "bark",
        note: "主要渠道",
        config: JSON.stringify({ device_key: "abcd1234", server: "https://api.day.app" }),
      }),
      row({
        id: "22222222-2222-4222-8222-222222222222",
        kind: "bark",
        note: "备用渠道",
        config: JSON.stringify({ device_key: "efgh5678", server: "https://api.day.app" }),
      }),
    ];
    const db = {
      prepare() {
        let args: unknown[] = [];
        const statement = {
          bind(...values: unknown[]) {
            args = values;
            return statement;
          },
          async first() {
            return null;
          },
          async all() {
            return { results: rows };
          },
          async run() {
            stored.push(args);
            return { meta: { changes: 1 } };
          },
        };
        return statement;
      },
    } as unknown as D1Database;
    let attempts = 0;
    const results = await notifyStoredSms(authedEnv(db), "user-1", {
      messageId: "sms-123",
      from: "10086",
      content: "验证码 123456",
      code: "123456",
      deviceName: "pixel",
      receivedAt: 1_700_000_000_000,
    }, {
      fetch: async () => {
        attempts += 1;
        if (attempts === 1) return Response.json({ code: 200 });
        throw new Error("provider key=private");
      },
      openSmtp: async () => {
        throw new Error("unused");
      },
    });
    expect(results.map((result) => result.ok)).toEqual([true, false]);
    expect(stored).toHaveLength(2);
    expect(stored[0]?.slice(1, 8)).toEqual([
      "user-1",
      rows[0]?.id,
      "主要渠道",
      "bark",
      "sms",
      "sms-123",
      "10086",
    ]);
    expect(stored[0]?.[8]).toContain("验证码 123456");
    expect(stored[0]?.[9]).toBe(1);
    expect(stored[0]?.[10]).toBeNull();
    expect(stored[1]?.[3]).toBe("备用渠道");
    expect(stored[1]?.[9]).toBe(0);
    expect(stored[1]?.[10]).toBe("provider key=***");
  });

  it("logs history-write failures without changing delivery results", async () => {
    const channelRow = row({
      kind: "bark",
      config: JSON.stringify({ device_key: "abcd1234", server: "https://api.day.app" }),
    });
    const db = {
      prepare() {
        const statement = {
          bind() {
            return statement;
          },
          async first() {
            return null;
          },
          async all() {
            return { results: [channelRow] };
          },
          async run() {
            throw new Error("database unavailable");
          },
        };
        return statement;
      },
    } as unknown as D1Database;
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line) => errors.push(String(line)));
    try {
      const results = await notifyStoredSms(authedEnv(db), "user-1", {
        messageId: "sms-123",
        from: "10086",
        content: "短信正文",
        code: null,
        deviceName: "pixel",
        receivedAt: 1_700_000_000_000,
      }, {
        fetch: async () => Response.json({ code: 200 }),
        openSmtp: async () => {
          throw new Error("unused");
        },
      });
      expect(results).toEqual([{ id: channelRow.id, kind: "bark", ok: true }]);
    } finally {
      spy.mockRestore();
    }
    expect(errors.join("")).toContain("push_log_insert_failed");
    expect(errors.join("")).toContain("database unavailable");
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
