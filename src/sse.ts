import type { MessageView } from "./types";

export const SSE_POLL_MS = 2_000;
export const SSE_HOLD_MS = 25_000;
export const SSE_BATCH = 20;

export interface SseCursor {
  createdAt: number;
  id: string;
}

const CURSOR_RE = /^(\d{1,16}):([0-9a-f-]{0,36})$/i;

export function encodeCursor(cursor: SseCursor): string {
  return `${cursor.createdAt}:${cursor.id}`;
}

export function parseCursor(value: string | null | undefined): SseCursor | null {
  if (!value) return null;
  const match = CURSOR_RE.exec(value.trim());
  if (!match?.[1]) return null;
  const createdAt = Number(match[1]);
  if (!Number.isSafeInteger(createdAt)) return null;
  return { createdAt, id: (match[2] ?? "").toLowerCase() };
}

export function resolveCursor(lastEventId: string | null, queryCursor: string | null, now: number): SseCursor {
  return parseCursor(lastEventId) ?? parseCursor(queryCursor) ?? { createdAt: now, id: "" };
}

export function isAfterCursor(message: { created_at: number; id: string }, cursor: SseCursor): boolean {
  if (message.created_at > cursor.createdAt) return true;
  if (message.created_at < cursor.createdAt) return false;
  return message.id > cursor.id;
}

export function advanceCursor(cursor: SseCursor, message: { created_at: number; id: string }): SseCursor {
  if (!isAfterCursor(message, cursor)) return cursor;
  return { createdAt: message.created_at, id: message.id };
}

export function formatSseComment(text: string): string {
  return `: ${oneLine(text)}\n\n`;
}

export function formatSseEvent(event: string, data: unknown, id?: string): string {
  const payload = JSON.stringify(data) ?? "null";
  const lines: string[] = [];
  if (id) lines.push(`id: ${oneLine(id)}`);
  lines.push(`event: ${oneLine(event)}`);
  for (const line of payload.split("\n")) lines.push(`data: ${line}`);
  return `${lines.join("\n")}\n\n`;
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export function createInboxStream(options: {
  cursor: SseCursor;
  signal: AbortSignal;
  poll: (cursor: SseCursor) => Promise<MessageView[]>;
  holdMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): ReadableStream<Uint8Array> {
  const holdMs = options.holdMs ?? SSE_HOLD_MS;
  const pollMs = options.pollMs ?? SSE_POLL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const encoder = new TextEncoder();
  const local = new AbortController();
  const abortLocal = () => local.abort();
  if (options.signal.aborted) local.abort();
  else options.signal.addEventListener("abort", abortLocal, { once: true });

  return new ReadableStream({
    async start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // The client may already have cancelled the stream.
        }
      };
      try {
        controller.enqueue(encoder.encode(formatSseComment("connected")));
        const started = now();
        let cursor = options.cursor;
        let failed = false;
        while (now() - started < holdMs) {
          if (local.signal.aborted) break;
          let rows: MessageView[] = [];
          try {
            rows = await options.poll(cursor);
          } catch {
            failed = true;
            controller.enqueue(encoder.encode(formatSseComment("poll-error")));
            break;
          }
          if (local.signal.aborted) break;
          for (const message of rows) {
            if (!isAfterCursor(message, cursor)) continue;
            cursor = { createdAt: message.created_at, id: message.id };
            controller.enqueue(
              encoder.encode(formatSseEvent("message", { message }, encodeCursor(cursor))),
            );
          }
          if (rows.length === 0) controller.enqueue(encoder.encode(formatSseComment("ping")));
          await sleep(pollMs, local.signal);
        }
        if (!local.signal.aborted && !failed) {
          controller.enqueue(encoder.encode(formatSseEvent("bye", { ok: true })));
        }
      } finally {
        options.signal.removeEventListener("abort", abortLocal);
        close();
      }
    },
    cancel() {
      local.abort();
    },
  });
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]/g, "");
}
