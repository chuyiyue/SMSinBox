import { describe, expect, it } from "vitest";
import { parseSmsPayload, resolveReceivedAt } from "../src/parse";

const NOW = Date.parse("2026-10-31T00:00:00Z");

describe("parseSmsPayload", () => {
  it("reads the SmsForwarder JSON template and field aliases", () => {
    const primary = parseSmsPayload(
      "application/json",
      JSON.stringify({
        from: "10086",
        content: "验证码 123456",
        timestamp: "2026-10-30 12:00:00",
        device: "Pixel",
        sim: "1",
        to: "13800138000",
      }),
      NOW,
    );
    expect(primary.ok).toBe(true);
    if (!primary.ok) return;
    expect(primary.sms).toMatchObject({
      from: "10086",
      content: "验证码 123456",
      deviceName: "Pixel",
      sim: "1",
      to: "13800138000",
      receivedAt: Date.parse("2026-10-30T12:00:00Z"),
    });

    const aliased = parseSmsPayload(
      "application/json; charset=utf-8",
      JSON.stringify({
        sender: "CMCC",
        msg: "alias body",
        receive_time: Math.floor((NOW - 3_600_000) / 1000),
      }),
      NOW,
    );
    expect(aliased.ok).toBe(true);
    if (!aliased.ok) return;
    expect(aliased.sms.from).toBe("CMCC");
    expect(aliased.sms.content).toBe("alias body");
    expect(aliased.sms.receivedAt).toBe(NOW - 3_600_000);

    const textAlias = parseSmsPayload("application/json", JSON.stringify({ text: "from text", body: "" }), NOW);
    expect(textAlias.ok).toBe(true);
    if (textAlias.ok) expect(textAlias.sms.content).toBe("from text");
    const smsAlias = parseSmsPayload("application/json", JSON.stringify({ sms: "from sms" }), NOW);
    expect(smsAlias.ok).toBe(true);
    if (smsAlias.ok) expect(smsAlias.sms.content).toBe("from sms");
  });

  it("prefers content over other body aliases", () => {
    const parsed = parseSmsPayload(
      "application/json",
      JSON.stringify({ content: "primary", text: "secondary", msg: "third", body: "fourth", sms: "fifth" }),
      NOW,
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.sms.content).toBe("primary");
  });

  it("reads form-urlencoded bodies", () => {
    const body = new URLSearchParams({
      sender: "10010",
      content: "验证码8888",
      receive_time: "2026-10-30T08:00:00Z",
      sim: "2",
    });
    const parsed = parseSmsPayload("application/x-www-form-urlencoded", body.toString(), NOW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.sms.from).toBe("10010");
    expect(parsed.sms.content).toBe("验证码8888");
    expect(parsed.sms.sim).toBe("2");
    expect(parsed.sms.receivedAt).toBe(Date.parse("2026-10-30T08:00:00Z"));
  });

  it("sniffs JSON when the content type is missing", () => {
    const parsed = parseSmsPayload(null, '{"from":"a","content":"hello"}', NOW);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.sms.content).toBe("hello");
  });

  it("rejects missing, empty, and invalid payloads", () => {
    expect(parseSmsPayload("application/json", "{}", NOW)).toEqual({ ok: false, error: "缺少短信内容" });
    expect(parseSmsPayload("application/json", '{"content":"   "}', NOW)).toEqual({
      ok: false,
      error: "缺少短信内容",
    });
    expect(parseSmsPayload("application/json", "{", NOW)).toEqual({ ok: false, error: "JSON 无法解析" });
    expect(parseSmsPayload("application/json", "[]", NOW)).toEqual({ ok: false, error: "JSON 必须是对象" });
    expect(parseSmsPayload("text/xml", "<sms/>", NOW)).toEqual({
      ok: false,
      error: "仅支持 JSON 或 form-urlencoded",
    });
    expect(parseSmsPayload("application/json", JSON.stringify({ content: "x".repeat(8001) }), NOW).ok).toBe(false);
  });

  it("uses the server time when the device timestamp is missing or far away", () => {
    const missing = parseSmsPayload("application/json", '{"content":"hi","from":"a"}', NOW);
    expect(missing.ok).toBe(true);
    if (missing.ok) expect(missing.sms.receivedAt).toBe(NOW);
    expect(resolveReceivedAt("2020-01-01 00:00:00", NOW)).toBe(NOW);
    expect(resolveReceivedAt("not-a-date", NOW)).toBe(NOW);
    expect(resolveReceivedAt(String(Math.floor(NOW / 1000)), NOW)).toBe(NOW);
  });
});
