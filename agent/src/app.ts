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
import { sendMagicPacket } from "./wol/magic-packet.js";
import { wakeViaUplus } from "./wol/uplus.js";

const wakeSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("manual"),
    mac: z.string().regex(/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/),
    // Default matches common U+ home LAN; override when the subnet differs.
    broadcast: z.string().min(1).default("192.168.0.255"),
    port: z.number().int().min(1).max(65535).default(9),
  }),
  z.object({
    mode: z.literal("uplus"),
    device: z.string().min(1),
  }),
]);

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
  const uplusReady = Boolean(config.uplusRouterUrl && config.uplusRouterPassword);

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
        wakeUplus: uplusReady,
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
      if (parsed.data.mode === "manual") {
        log("wake.start", {
          mode: "manual",
          mac: parsed.data.mac,
          broadcast: parsed.data.broadcast,
          port: parsed.data.port,
        });
        const result = await sendMagicPacket(parsed.data);
        log("wake.ok", result);
        return c.json(result);
      }

      log("wake.start", { mode: "uplus", device: parsed.data.device });
      const result = await wakeViaUplus({
        device: parsed.data.device,
        routerUrl: config.uplusRouterUrl,
        routerPassword: config.uplusRouterPassword,
      });
      log("wake.ok", result);
      return c.json(result);
    } catch (error) {
      log("wake.fail", {
        mode: parsed.data.mode,
        error: error instanceof Error ? error.message : "wake failed",
        code: isAgentError(error) ? error.code : undefined,
      });
      if (isAgentError(error)) {
        if (error.code === "UPLUS_NOT_IMPLEMENTED") {
          return c.json(
            { error: "uplus_not_implemented", message: error.message },
            501,
          );
        }
        if (
          error.code === "UPLUS_NOT_CONFIGURED" ||
          error.code === "UPLUS_DEVICE_REQUIRED"
        ) {
          return c.json({ error: error.code.toLowerCase(), message: error.message }, 400);
        }
      }
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

    let authorization: string | undefined;
    if (parsed.data.useHealthToken) {
      if (!config.healthcheckToken) {
        return c.json({ error: "HEALTHCHECK_TOKEN is not configured" }, 400);
      }
      authorization = `Bearer ${config.healthcheckToken}`;
    }

    const result = await checkHttp({
      url: parsed.data.url,
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
