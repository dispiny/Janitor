import assert from "node:assert/strict";
import test from "node:test";
import { dedupeAlerts, withoutFresh } from "../src/alert-dedupe.ts";

test("dedupeAlerts fires once per down service until recovery", () => {
  const first = dedupeAlerts({
    prev: {},
    services: [
      { id: "a", name: "Home Assistant", ok: false, code: 503, expect: 200, slackOnFail: true },
      { id: "b", name: "ok-svc", ok: true, code: 200, expect: 200 },
    ],
  });
  assert.equal(first.hasFresh, true);
  assert.equal(first.freshServices.length, 1);
  assert.equal(first.freshServices[0].name, "Home Assistant");
  assert.ok(first.nextState["svc:a"]);

  const second = dedupeAlerts({
    prev: first.nextState,
    services: [
      { id: "a", name: "Home Assistant", ok: false, code: 503, expect: 200, slackOnFail: true },
    ],
  });
  assert.equal(second.hasFresh, false);
  assert.equal(second.freshServices.length, 0);
  assert.ok(second.nextState["svc:a"]);

  const recovered = dedupeAlerts({
    prev: second.nextState,
    services: [{ id: "a", name: "Home Assistant", ok: true, code: 200, expect: 200 }],
  });
  assert.equal(recovered.hasFresh, false);
  assert.equal(recovered.nextState["svc:a"], undefined);

  const again = dedupeAlerts({
    prev: recovered.nextState,
    services: [
      { id: "a", name: "Home Assistant", ok: false, code: 500, expect: 200, slackOnFail: true },
    ],
  });
  assert.equal(again.hasFresh, true);
  assert.equal(again.freshServices[0].name, "Home Assistant");
});

test("dedupeAlerts only alerts speed on first drop", () => {
  const speed = { downMbps: 10, thresholdMbps: 100, upMbps: 1 };
  const first = dedupeAlerts({ prev: {}, speed, speedReported: true });
  assert.ok(first.freshSpeed);
  const second = dedupeAlerts({ prev: first.nextState, speed, speedReported: true });
  assert.equal(second.freshSpeed, null);
  const ok = dedupeAlerts({ prev: second.nextState, speed: null, speedReported: true });
  assert.equal(ok.nextState.speed, undefined);
});

const down = (id = "a") => ({ id, name: "HA", ok: false, code: 503, expect: 200, slackOnFail: true });
const up = (id = "a") => ({ id, name: "HA", ok: true, code: 200, expect: 200 });

test("dedupeAlerts waits for alert_after_failures consecutive failures", () => {
  const r1 = dedupeAlerts({ prev: {}, services: [down()], alertAfterFailures: 3 });
  assert.equal(r1.hasFresh, false);
  assert.equal(r1.nextState["svc:a"].count, 1);
  assert.equal(r1.nextState["svc:a"].notified, false);
  const r2 = dedupeAlerts({ prev: r1.nextState, services: [down()], alertAfterFailures: 3 });
  assert.equal(r2.hasFresh, false);
  const r3 = dedupeAlerts({ prev: r2.nextState, services: [down()], alertAfterFailures: 3 });
  assert.equal(r3.hasFresh, true);
  assert.deepEqual(r3.freshKeys, ["svc:a"]);
  assert.equal(r3.nextState["svc:a"].notified, true);
  assert.equal(r3.nextState["svc:a"].since, r1.nextState["svc:a"].since);
  const r4 = dedupeAlerts({ prev: r3.nextState, services: [down()], alertAfterFailures: 3 });
  assert.equal(r4.hasFresh, false);
});

test("dedupeAlerts: flapping below threshold resets silently", () => {
  const r1 = dedupeAlerts({ prev: {}, services: [down()], alertAfterFailures: 2 });
  const r2 = dedupeAlerts({ prev: r1.nextState, services: [up()], alertAfterFailures: 2 });
  assert.equal(r2.hasRecovery, false);
  assert.equal(r2.nextState["svc:a"], undefined);
  const r3 = dedupeAlerts({ prev: r2.nextState, services: [down()], alertAfterFailures: 2 });
  assert.equal(r3.hasFresh, false);
});

