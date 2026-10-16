import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_PUBLIC_IP_INTERVAL_SEC,
  DEFAULT_SPEED_INTERVAL_SEC,
  oldestServiceCheckAt,
  ScheduleMemory,
  scheduledKinds,
} from "./schedule.js";

describe("scheduledKinds", () => {
  const now = Date.parse("2026-10-14T16:00:00.000Z");

  it("uses situational defaults: public IP ~2h, speed ~1h", () => {
    assert.equal(DEFAULT_PUBLIC_IP_INTERVAL_SEC, 7200);
    assert.equal(DEFAULT_SPEED_INTERVAL_SEC, 3600);
  });

  it("marks never-checked services and IP as due", () => {
    const kinds = scheduledKinds({
      now,
      house: {},
      services: [{ last_checked_at: null }],
      hasPve: true,
    });
    assert.deepEqual(kinds, ["health_all", "pve_sync", "public_ip", "speed_probe"]);
  });

  it("respects ages within interval", () => {
    const kinds = scheduledKinds({
      now,
      house: {
        public_ip_checked_at: "2026-10-14T15:00:00.000Z", // 1h ago < 2h
        last_speed_at: "2026-10-14T15:30:00.000Z", // 30m ago < 1h
        last_pve_at: "2026-10-14T15:50:00.000Z", // 10m ago < 15m
        health_interval_sec: 300,
      },
      services: [{ last_checked_at: "2026-10-14T15:58:00.000Z" }], // 2m ago
      hasPve: true,
    });
    assert.deepEqual(kinds, []);
  });

  it("fires when older than interval and skips pending queue kinds", () => {
    const kinds = scheduledKinds({
      now,
      house: {
        public_ip_checked_at: "2026-10-14T13:00:00.000Z", // 3h ago
        last_speed_at: "2026-10-14T14:00:00.000Z", // 2h ago
        speed_interval_sec: 3600,
        public_ip_interval_sec: 7200,
      },
      services: [],
      hasPve: false,
      pendingKinds: ["speed_probe"],
    });
    assert.deepEqual(kinds, ["public_ip"]);
  });

  it("interval 0 disables a kind", () => {
    const kinds = scheduledKinds({
      now,
      house: {
        public_ip_interval_sec: 0,
        speed_interval_sec: 0,
        health_interval_sec: 0,
        pve_interval_sec: 0,
      },
      services: [{ last_checked_at: null }],
      hasPve: true,
    });
    assert.deepEqual(kinds, []);
  });

  it("oldestServiceCheckAt returns null when any service is unchecked", () => {
    assert.equal(
      oldestServiceCheckAt([{ last_checked_at: "2026-10-14T15:00:00.000Z" }, { last_checked_at: null }]),
      null,
    );
  });
});

describe("scheduledKinds local memory", () => {
  const now = Date.parse("2026-10-14T16:00:00.000Z");
  const min = 60_000;

  it("does not rerun pve_sync every tick when last_pve_at stays null (no guests)", () => {
    const memory = new ScheduleMemory();
    const input = { house: { pve_interval_sec: 900 }, services: [], hasPve: true, memory };
    assert.ok(scheduledKinds({ ...input, now }).includes("pve_sync"));
    memory.note("pve_sync", true, now);
    // Server still says "never" — local attempt time wins.
    assert.ok(!scheduledKinds({ ...input, now: now + 1 * min }).includes("pve_sync"));
    assert.ok(!scheduledKinds({ ...input, now: now + 14 * min }).includes("pve_sync"));
    assert.ok(scheduledKinds({ ...input, now: now + 15 * min }).includes("pve_sync"));
  });

  it("does not rerun speed_probe when the report failed (server timestamp stale)", () => {
    const memory = new ScheduleMemory();
    const house = { speed_interval_sec: 3600, last_speed_at: "2026-10-14T12:00:00.000Z" };
    assert.ok(scheduledKinds({ now, house, services: [], hasPve: false, memory }).includes("speed_probe"));
    memory.note("speed_probe", true, now);
    assert.ok(
      !scheduledKinds({ now: now + 5 * min, house, services: [], hasPve: false, memory }).includes("speed_probe"),
    );
  });

  it("uses the newer of server timestamp and local attempt", () => {
    const memory = new ScheduleMemory();
    memory.note("public_ip", true, now - 3 * 3600_000); // local: 3h ago
    const house = { public_ip_interval_sec: 7200, public_ip_checked_at: "2026-10-14T15:30:00.000Z" }; // 30m ago
    assert.ok(!scheduledKinds({ now, house, services: [], hasPve: false, memory }).includes("public_ip"));
  });

  it("backs off repeated failures up to 4× the interval and resets on success", () => {
    const memory = new ScheduleMemory();
    const house = { speed_interval_sec: 3600, public_ip_interval_sec: 0 };
    const due = (at: number) =>
      scheduledKinds({ now: at, house, services: [], hasPve: false, memory }).includes("speed_probe");
    const h = 3600_000;

    memory.note("speed_probe", false, now); // 1st failure → 1×
    assert.equal(memory.backoffFactor("speed_probe"), 1);
    assert.ok(due(now + h));

    memory.note("speed_probe", false, now); // 2nd → 2×
    assert.equal(memory.backoffFactor("speed_probe"), 2);
    assert.ok(!due(now + h));
    assert.ok(due(now + 2 * h));

    memory.note("speed_probe", false, now); // 3rd → 4×
    memory.note("speed_probe", false, now); // 4th → still capped at 4×
    assert.equal(memory.backoffFactor("speed_probe"), 4);
    assert.ok(!due(now + 3 * h));
    assert.ok(due(now + 4 * h));

    memory.note("speed_probe", true, now);
    assert.equal(memory.backoffFactor("speed_probe"), 1);
    assert.ok(due(now + h));
  });
});
