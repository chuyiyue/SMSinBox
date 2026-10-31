import { purgeExpired } from "./db";
import { json } from "./http";
import { errorText, logError, logInfo } from "./log";
import { handleApi } from "./routes/api";
import { handleIngest, handleSms } from "./routes/sms";

function pathForLog(pathname: string): string {
  if (pathname.startsWith("/api/v1/ingest/")) return "/api/v1/ingest/:secret";
  return pathname;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();
    const path = pathForLog(url.pathname);
    try {
      let response: Response;
      if (url.pathname === "/api/v1/sms") {
        response =
          request.method.toUpperCase() === "POST"
            ? await handleSms(request, env, ctx)
            : json({ ok: false, error: "方法不允许" }, 405, { allow: "POST" });
      } else if (url.pathname.startsWith("/api/v1/ingest/")) {
        response =
          request.method.toUpperCase() === "POST"
            ? await handleIngest(request, env, ctx)
            : json({ ok: false, error: "方法不允许" }, 405, { allow: "POST" });
      } else if (url.pathname.startsWith("/api/")) {
        response = await handleApi(request, env, ctx);
      } else {
        response = await env.ASSETS.fetch(request);
      }
      if (url.pathname.startsWith("/api/")) {
        logInfo({
          message: "request",
          request_id: requestId,
          method: request.method,
          path,
          status: response.status,
        });
      }
      return response;
    } catch (error) {
      logError({
        message: "request_failed",
        request_id: requestId,
        method: request.method,
        path,
        error: errorText(error),
      });
      return json({ ok: false, error: "服务器错误", request_id: requestId }, 500);
    }
  },
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(
      purgeExpired(env.DB, Date.now(), env.RETENTION_DAYS).catch((error: unknown) => {
        logError({
          message: "retention_failed",
          error: errorText(error),
        });
      }),
    );
  },
} satisfies ExportedHandler<Env>;