test("dedupeAlerts reports recovery only for notified incidents", () => {
  const r1 = dedupeAlerts({ prev: {}, services: [down()] });
  const r2 = dedupeAlerts({ prev: r1.nextState, services: [up()] });
  assert.equal(r2.hasRecovery, true);
  assert.equal(r2.recoveredServices.length, 1);
  assert.equal(r2.recoveredServices[0].id, "a");
  // Legacy entry (no notified/count) counts as already paged.
  const legacy = dedupeAlerts({ prev: { "svc:a": { since: "2026-10-01T00:00:00Z", name: "HA" } }, services: [up()] });
  assert.equal(legacy.recoveredServices.length, 1);
  // Slack muted: no recovery message.
  const muted = dedupeAlerts({ prev: r1.nextState, services: [{ ...up(), slackOnFail: false }] });
  assert.equal(muted.hasRecovery, false);
});

test("dedupeAlerts speed recovery", () => {
  const speed = { downMbps: 10, thresholdMbps: 100 };
  const r1 = dedupeAlerts({ prev: {}, speed, speedReported: true });
  const r2 = dedupeAlerts({ prev: r1.nextState, speed: null, speedReported: true });
  assert.ok(r2.speedRecovered);
  assert.equal(r2.hasRecovery, true);
  const none = dedupeAlerts({ prev: r2.nextState, speed: null, speedReported: true });
  assert.equal(none.speedRecovered, null);
});

test("dedupeAlerts clears agent:offline on any report and keeps unknown keys", () => {
  const prev = {
    "agent:offline": { since: "2026-10-17T00:00:00Z", kind: "agent", name: "홈 에이전트" },
    "custom:x": { since: "2026-10-17T00:00:00Z" },
  };
  const r = dedupeAlerts({ prev, services: [] });
  assert.equal(r.nextState["agent:offline"], undefined);
  assert.ok(r.agentReconnected);
  assert.equal(r.hasRecovery, true);
  assert.ok(r.nextState["custom:x"]);
  const again = dedupeAlerts({ prev: r.nextState });
  assert.equal(again.agentReconnected, null);
  assert.ok(again.nextState["custom:x"]);
});

test("dedupeAlerts prunes svc keys of deleted services", () => {
  const prev = { "svc:a": { since: "x", notified: true }, "svc:gone": { since: "x", notified: true }, speed: { since: "x" } };
  const r = dedupeAlerts({ prev, serviceIds: ["a"] });
  assert.ok(r.nextState["svc:a"]);
  assert.equal(r.nextState["svc:gone"], undefined);
  assert.ok(r.nextState.speed);
  // No service_ids from the RPC: leave keys alone.
  assert.ok(dedupeAlerts({ prev }).nextState["svc:gone"]);
});

test("dedupeAlerts expires job keys after 24h", () => {
  const now = "2026-10-17T12:00:00.000Z";
  const prev = {
    "job:old": { since: "2026-10-16T11:00:00.000Z" },
    "job:new": { since: "2026-10-17T11:00:00.000Z" },
  };
  const r = dedupeAlerts({ prev, now });
  assert.equal(r.nextState["job:old"], undefined);
  assert.ok(r.nextState["job:new"]);
  const dup = dedupeAlerts({ prev: r.nextState, now, jobs: [{ id: "new", kind: "wake", status: "error" }] });
  assert.equal(dup.hasFresh, false);
});

test("withoutFresh keeps recoveries but drops undelivered fresh keys", () => {
  const prev = {
    "svc:b": { since: "x", name: "B", notified: true, count: 1 },
    "svc:c": { since: "x", name: "C", notified: false, count: 1 },
  };
  const r = dedupeAlerts({
    prev,
    services: [down("a"), { ...up("b"), name: "B" }, { ...down("c"), name: "C" }],
    speed: { downMbps: 1, thresholdMbps: 100 },
    speedReported: true,
    jobs: [{ id: "j1", kind: "wake", status: "error" }],
    alertAfterFailures: 2,
  });
  // a: first failure (count 1, not yet fresh); c: reaches 2 → fresh
  assert.deepEqual(r.freshKeys.sort(), ["job:j1", "speed", "svc:c"]);
  const saved = withoutFresh(r, prev);
  assert.equal(saved["svc:b"], undefined, "recovery persisted");
  assert.deepEqual(saved["svc:c"], prev["svc:c"], "fresh key reverted to previous entry");
  assert.equal(saved.speed, undefined);
  assert.equal(saved["job:j1"], undefined);
  assert.equal(saved["svc:a"].count, 1, "non-fresh progress kept");
  const retry = dedupeAlerts({ prev: saved, services: [{ ...down("c"), name: "C" }], alertAfterFailures: 2 });
  assert.equal(retry.hasFresh, true);
});
