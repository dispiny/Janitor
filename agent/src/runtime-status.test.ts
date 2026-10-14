import assert from "node:assert/strict";
import test from "node:test";
import { collectRuntimeStatus } from "./runtime-status.js";

test("collectRuntimeStatus reports version and host", () => {
  const status = collectRuntimeStatus({
    token: "t",
    port: 3920,
    host: "127.0.0.1",
    pollMs: 15000,
    speedProbeBytes: 2000,
    speedTestDurationMs: 12_000,
    speedTestConnections: 4,
    speedTestProvider: "auto",
    allowRemoteUpdate: true,
    pm2AppName: "ops-agent",
  });
  assert.equal(typeof status.version, "string");
  assert.ok(status.version.length > 0);
  assert.match(status.node, /^v\d+/);
  assert.ok(status.hostname.length > 0);
  assert.equal(status.remoteUpdate, true);
  assert.equal(status.pm2Name, "ops-agent");
  assert.equal(status.pollMs, 15000);
});
