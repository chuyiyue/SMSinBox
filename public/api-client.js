import { clearShellCache } from "./device-store.js";
import { t } from "./i18n.js";
import { rememberFlash } from "./ui.js";

// ─── API client ─────────────────────────────────────────────────────────────
//
// Single entry point for every JSON API call the pages make. Pages never
// call fetch() directly for API traffic; they go through api() here (the
// shell's HTML document loader in shell.js is the one deliberate exception:
// it swaps views, it does not speak the JSON API).
//
// Error classification — every failure leaves this module in exactly one
// of three shapes:
//   - HTTP error status: NOT thrown. api() resolves to { response, data }
//     and callers branch on response.ok, reading data.error. An unparseable
//     body is classified as data = { ok: false, error: "响应无法解析" }.
//   - Unauthorized (401, unless allowUnauthorized): the shell cache is
//     cleared, a "登录已过期" flash is stored and the browser is sent to
//     the login page; api() then throws an Error whose message is
//     "unauthorized" and whose `kind` is "unauthorized" (see isUnauthorized).
//   - Network failure: the original fetch rejection is rethrown untouched
//     except for a `kind` of "network", so callers keep the native error.
//
// Retry semantics: api() makes exactly one attempt and never retries on
// its own. Several endpoints are mutations, so silent retries could
// double-apply them; failed loads surface through the shared error
// components, which offer a manual retry. Realtime recovery lives in the
// stream helper below, not in request/response calls.

function tagKind(error, kind) {
  if (error && typeof error === "object") {
    try {
      error.kind = kind;
    } catch {
      // A frozen error object still propagates unchanged.
    }
  }
  return error;
}

export async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  let response;
  try {
    response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  } catch (error) {
    throw tagKind(error, "network");
  }
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { ok: false, error: t("auth.unparseable") };
    }
  }
  if (response.status === 401 && !options.allowUnauthorized) {
    clearShellCache();
    rememberFlash(t("auth.sessionExpired"));
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    location.assign(`/login.html?next=${next}`);
    throw tagKind(new Error("unauthorized"), "unauthorized");
  }
  return { response, data };
}

export function isUnauthorized(error) {
  return error instanceof Error && error.message === "unauthorized";
}

// ─── Realtime stream ────────────────────────────────────────────────────────
//
// The client owns the EventSource for the realtime channel: endpoint,
// cursor encoding and event names ("message" / "bye") are fixed here and
// match the server protocol. The view keeps its own connection state
// (labels, failure counts, fallback polling) and reacts through the
// callbacks; closing the returned source stops the stream. Reconnection
// stays with the browser's native EventSource retry plus the server-sent
// "bye" signal, exactly as before.
export function openEventStream(cursor, { onOpen, onMessage, onBye, onError } = {}) {
  const source = new EventSource(`/api/v1/events?cursor=${encodeURIComponent(cursor)}`);
  source.onopen = () => {
    onOpen?.();
  };
  source.addEventListener("message", (event) => {
    let payload = null;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!payload?.message) return;
    onMessage?.(payload.message);
  });
  source.addEventListener("bye", () => {
    onBye?.();
  });
  source.onerror = () => {
    onError?.();
  };
  return source;
}
