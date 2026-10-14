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
      capabilities: { wakeManual: boolean; wakeUplus?: boolean; remoteUpdate: boolean };
      runtime?: { version?: string };
    };
    assert.equal(body.service, "janitor-home-agent");
    assert.equal(body.tunnelHostname, "agent.example.trycloudflare.com");
    assert.equal(body.capabilities.wakeManual, true);
    assert.equal(body.capabilities.wakeUplus, undefined);
    assert.equal(body.capabilities.remoteUpdate, false);
    assert.ok(body.runtime?.version);
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

  it("rejects the removed uplus mode", async () => {
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
  });

  it("broadcasts a magic packet to the limited broadcast address by default", async () => {
    const app = createApp(config);
    const res = await app.request("/v1/wake", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ mac: "aa-bb-cc-dd-ee-01", port: 40009 }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { mac: string; broadcast: string; sent: number };
    assert.equal(body.mac, "AA:BB:CC:DD:EE:01");
    assert.equal(body.broadcast, "255.255.255.255");
    assert.equal(body.sent, 3);
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
