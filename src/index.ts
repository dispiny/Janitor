import { handleApi } from "./api";
import type { Env } from "./env";
import { withSecurityHeaders } from "./security-headers";

function log(event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();
    const base = {
      requestId,
      method: request.method,
      path: url.pathname,
      hasAuth: Boolean(request.headers.get("authorization")),
    };

    log("request.received", { ...base, phase: "received" });
    log("request.processing", { ...base, phase: "processing" });
    const started = Date.now();

    try {
      let response: Response;
      if (url.pathname.startsWith("/api/")) {
        response = await handleApi(request, env, url.pathname);
      } else {
        response = await env.ASSETS.fetch(request);
      }

      response = withSecurityHeaders(response);

      log("request.complete", {
        ...base,
        phase: "complete",
        status: response.status,
        ms: Date.now() - started,
      });
      return response;
    } catch (error) {
      log("request.failed", {
        ...base,
        phase: "failed",
        ms: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
};
