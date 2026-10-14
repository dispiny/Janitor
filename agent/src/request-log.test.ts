import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApp } from "./app.js";
import type { AgentConfig } from "./config.js";

const config: AgentConfig = {
  token: "test-token",
  port: 3920,
  host: "127.0.0.1",
  pollMs: 15000,
  speedProbeBytes: 2_000_000,
  speedTestDurationMs: 12_000,
  speedTestConnections: 4,
  speedTestProvider: "auto",
  allowRemoteUpdate: false,
};

describe("request logging", () => {
  it("logs received, processing, and complete phases", async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      const app = createApp(config);
      const res = await app.request("/healthz");
      assert.equal(res.status, 200);
      assert.ok(lines.some((line) => line.includes('"event":"request.received"')));
      assert.ok(lines.some((line) => line.includes('"event":"request.processing"')));
      assert.ok(lines.some((line) => line.includes('"event":"request.complete"')));
      assert.ok(lines.some((line) => line.includes('"phase":"received"')));
      assert.ok(lines.some((line) => line.includes('"phase":"processing"')));
      assert.ok(lines.some((line) => line.includes('"phase":"complete"')));
    } finally {
      console.log = original;
    }
  });
});
