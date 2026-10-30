import type { SmsInput } from "./types";

export const MAX_CONTENT_LENGTH = 8_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;

export type ParseResult = { ok: true; sms: SmsInput } | { ok: false; error: string };

export function parseSmsPayload(contentType: string | null, body: string, now: number): ParseResult {
  const text = body.replace(/^\uFEFF/, "");
  const fields = readFields(contentType, text);
  if (!fields.ok) return fields;

  const content = pick(fields.map, ["content", "text", "msg", "body", "sms"]);
  if (!content) return { ok: false, error: "缺少短信内容" };
  if (content.length > MAX_CONTENT_LENGTH) return { ok: false, error: "短信内容过长" };

  const timestamp = pick(fields.map, ["timestamp", "receive_time"]);
  return {
    ok: true,
    sms: {
      from: clip(pick(fields.map, ["from", "sender"]) ?? "", 80),
      to: clip(pick(fields.map, ["to"]) ?? "", 80),
      content,
      deviceName: clip(pick(fields.map, ["device"]) ?? "", 64),
      sim: clip(pick(fields.map, ["sim"]) ?? "", 32),
      receivedAt: resolveReceivedAt(timestamp, now),
    },
  };
}

export function resolveReceivedAt(raw: string | undefined, now: number): number {
  if (!raw?.trim()) return now;
  const trimmed = raw.trim();
  let millis: number;
  if (/^\d{1,16}(\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) return now;
    millis = numeric < 1e12 ? Math.round(numeric * 1000) : Math.round(numeric);
  } else {
    let iso = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(iso)) iso += "Z";
    millis = Date.parse(iso);
    if (Number.isNaN(millis)) return now;
  }
  if (millis < now - WEEK_MS || millis > now + FUTURE_SKEW_MS) return now;
  return millis;
}

export function buildRawPayload(body: string, sms: SmsInput): string {
  return JSON.stringify({
    sim: sms.sim,
    device: sms.deviceName,
    body,
  });
}

export function readRawMeta(raw: string | null): { sim: string; device: string } {
  if (!raw) return { sim: "", device: "" };
  try {
    const value = JSON.parse(raw) as { sim?: unknown; device?: unknown };
    return {
      sim: typeof value.sim === "string" ? value.sim : "",
      device: typeof value.device === "string" ? value.device : "",
    };
  } catch {
    return { sim: "", device: "" };
  }
}

function readFields(
  contentType: string | null,
  body: string,
): { ok: true; map: Map<string, string> } | { ok: false; error: string } {
  const kind = payloadKind(contentType, body);
  if (kind === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { ok: false, error: "JSON 无法解析" };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "JSON 必须是对象" };
    }
    return { ok: true, map: collect(parsed as Record<string, unknown>) };
  }
  if (kind === "form") {
    const map = new Map<string, string>();
    for (const [key, value] of new URLSearchParams(body).entries()) {
      const lower = key.toLowerCase();
      if (!map.has(lower)) map.set(lower, value);
    }
    return { ok: true, map };
  }
  return { ok: false, error: "仅支持 JSON 或 form-urlencoded" };
}

function payloadKind(contentType: string | null, body: string): "json" | "form" | "unknown" {
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mediaType === "application/json" || mediaType.endsWith("+json")) return "json";
  if (mediaType === "application/x-www-form-urlencoded") return "form";
  const trimmed = body.trim();
  if (!mediaType || mediaType === "text/plain" || mediaType === "application/octet-stream") {
    if (trimmed.startsWith("{")) return "json";
    if (trimmed.includes("=")) return "form";
  }
  return "unknown";
}

function collect(input: Record<string, unknown>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(input)) {
    const text = asText(value);
    if (text === undefined) continue;
    const lower = key.toLowerCase();
    if (!map.has(lower)) map.set(lower, text);
  }
  return map;
}

function pick(map: Map<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = map.get(key);
    if (value !== undefined && value.trim() !== "") return value;
  }
  return undefined;
}

function asText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}
