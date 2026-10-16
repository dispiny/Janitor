import assert from "node:assert/strict";
import test from "node:test";
import {
  clearLogBuffer,
  drainLogBuffer,
  log,
  peekLogBuffer,
  restoreLogBuffer,
} from "./log.js";

test("log buffers operational events and skips request noise", () => {
  clearLogBuffer();
  log("request.received", { phase: "received" });
  log("tick.complete", { phase: "complete", ms: 12 });
  log("poller.job.failed", { phase: "failed", error: "boom", token: "secret" });
  const peek = peekLogBuffer();
  assert.equal(peek.length, 2);
  assert.equal(peek[0]?.event, "tick.complete");
  assert.equal(peek[1]?.event, "poller.job.failed");
  assert.equal(peek[1]?.token, "[redacted]");
});

test("drain clears buffer; restore puts entries back", () => {
  clearLogBuffer();
  log("tick.failed", { phase: "failed", error: "x" });
  const drained = drainLogBuffer();
  assert.equal(drained.length, 1);
  assert.equal(peekLogBuffer().length, 0);
  restoreLogBuffer(drained);
  assert.equal(peekLogBuffer().length, 1);
  clearLogBuffer();
});

test("restore over capacity keeps the newest entries in chronological order", () => {
  clearLogBuffer();
  for (let i = 0; i < 60; i += 1) log("old.event", { n: i });
  const drained = drainLogBuffer();
  for (let i = 60; i < 120; i += 1) log("new.event", { n: i });
  restoreLogBuffer(drained);
  const peek = peekLogBuffer();
  assert.equal(peek.length, 100);
  const ns = peek.map((e) => e.n as number);
  assert.equal(ns[0], 20);
  assert.equal(ns[ns.length - 1], 119);
  assert.deepEqual(ns, [...ns].sort((a, b) => a - b));
  clearLogBuffer();
});
