import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApp } from "./app.js";
import type { AgentConfig } from "./config.js";

const config: AgentConfig = {
  token: "test-token",
  port: 3920,
  host: "127.0.0.1",
  tunnelHostname: "agent.example.trycloudflare.com",
};

describe("home agent HTTP API", () => {
  it("exposes unauthenticated healthz", async () => {
    const app = createApp(config);
    const res = await app.request("/healthz");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  it("rejects missing bearer on /v1", async () => {
    const app = createApp(config);
    const res = await app.request("/v1/status");
    assert.equal(res.status, 401);
  });

  it("returns status with capabilities", async () => {
    const app = createApp(config);
    const res = await app.request("/v1/status", {
      headers: { authorization: "Bearer test-token" },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      service: string;
      tunnelHostname: string;
      capabilities: { wakeManual: boolean };
    };
    assert.equal(body.service, "janitor-home-agent");
    assert.equal(body.tunnelHostname, "agent.example.trycloudflare.com");
    assert.equal(body.capabilities.wakeManual, true);
  });

  it("validates wake body", async () => {
    const app = createApp(config);
    const res = await app.request("/v1/wake", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ mode: "manual", mac: "bad" }),
    });
    assert.equal(res.status, 400);
  });

  it("returns 501 for uplus until provider is wired", async () => {
    const app = createApp({
      ...config,
      uplusRouterUrl: "https://router.local",
      uplusRouterPassword: "secret",
    });
    const res = await app.request("/v1/wake", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ mode: "uplus", device: "거실-PC" }),
    });
    assert.equal(res.status, 501);
  });
});
