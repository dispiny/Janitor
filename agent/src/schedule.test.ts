import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_PUBLIC_IP_INTERVAL_SEC,
  DEFAULT_SPEED_INTERVAL_SEC,
  oldestServiceCheckAt,
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
