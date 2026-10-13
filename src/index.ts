import { handleApi } from "./api";
import type { Env } from "./env";
import { withSecurityHeaders } from "./security-headers";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return withSecurityHeaders(await handleApi(request, env, url.pathname));
    }

    const asset = await env.ASSETS.fetch(request);
    return withSecurityHeaders(asset);
  },
};
