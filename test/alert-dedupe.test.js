import assert from "node:assert/strict";
import test from "node:test";
import { dedupeAlerts } from "../src/alert-dedupe.ts";

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
