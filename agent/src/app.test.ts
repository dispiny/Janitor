import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApp } from "./app.js";
import type { AgentConfig } from "./config.js";

const config: AgentConfig = {
  token: "test-token",
  port: 3920,
  host: "127.0.0.1",
  tunnelHostname: "agent.example.trycloudflare.com",
  pollMs: 15000,
  speedProbeBytes: 2_000_000,
  speedTestDurationMs: 12_000,
  speedTestConnections: 4,
  speedTestProvider: "auto",
  allowRemoteUpdate: false,
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
      capabilities: { wakeManual: boolean; wakeUplus: boolean; remoteUpdate: boolean };
      runtime?: { version?: string };
      uplusConfigured?: boolean;
    };
    assert.equal(body.service, "janitor-home-agent");
    assert.equal(body.tunnelHostname, "agent.example.trycloudflare.com");
    assert.equal(body.capabilities.wakeManual, true);
    assert.equal(body.capabilities.wakeUplus, false);
    assert.equal(body.capabilities.remoteUpdate, false);
    assert.ok(body.runtime?.version);
    assert.equal(body.uplusConfigured, undefined);
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

  it("returns 400 with code when uplus env is missing", async () => {
    const app = createApp(config);
    const res = await app.request("/v1/wake", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ mode: "uplus", device: "거실-PC" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "uplus_not_configured");
  });

  it("returns 502 when http check expectation fails", async () => {
    const app = createApp(config);
    const res = await app.request("/v1/checks/http", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        url: "https://example.com",
        expectStatus: 418,
      }),
    });
    assert.equal(res.status, 502);
    const body = (await res.json()) as { ok: boolean; status: number };
    assert.equal(body.ok, false);
    assert.equal(body.status, 200);
  });

  it("rejects metadata / non-http urls on http check", async () => {
    const app = createApp(config);
    const res = await app.request("/v1/checks/http", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        url: "http://169.254.169.254/latest/meta-data",
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "url_not_allowed");
  });
});
