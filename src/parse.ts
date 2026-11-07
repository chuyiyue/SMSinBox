import type { SmsInput } from "./types";

export const MAX_CONTENT_LENGTH = 8_000;
// Any real SMS can be forwarded late (offline phone, delayed automation), so
// do not clamp old device timestamps to "now". Only clearly bogus values fall
// back: unparsable input, dates before 2000, or a clock more than 5 minutes
// ahead. The fallback is marked in raw_payload as received_at_source=server.
const MIN_DEVICE_TIME_MS = Date.UTC(2000, 0, 1);
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
  const received = resolveReceivedAtWithSource(timestamp, now);
  return {
    ok: true,
    sms: {
      from: clip(pick(fields.map, ["from", "sender"]) ?? "", 80),
      to: clip(pick(fields.map, ["to"]) ?? "", 80),
      content,
      sim: clip(pick(fields.map, ["sim"]) ?? "", 32),
      receivedAt: received.receivedAt,
      receivedAtSource: received.source,
    },
  };
}

export function resolveReceivedAtWithSource(
  raw: string | undefined,
  now: number,
): { receivedAt: number; source: "device" | "server" } {
  const millis = parseDeviceTime(raw);
  if (millis === null || millis > now + FUTURE_SKEW_MS || millis < MIN_DEVICE_TIME_MS) {
    return { receivedAt: now, source: "server" };
  }
  return { receivedAt: millis, source: "device" };
}

export function resolveReceivedAt(raw: string | undefined, now: number): number {
  return resolveReceivedAtWithSource(raw, now).receivedAt;
}

function parseDeviceTime(raw: string | undefined): number | null {
  if (!raw?.trim()) return null;
  const trimmed = raw.trim();
  if (/^\d{1,16}(\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) return null;
    return numeric < 1e12 ? Math.round(numeric * 1000) : Math.round(numeric);
  }
  let iso = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(iso)) iso += "Z";
  const millis = Date.parse(iso);
  return Number.isNaN(millis) ? null : millis;
}

export function buildRawPayload(body: string, sms: SmsInput): string {
  return JSON.stringify({
    sim: sms.sim,
    received_at: sms.receivedAt,
    received_at_source: sms.receivedAtSource,
    body,
  });
}

export function readRawMeta(raw: string | null): {
  sim: string;
  receivedAtSource: "device" | "server" | "unknown";
} {
  // A device string may still sit in raw_payload. It is not read back: the
  // device name and type come from the saved device row.
  if (!raw) return { sim: "", receivedAtSource: "unknown" };
  try {
    const value = JSON.parse(raw) as { sim?: unknown; received_at_source?: unknown };
    return {
      sim: typeof value.sim === "string" ? value.sim : "",
      // Rows written before the source marker existed cannot be classified
      // reliably, so say unknown instead of guessing.
      receivedAtSource:
        value.received_at_source === "device" || value.received_at_source === "server"
          ? value.received_at_source
          : "unknown",
    };
  } catch {
    return { sim: "", receivedAtSource: "unknown" };
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
