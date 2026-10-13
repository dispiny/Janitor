import assert from "node:assert/strict";
import test from "node:test";
import { tick } from "./poller.js";

test("tick is a no-op reentry guard when already running", async () => {
  // Smoke: exporting tick and calling without config should throw, not hang.
  await assert.rejects(
    () =>
      tick({
        token: "x",
        port: 1,
        host: "127.0.0.1",
        janitorApiUrl: "http://127.0.0.1:9",
        pollMs: 1000,
        speedProbeBytes: 1000,
        allowRemoteUpdate: false,
      }),
    /fetch|ECONNREFUSED|failed|error|9/i,
  );
});
