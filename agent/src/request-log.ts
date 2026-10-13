import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { log } from "./log.js";

function redactBody(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (
      lower.includes("password") ||
      lower.includes("token") ||
      lower.includes("secret") ||
      lower.includes("authorization")
    ) {
      out[key] = "[redacted]";
      continue;
    }
    out[key] = entry;
  }
  return out;
}

/**
 * Log every HTTP request in three phases:
 * - request.received  (수신)
 * - request.processing (처리중)
 * - request.complete / request.failed (완료)
 */
export function requestLog(): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now();
    const requestId = randomUUID();
    const method = c.req.method;
    const path = c.req.path;
    const query = c.req.url.includes("?") ? c.req.url.slice(c.req.url.indexOf("?")) : "";
    const hasAuth = Boolean(c.req.header("authorization"));
    const remote =
      c.req.header("cf-connecting-ip") ||
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      c.req.header("x-real-ip") ||
      null;

    const base = {
      requestId,
      method,
      path,
      query: query || undefined,
      remote,
      hasAuth,
    };

    log("request.received", { ...base, phase: "received" });

    let body: unknown;
    if (method === "POST" || method === "PUT" || method === "PATCH") {
      try {
        body = redactBody(await c.req.raw.clone().json());
      } catch {
        body = undefined;
      }
    }

    log("request.processing", {
      ...base,
      phase: "processing",
      body,
    });

    try {
      await next();
    } catch (error) {
      log("request.failed", {
        ...base,
        phase: "failed",
        ms: Math.round(performance.now() - started),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    log("request.complete", {
      ...base,
      phase: "complete",
      status: c.res.status,
      ms: Math.round(performance.now() - started),
    });
  };
}
