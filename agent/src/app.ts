import { Hono } from "hono";
import { z } from "zod";
import { bearerAuth } from "./auth.js";
import type { AgentConfig } from "./config.js";
import { checkHttp } from "./health-check.js";
import { resolvePublicIp } from "./public-ip.js";
import { sendMagicPacket } from "./wol/magic-packet.js";
import { wakeViaUplus } from "./wol/uplus.js";

const wakeSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("manual"),
    mac: z.string().regex(/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/),
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

  app.use("*", async (c, next) => {
    c.set("config", config);
    await next();
  });

  // Unauthenticated liveness for process / docker probes only.
  app.get("/healthz", (c) => c.json({ ok: true }));

  app.use("/v1/*", bearerAuth(config));

  app.get("/v1/status", (c) => {
    return c.json({
      ok: true,
      service: "janitor-home-agent",
      tunnelHostname: config.tunnelHostname ?? null,
      capabilities: {
        wakeManual: true,
        wakeUplus: Boolean(config.uplusRouterUrl && config.uplusRouterPassword),
        publicIp: true,
        httpCheck: true,
      },
      uplusConfigured: Boolean(config.uplusRouterUrl && config.uplusRouterPassword),
    });
  });

  app.get("/v1/network/public-ip", async (c) => {
    try {
      const result = await resolvePublicIp();
      return c.json(result);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "public ip lookup failed" },
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
        const result = await sendMagicPacket(parsed.data);
        return c.json(result);
      }

      const result = await wakeViaUplus({
        device: parsed.data.device,
        routerUrl: config.uplusRouterUrl,
        routerPassword: config.uplusRouterPassword,
      });
      return c.json(result);
    } catch (error) {
      const code = (error as Error & { code?: string }).code;
      if (code === "UPLUS_NOT_IMPLEMENTED") {
        return c.json(
          {
            error: "uplus_not_implemented",
            message: error instanceof Error ? error.message : "not implemented",
          },
          501,
        );
      }
      const message = error instanceof Error ? error.message : "wake failed";
      const status = message.includes("required") ? 400 : 500;
      return c.json({ error: message }, status);
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
    return c.json(result, result.ok ? 200 : 200);
  });

  return app;
}
