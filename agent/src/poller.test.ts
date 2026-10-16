import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  _resetWakeChecks,
  mapLimit,
  orderJobs,
  pendingWakeChecks,
  pollBackoffMs,
  tick,
  type PollerConfig,
  type PollerDeps,
} from "./poller.js";
import { ScheduleMemory } from "./schedule.js";
import type { SelfUpdateResult } from "./self-update.js";

const cfg: PollerConfig = {
  token: "x",
  port: 1,
  host: "127.0.0.1",
  janitorApiUrl: "http://worker.test",
  pollMs: 15000,
  speedProbeBytes: 1000,
  speedTestDurationMs: 3000,
  speedTestConnections: 2,
  speedTestProvider: "auto",
  allowRemoteUpdate: true,
  deployOnUpdate: false,
  healthcheckToken: "hc-secret",
};

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const S1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const S2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Snapshot = Record<string, unknown>;

/** Fake Worker: serves one poll snapshot, records reports and the order of side effects. */
function harness(snapshot: Snapshot, opts: { reportFails?: number } = {}) {
  const events: string[] = [];
  const reports: Array<Record<string, unknown>> = [];
  let reportFails = opts.reportFails ?? 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/agent/poll")) return Response.json(snapshot);
    if (url.endsWith("/api/agent/report")) {
      events.push("report");
      if (reportFails > 0) {
        reportFails -= 1;
        return Response.json({ error: "worker down" }, { status: 503 });
      }
      reports.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    }
    return new Response("nope", { status: 404 });
  }) as typeof fetch;

  const deps: Partial<PollerDeps> = {
    fetchImpl,
    scheduleMemory: new ScheduleMemory(),
    reportRetryDelayMs: 1,
    restartPm2: (name) => {
      events.push(`restart:${name}`);
    },
    checkHttp: async (input) => {
      events.push(`check:${input.url}:${input.authorization ?? "none"}`);
      return { url: input.url, ok: true, status: 200, expectStatus: 200, ms: 1 };
    },
    probeReachable: async () => false,
    runSpeedTest: async () => {
      events.push("speed");
      throw new Error("speed test should not run");
    },
    resolvePublicIp: async () => {
      events.push("public_ip");
      return { ip: "203.0.113.1", checkedAt: new Date().toISOString(), source: "test" };
    },
    sendMagicPacket: async (input) => {
      events.push("wake");
      return { ok: true, mode: "manual", mac: input.mac, broadcast: "255.255.255.255", port: 9, bytes: 102, sent: 3 };
    },
    runSelfUpdate: async () => {
      events.push("update");
      return { ok: true, restartScheduled: true, pm2AppName: "janitor-agent" } as SelfUpdateResult;
    },
  };
  return { deps, events, reports };
}

const quietHouse = {
  id: "h",
  name: "home",
  speed_threshold_mbps: 0,
  slack_channel: "",
  health_interval_sec: 0,
  pve_interval_sec: 0,
  speed_interval_sec: 0,
  public_ip_interval_sec: 0,
};

beforeEach(() => _resetWakeChecks());

describe("poller helpers", () => {
  it("orders wake first and agent_update last, dropping scheduled jobs when updating", () => {
    const ordered = orderJobs([
      { id: "sched-speed_probe", kind: "speed_probe", payload: { scheduled: true } },
      { id: U1, kind: "agent_update" },
      { id: U2, kind: "health_all" },
      { id: "w", kind: "wake" },
    ]);
    assert.deepEqual(
      ordered.map((j) => j.kind),
      ["wake", "health_all", "agent_update"],
    );
  });

  it("backs off poll failures up to 5 minutes", () => {
    assert.equal(pollBackoffMs(15000, 0), 15000);
    assert.equal(pollBackoffMs(15000, 1), 30000);
    assert.equal(pollBackoffMs(15000, 2), 60000);
    assert.equal(pollBackoffMs(15000, 10), 300000);
  });

  it("mapLimit keeps order and bounds concurrency", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return n * 2;
    });
    assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14, 16, 18]);
    assert.equal(peak, 4);
  });
});

