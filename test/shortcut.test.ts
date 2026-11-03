import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { bytesToBase64Url } from "../src/auth";
import { ENCRYPTED_PREFIX } from "../src/crypto";
import { extractCode } from "../src/extract";
import { handleApi } from "../src/routes/api";
import { buildTestSms } from "../src/routes/sms";
import {
  buildShortcut,
  PLACEHOLDER_WEBHOOK,
  shortcutFilename,
} from "../src/shortcut";

const DEVICE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COOKIE = "smsinbox_session=sms_session_token_value";

function sessionRow() {
  return {
    id: DEVICE_ID,
    username: "admin",
    role: "admin",
    expires_at: Date.now() + 60_000,
    name: "iphone",
  };
}

function scriptedDb(firsts: unknown[], failInsert = false) {
  const state = { runs: 0, binds: [] as unknown[][] };
  const db = {
    prepare(sql: string) {
      const statement = {
        bind(...args: unknown[]) {
          state.binds.push(args);
          return statement;
        },
        async first() {
          return firsts.shift() ?? null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          state.runs += 1;
          if (failInsert && sql.includes("INSERT INTO messages")) {
            throw new Error("UNIQUE constraint failed: messages.content_hash");
          }
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { db, state };
}

function envFor(db: D1Database, contentKey = ""): Env {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response("") },
    RETENTION_DAYS: "90",
    CONTENT_KEY: contentKey,
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "secret",
  } as unknown as Env;
}

function actionIdentifiers(plist: string): string[] {
  return [...plist.matchAll(/<key>WFWorkflowActionIdentifier<\/key>\s*<string>([^<]+)<\/string>/g)].map(
    (match) => match[1],
  );
}

function flowModes(plist: string): Map<string, number[]> {
  const modes = new Map<string, number[]>();
  const pattern =
    /<key>GroupingIdentifier<\/key>\s*<string>([^<]+)<\/string>\s*<key>WFControlFlowMode<\/key>\s*<integer>(\d+)<\/integer>/g;
  for (const match of plist.matchAll(pattern)) {
    const list = modes.get(match[1]) ?? [];
    list.push(Number(match[2]));
    modes.set(match[1], list);
  }
  return modes;
}

const UNIFIED_ACTIONS = [
  "is.workflow.actions.comment",
  "is.workflow.actions.gettext",
  "is.workflow.actions.conditional",
  "is.workflow.actions.notification",
  "is.workflow.actions.exit",
  "is.workflow.actions.conditional",
  "is.workflow.actions.conditional",
  "is.workflow.actions.gettext",
  "is.workflow.actions.setvariable",
  "is.workflow.actions.conditional",
  "is.workflow.actions.setvariable",
  "is.workflow.actions.conditional",
  "is.workflow.actions.downloadurl",
  "is.workflow.actions.conditional",
  "is.workflow.actions.notification",
  "is.workflow.actions.exit",
  "is.workflow.actions.conditional",
  "is.workflow.actions.conditional",
  "is.workflow.actions.notification",
  "is.workflow.actions.exit",
  "is.workflow.actions.conditional",
  "is.workflow.actions.conditional",
  "is.workflow.actions.notification",
  "is.workflow.actions.exit",
  "is.workflow.actions.conditional",
  "is.workflow.actions.conditional",
  "is.workflow.actions.notification",
  "is.workflow.actions.exit",
  "is.workflow.actions.conditional",
  "is.workflow.actions.notification",
];

describe("shortcut plist", () => {
  it("builds one unsigned template that posts to the push link", () => {
    const plist = buildShortcut("all");
    expect(plist).toBe(buildShortcut("all", "https://sms.example/api/v1/sms"));
    expect(plist.startsWith("<?xml version=\"1.0\" encoding=\"UTF-8\"?>")).toBe(true);
    expect(plist).toContain("WFWorkflowImportQuestions");
    expect(plist).toContain("<string>推送链接</string>");
    expect(plist).toContain("is.workflow.actions.downloadurl");
    expect(plist).toContain("<string>POST</string>");
    expect(plist).toContain("<string>application/json</string>");
    expect(plist).not.toContain("<string>Authorization</string>");
    expect(plist).not.toContain("Bearer \uFFFC");
    expect(plist).not.toContain("Webhook URL");
    expect(plist).not.toContain("设备 Token");
    expect(plist).not.toMatch(/<key>ActionIndex<\/key>\s*<integer>2<\/integer>/);
    for (const field of ["from", "content", "timestamp", "device"]) {
      expect(plist).toContain(`<string>${field}</string>`);
    }
    expect(plist).toContain("ExtensionInput");
    expect(plist).toContain("Sender");
    expect(plist).toContain("CurrentDate");
    expect(plist).not.toContain(PLACEHOLDER_WEBHOOK);
    expect(plist).not.toContain("/api/v1/sms");
    expect(plist).not.toContain("/api/v1/ingest/");
    expect(plist).toContain("信息包含一个空格");
    expect(plist).toContain("SMSinBox Next");
    expect(plist).toContain("信息 › 内容");
    expect(plist).toContain("默认关闭");
    expect(plist).toContain("立即运行");
    expect(plist).not.toContain("icloud.com");
    expect(plist).not.toContain("尚未发布");
    expect(shortcutFilename("all")).toBe("SMSinBox-iOS.shortcut");
  });

  it("stops on an empty body, fills an empty sender, and names 401, 429, and network failures", () => {
    const plist = buildShortcut("all");
    expect(actionIdentifiers(plist)).toEqual(UNIFIED_ACTIONS);
    expect(plist.match(/is\.workflow\.actions\.downloadurl/g)).toHaveLength(1);
    const downloadAt = plist.indexOf("is.workflow.actions.downloadurl");
    const emptyBody = plist.indexOf("<string>未发送：正文为空</string>");
    const sent = plist.indexOf("<string>已转发</string>");
    const limited = plist.indexOf("<string>未写入：请求过于频繁（429）。请稍后再试。</string>");
    const denied = plist.indexOf("<string>未写入：推送链接无效或已撤销（401）。请在设备页轮换后重贴链接。</string>");
    const rejected = plist.indexOf("<string>未写入：服务器拒绝了这条短信。</string>");
    const offline = plist.indexOf("<string>未发送：网络失败，或返回的不是 JSON。");
    expect(emptyBody).toBeGreaterThan(0);
    expect(emptyBody).toBeLessThan(downloadAt);
    expect(downloadAt).toBeLessThan(limited);
    expect(limited).toBeLessThan(denied);
    expect(denied).toBeLessThan(rejected);
    expect(rejected).toBeLessThan(offline);
    expect(offline).toBeLessThan(sent);
    expect(plist).toContain("<string>（发件人为空）</string>");
    expect(plist).toContain("<string>发件人</string>");
    expect(plist).toContain("<integer>101</integer>");
    expect(plist).toContain("<integer>999</integer>");
    expect(plist).toContain("<string>false</string>");
    expect(plist).toContain("<string>请求过于频繁</string>");
    expect(plist).toContain("WFStringContentItem");
    for (const modes of flowModes(plist).values()) {
      expect(modes[0]).toBe(0);
      expect(modes[modes.length - 1]).toBe(2);
      expect(modes.every((mode) => mode === 0 || mode === 1 || mode === 2)).toBe(true);
    }
    const questions = plist.slice(plist.indexOf("<key>WFWorkflowImportQuestions</key>"));
    expect(questions.match(/<key>ActionIndex<\/key>/g)).toHaveLength(1);
    expect(questions).toContain("<integer>1</integer>");
  });

  it("stops the verification-code template unless the message matches", () => {
    const plist = buildShortcut("code");
    expect(plist).toContain("验证码");
    expect(plist).toContain("<string>code</string>");
    expect(plist).toContain("is.workflow.actions.conditional");
    expect(plist).toContain("is.workflow.actions.exit");
    expect(plist.indexOf("22222222-2222-4222-8222-222222222222")).toBeLessThan(
      plist.indexOf("is.workflow.actions.conditional"),
    );
    expect(plist.indexOf("is.workflow.actions.conditional")).toBeLessThan(
      plist.indexOf("is.workflow.actions.downloadurl"),
    );
    expect(plist).toContain("<key>ActionIndex</key>");
    expect(plist).toContain("<integer>1</integer>");
    expect(plist).toContain("<integer>2</integer>");
    expect(plist).not.toContain("（发件人为空）");
    expect(plist).not.toContain("未发送：正文为空");
    expect(plist).not.toContain("（429）");
    expect(plist).not.toContain("（401）");
    expect(actionIdentifiers(plist)).toEqual([
      "is.workflow.actions.comment",
      "is.workflow.actions.gettext",
      "is.workflow.actions.gettext",
      "is.workflow.actions.gettext",
      "is.workflow.actions.conditional",
      "is.workflow.actions.conditional",
      "is.workflow.actions.conditional",
      "is.workflow.actions.conditional",
      "is.workflow.actions.exit",
      "is.workflow.actions.conditional",
      "is.workflow.actions.conditional",
      "is.workflow.actions.downloadurl",
      "is.workflow.actions.notification",
    ]);
    expect(shortcutFilename("code")).toBe("SMSinBox-iOS-code.shortcut");
  });

  it("matches the committed unsigned templates and refuses a non-http URL", () => {
    expect(readFileSync("shortcuts/SMSinBox-iOS.shortcut", "utf8")).toBe(buildShortcut("all"));
    expect(readFileSync("shortcuts/SMSinBox-iOS-code.shortcut", "utf8")).toBe(buildShortcut("code"));
    const rejected = buildShortcut("code", "javascript:alert(1)");
    expect(rejected).not.toContain("javascript");
    expect(rejected).toContain(PLACEHOLDER_WEBHOOK);
    expect(buildShortcut("code", "https://user:pass@example.com/hook")).toBe(buildShortcut("code"));
    expect(buildShortcut("all", "javascript:alert(1)")).toBe(buildShortcut("all"));
    expect(buildShortcut("code", "https://sms.example/api/v1/sms")).toContain("https://sms.example/api/v1/sms");
  });
});

describe("iOS shortcut download", () => {
  it("requires a session and rejects an unknown variant", async () => {
    const missing = await handleApi(
      new Request("https://sms.example/api/v1/ios/shortcut"),
      envFor(scriptedDb([]).db),
    );
    expect(missing.status).toBe(401);

    const unknown = await handleApi(
      new Request("https://sms.example/api/v1/ios/shortcut?variant=nope", { headers: { cookie: COOKIE } }),
      envFor(scriptedDb([sessionRow()]).db),
    );
    expect(unknown.status).toBe(400);
  });

  it("downloads a template for this origin without a device token", async () => {
    const response = await handleApi(
      new Request("https://sms.example/api/v1/ios/shortcut", { headers: { cookie: COOKIE } }),
      envFor(scriptedDb([sessionRow()]).db),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="SMSinBox-iOS.shortcut"');
    const body = await response.text();
    expect(body).toBe(buildShortcut("all"));
    expect(body).not.toContain("https://sms.example");
    expect(body).not.toContain("/api/v1/sms");
    expect(body).not.toContain("/api/v1/ingest/");
    expect(body).not.toContain("sms_session_token_value");
    expect(body).not.toMatch(/psh_[A-Za-z0-9_-]{8,}/);
    expect(body).not.toMatch(/Bearer [A-Za-z0-9_-]{8,}/);
    expect(body).toContain("未发送：正文为空");
    expect(body).toContain("（429）");
    expect(body).toContain("（401）");
    expect(body).not.toContain("icloud.com");
  });

  it("still downloads the keyword template", async () => {
    const response = await handleApi(
      new Request("https://sms.example/api/v1/ios/shortcut?variant=code", { headers: { cookie: COOKIE } }),
      envFor(scriptedDb([sessionRow()]).db),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="SMSinBox-iOS-code.shortcut"');
    const body = await response.text();
    expect(body).toBe(buildShortcut("code", "https://sms.example/api/v1/sms"));
    expect(body).toContain("https://sms.example/api/v1/sms");
    expect(body).toContain("<string>Authorization</string>");
    expect(body).not.toContain("sms_session_token_value");
    expect(body).not.toMatch(/psh_[A-Za-z0-9_-]{8,}/);
  });
});

describe("device test message", () => {
  it("extracts the fixed verification code", () => {
    expect(extractCode(buildTestSms("ab12cd34"))).toBe("654321");
  });

  it("stores a test sms and does not log the body", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line) => {
      logs.push(String(line));
    });
    const script = scriptedDb([sessionRow(), sessionRow()]);
    const jobs: Promise<unknown>[] = [];
    const response = await handleApi(
      new Request(`https://sms.example/api/v1/devices/${DEVICE_ID}/test`, {
        method: "POST",
        headers: { cookie: COOKIE, "content-type": "application/json" },
        body: "{}",
      }),
      envFor(script.db),
      { waitUntil: (job) => jobs.push(job) },
    );
    await Promise.all(jobs);
    spy.mockRestore();
    expect(response.status).toBe(200);
    const payload = await response.json() as { ok: boolean; id: string; code: string };
    expect(payload.ok).toBe(true);
    expect(payload.code).toBe("654321");
    expect(JSON.stringify(payload)).not.toContain("序号");
    const inserted = script.state.binds.find((args) => args.includes("SMSinBox"));
    expect(inserted?.[11]).toBe(0);
    expect(String(inserted?.[4])).toContain("654321");
    expect(logs.join("")).not.toContain("654321");
    expect(script.state.runs).toBeGreaterThanOrEqual(2);
  });

  it("encrypts the stored test sms when CONTENT_KEY is set", async () => {
    const key = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const script = scriptedDb([sessionRow(), sessionRow()]);
    const jobs: Promise<unknown>[] = [];
    const response = await handleApi(
      new Request(`https://sms.example/api/v1/devices/${DEVICE_ID}/test`, {
        method: "POST",
        headers: { cookie: COOKIE, "content-type": "application/json" },
        body: "{}",
      }),
      envFor(script.db, key),
      { waitUntil: (job) => jobs.push(job) },
    );
    await Promise.all(jobs);
    expect(response.status).toBe(200);
    const inserted = script.state.binds.find((args) => args[11] === 1);
    expect(String(inserted?.[4]).startsWith(ENCRYPTED_PREFIX)).toBe(true);
    expect(String(inserted?.[6]).startsWith(ENCRYPTED_PREFIX)).toBe(true);
  });

  it("refuses an invalid content key, a missing device, and an anonymous caller", async () => {
    const invalid = scriptedDb([sessionRow(), sessionRow()]);
    const rejected = await handleApi(
      new Request(`https://sms.example/api/v1/devices/${DEVICE_ID}/test`, {
        method: "POST",
        headers: { cookie: COOKIE, "content-type": "application/json" },
        body: "{}",
      }),
      envFor(invalid.db, "not-a-key"),
    );
    expect(rejected.status).toBe(500);
    expect(invalid.state.runs).toBe(0);

    const missingDevice = await handleApi(
      new Request(`https://sms.example/api/v1/devices/${DEVICE_ID}/test`, {
        method: "POST",
        headers: { cookie: COOKIE, "content-type": "application/json" },
        body: "{}",
      }),
      envFor(scriptedDb([sessionRow(), null]).db),
    );
    expect(missingDevice.status).toBe(404);

    const anonymous = await handleApi(
      new Request(`https://sms.example/api/v1/devices/${DEVICE_ID}/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      envFor(scriptedDb([]).db),
    );
    expect(anonymous.status).toBe(401);
  });
});
