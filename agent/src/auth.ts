import { timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import type { AgentConfig } from "./config.js";

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
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