describe("tick", () => {
  it("rejects when the Worker is unreachable", async () => {
    await assert.rejects(
      () => tick({ ...cfg, janitorApiUrl: "http://127.0.0.1:9" }, { scheduleMemory: new ScheduleMemory() }),
      /fetch|ECONNREFUSED|failed|error|9/i,
    );
  });

  it("sends HEALTHCHECK_TOKEN only to services with use_health_token === true", async () => {
    const h = harness({
      house: quietHouse,
      jobs: [{ id: U1, kind: "health_all" }],
      servers: [],
      services: [
        { id: S1, name: "a", health_url: "http://192.168.0.10/a", use_health_token: true },
        { id: S2, name: "b", health_url: "http://192.168.0.10/b" },
        { id: "c", name: "c", health_url: "http://192.168.0.10/c", use_health_token: "true" },
      ],
      secrets: {},
    });
    const outcome = await tick(cfg, h.deps);
    assert.deepEqual(outcome, { started: true });
    const checks = h.events.filter((e) => e.startsWith("check:")).sort();
    assert.deepEqual(checks, [
      "check:http://192.168.0.10/a:Bearer hc-secret",
      "check:http://192.168.0.10/b:none",
      "check:http://192.168.0.10/c:none",
    ]);
  });

  it("reports per-job counts, not cumulative ones", async () => {
    const h = harness({
      house: quietHouse,
      jobs: [
        { id: U1, kind: "health_one", payload: { serviceId: S1 } },
        { id: U2, kind: "health_all" },
      ],
      servers: [],
      services: [
        { id: S1, name: "a", health_url: "http://192.168.0.10/a" },
        { id: S2, name: "b", health_url: "http://192.168.0.10/b" },
      ],
      secrets: {},
    });
    await tick(cfg, h.deps);
    const jobs = h.reports[0]?.jobs as Array<{ id: string; result: { count: number } }>;
    assert.equal(jobs.find((j) => j.id === U1)?.result.count, 1);
    assert.equal(jobs.find((j) => j.id === U2)?.result.count, 2);
  });

  it("reports guestSyncFailedNodes and omits links whose node list failed", async () => {
    const h = harness({
      house: quietHouse,
      jobs: [{ id: U1, kind: "pve_sync" }],
      servers: [
        { id: S1, pve_enabled: true, pve_host: "https://192.168.0.2:8006", pve_token_id: "a@pve!x" },
        { id: S2, pve_enabled: true, pve_host: "https://192.168.0.3:8006", pve_token_id: "b@pve!x" },
      ],
      services: [],
      secrets: { [S1]: "s1", [S2]: "s2" },
    });
    h.deps.syncPveGuests = async (input) => {
      if (input.serverId === S2) throw new Error("Proxmox API 401 on /api2/json/nodes");
      return {
        nodes: ["pve-a", "pve-b"],
        discovered: [
          { node: "pve-a", online: true },
          { node: "pve-b", online: false },
        ],
        guests: [{ server_id: S1, name: "haos", node: "pve-a", kind: "VM", is_on: true }],
        failedNodes: ["pve-b"],
      };
    };
    await tick(cfg, h.deps);
    const report = h.reports[0]!;
    assert.deepEqual(report.guestSyncServerIds, [S1]);
    assert.deepEqual(report.guestSyncFailedNodes, { [S1]: ["pve-b"] });
    assert.deepEqual((report.pveNodes as Array<{ server_id: string }>).map((n) => n.server_id), [S1]);
    const job = (report.jobs as Array<{ status: string; result: { servers: number } }>)[0]!;
    assert.equal(job.status, "done");
    assert.equal(job.result.servers, 1);
  });

  it("does not include speed when the probe fails", async () => {
    const h = harness({
      house: quietHouse,
      jobs: [{ id: U1, kind: "speed_probe" }],
      servers: [],
      services: [],
      secrets: {},
    });
    await tick(cfg, h.deps);
    const report = h.reports[0]!;
    assert.equal("speed" in report, false);
    assert.equal((report.jobs as Array<{ status: string }>)[0]?.status, "error");
  });

  it("restarts pm2 only after the report, skips scheduled jobs and runs agent_update last", async () => {
    const h = harness({
      house: { ...quietHouse, public_ip_interval_sec: 7200 }, // public_ip would be due
      jobs: [
        { id: U1, kind: "agent_update" },
        { id: U2, kind: "wake", payload: { serverId: S1 } },
      ],
      servers: [{ id: S1, wol_mode: "manual", wol_mac: "02:00:00:00:00:10" }],
      services: [],
      secrets: {},
    });
    await tick(cfg, h.deps);
    assert.deepEqual(h.events, ["wake", "update", "report", "restart:janitor-agent"]);
  });

  it("retries the report once, then restarts even if it still fails", async () => {
    const h = harness(
      { house: quietHouse, jobs: [{ id: U1, kind: "agent_update" }], servers: [], services: [], secrets: {} },
      { reportFails: 2 },
    );
    await assert.rejects(() => tick(cfg, h.deps), /worker down/);
    assert.deepEqual(h.events, ["update", "report", "report", "restart:janitor-agent"]);
  });

  it("does not claim is_on after WOL; flips it once manage_url answers", async () => {
    const snapshot = {
      house: quietHouse,
      jobs: [{ id: U1, kind: "wake", payload: { serverId: S1 } }],
      servers: [{ id: S1, wol_mode: "manual", wol_mac: "02:00:00:00:00:10", manage_url: "http://192.168.0.20:8006" }],
      services: [],
      secrets: {},
    };
    const h = harness(snapshot);
    await tick(cfg, h.deps);
    const first = h.reports[0]!;
    assert.deepEqual(first.servers, []);
    const result = (first.jobs as Array<{ result: { state: string; verify: string } }>)[0]!.result;
    assert.equal(result.state, "sent");
    assert.equal(result.verify, "pending");
    assert.ok(pendingWakeChecks().has(S1));

    // Next tick: no new jobs, machine answers.
    snapshot.jobs = [];
    h.deps.probeReachable = async (url) => url.startsWith("http://192.168.0.20:8006");
    await tick(cfg, h.deps);
    assert.deepEqual(h.reports[1]!.servers, [{ id: S1, is_on: true }]);
    assert.equal(pendingWakeChecks().has(S1), false);
  });

  it("drops the WOL verification after the deadline without claiming is_on", async () => {
    const snapshot = {
      house: quietHouse,
      jobs: [{ id: U1, kind: "wake", payload: { serverId: S1 } }],
      servers: [{ id: S1, wol_mode: "manual", wol_mac: "02:00:00:00:00:10", manage_url: "http://192.168.0.20" }],
      services: [],
      secrets: {},
    };
    let now = Date.parse("2026-10-17T00:00:00Z");
    const h = harness(snapshot);
    h.deps.now = () => now;
    await tick(cfg, h.deps);
    snapshot.jobs = [];
    now += 4 * 60_000;
    await tick(cfg, h.deps);
    assert.deepEqual(h.reports[1]!.servers, []);
    assert.equal(pendingWakeChecks().has(S1), false);
  });

  it("records scheduled attempts locally so a heavy job is not re-run next tick", async () => {
    const snapshot = {
      house: { ...quietHouse, public_ip_interval_sec: 7200, public_ip_checked_at: null },
      jobs: [],
      servers: [],
      services: [],
      secrets: {},
    };
    const h = harness(snapshot, { reportFails: 1 });
    await assert.rejects(() => tick(cfg, h.deps)); // report fails → server timestamp stays null
    await tick(cfg, h.deps);
    assert.equal(h.events.filter((e) => e === "public_ip").length, 1);
  });
});
