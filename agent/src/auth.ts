import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import type { AgentConfig } from "./config.js";

/** Compare secrets without leaking length via early return. */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

export function bearerAuth(config: AgentConfig) {
  return async (c: Context, next: Next) => {
    const header = c.req.header("authorization");
    if (!header?.startsWith("Bearer ")) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const token = header.slice("Bearer ".length).trim();
    if (!token || !safeEqual(token, config.token)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}
