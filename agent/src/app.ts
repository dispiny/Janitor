import { Hono } from "hono";
import { z } from "zod";
import { bearerAuth } from "./auth.js";
import type { AgentConfig } from "./config.js";
import { isAgentError } from "./errors.js";
import { checkHttp } from "./health-check.js";
import { log } from "./log.js";
import { resolvePublicIp } from "./public-ip.js";
import { tick } from "./poller.js";
import { requestLog } from "./request-log.js";
import { collectRuntimeStatus } from "./runtime-status.js";
import { assertAllowedHttpUrl } from "./url-guard.js";
import { DEFAULT_BROADCAST, DEFAULT_WOL_PORT, normalizeMac, sendMagicPacket } from "./wol/magic-packet.js";

const wakeSchema = z.object({
  mode: z.literal("manual").default("manual"),
  mac: z.string().refine((value) => {
    try {
      normalizeMac(value);
      return true;
    } catch {
      return false;
    }
  }, "invalid MAC address"),
  broadcast: z.string().ip({ version: "v4" }).default(DEFAULT_BROADCAST),
  port: z.number().int().min(1).max(65535).default(DEFAULT_WOL_PORT),
});

const checkSchema = z.object({
  url: z.string().url(),
  expectStatus: z.number().int().min(100).max(599).optional(),
  timeoutMs: z.number().int().min(200).max(30000).optional(),
  useHealthToken: z.boolean().optional(),
});

export type AppEnv = {
  Variables: {
    config: AgentConfig;
  };
};

export function createApp(config: AgentConfig) {
  const app = new Hono<AppEnv>();

  app.use("*", requestLog());
  app.use("*", async (c, next) => {
    c.set("config", config);
    await next();
  });

  // Unauthenticated liveness for process / docker probes only.
  app.get("/healthz", (c) => c.json({ ok: true }));

  app.use("/v1/*", bearerAuth(config));

  app.get("/v1/status", (c) => {
    const runtime = collectRuntimeStatus(config);
    return c.json({
      ok: true,
      service: "janitor-home-agent",
      tunnelHostname: config.tunnelHostname ?? null,
      runtime,
      capabilities: {
        wakeManual: true,
        publicIp: true,
        httpCheck: true,
        remoteUpdate: runtime.remoteUpdate,
      },
    });
  });

  app.get("/v1/network/public-ip", async (c) => {
    try {
      const result = await resolvePublicIp();
      return c.json(result);
    } catch (error) {
      return c.json(
        {
          error: isAgentError(error) ? error.code.toLowerCase() : "public_ip_failed",
          message: error instanceof Error ? error.message : "public ip lookup failed",
        },
        502,
      );
    }
  });

  app.post("/v1/wake", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const parsed = wakeSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid body", details: parsed.error.flatten() }, 400);
    }

    try {
      log("wake.received", {
        phase: "received",
        mode: "manual",
        mac: parsed.data.mac,
        broadcast: parsed.data.broadcast,
        port: parsed.data.port,
      });
      log("wake.processing", { phase: "processing", mode: "manual", mac: parsed.data.mac });
      const result = await sendMagicPacket(parsed.data);
      log("wake.complete", { phase: "complete", ...result });
      return c.json(result);
    } catch (error) {
      log("wake.failed", {
        phase: "failed",
        mode: "manual",
        error: error instanceof Error ? error.message : "wake failed",
      });
      return c.json(
        { error: error instanceof Error ? error.message : "wake failed" },
        500,
      );
    }
  });

  app.post("/v1/checks/http", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const parsed = checkSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid body", details: parsed.error.flatten() }, 400);
    }

    const allowed = assertAllowedHttpUrl(parsed.data.url);
    if (!allowed.ok) {
      return c.json({ error: "url_not_allowed", message: allowed.error }, 400);
    }

    let authorization: string | undefined;
    if (parsed.data.useHealthToken) {
      if (!config.healthcheckToken) {
        return c.json({ error: "HEALTHCHECK_TOKEN is not configured" }, 400);
      }
      authorization = `Bearer ${config.healthcheckToken}`;
    }

    const result = await checkHttp({
      url: allowed.url,
      expectStatus: parsed.data.expectStatus,
      timeoutMs: parsed.data.timeoutMs,
      authorization,
    });
    // Body still carries ok/status/ms; HTTP status lets Workers detect failure without parsing.
    return c.json(result, result.ok ? 200 : 502);
  });

  // Authenticated nudge: run one poll tick (no anonymous /job).
  app.post("/v1/poll/now", async (c) => {
    const cfg = c.get("config");
    if (!cfg.janitorApiUrl) {
      return c.json({ error: "JANITOR_API_URL is not configured" }, 400);
    }
    try {
      await tick({
        ...cfg,
        janitorApiUrl: cfg.janitorApiUrl,
      });
      return c.json({ ok: true });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "poll failed" },
        502,
      );
    }
  });

  return app;
}
