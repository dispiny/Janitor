import { checkHttp } from "./health-check.js";
import type { AgentConfig } from "./config.js";
import { resolvePublicIp } from "./public-ip.js";
import { log } from "./log.js";
import { drainLogBuffer, restoreLogBuffer } from "./log.js";
import { collectRuntimeStatus } from "./runtime-status.js";
import { restartPm2, runSelfUpdate } from "./self-update.js";
import { runSpeedTest } from "./speedtest.js";
import { assertAllowedHttpUrl, assertAllowedHttpUrlResolved } from "./url-guard.js";
import { syncPveGuests } from "./pve-sync.js";
import { isScheduleKind, scheduledKinds, scheduleMemory, type ScheduleMemory } from "./schedule.js";
import { sendMagicPacket } from "./wol/magic-packet.js";
export type PollerConfig = AgentConfig & {
  janitorApiUrl: string;
  pollMs: number;
  hostLabel?: string;
};

type PollSnapshot = {
  house: {
    id: string;
    name: string;
    speed_threshold_mbps: number;
    slack_channel: string;
    health_interval_sec?: number;
    pve_interval_sec?: number;
    speed_interval_sec?: number;
    public_ip_interval_sec?: number;
    public_ip_checked_at?: string | null;
    last_speed_at?: string | null;
    last_pve_at?: string | null;
  };
  jobs: Array<{ id?: string; kind: string; payload?: Record<string, unknown> }>;
  servers: Array<Record<string, unknown>>;
  services: Array<Record<string, unknown>>;
  secrets: Record<string, string>;
};

type Job = PollSnapshot["jobs"][number];

/** Injection points for tests; production uses the real implementations. */
export type PollerDeps = {
  fetchImpl: typeof fetch;
  checkHttp: typeof checkHttp;
  syncPveGuests: typeof syncPveGuests;
  runSelfUpdate: typeof runSelfUpdate;
  restartPm2: typeof restartPm2;
  sendMagicPacket: typeof sendMagicPacket;
  runSpeedTest: typeof runSpeedTest;
  resolvePublicIp: typeof resolvePublicIp;
  /** Any HTTP response from manage_url counts as "up". */
  probeReachable: (url: string) => Promise<boolean>;
  scheduleMemory: ScheduleMemory;
  now: () => number;
  /** Pause before the single report retry when a restart is pending. */
  reportRetryDelayMs: number;
};

export const API_TIMEOUT_MS = 30_000;
export const MAX_POLL_BACKOFF_MS = 5 * 60_000;
export const HEALTH_CONCURRENCY = 4;
export const WAKE_VERIFY_MS = 3 * 60_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPersistedJobId(id: unknown): id is string {
  return typeof id === "string" && UUID_RE.test(id);
}

function isScheduledJob(job: Job): boolean {
  return Boolean(job.payload?.scheduled) || String(job.id || "").startsWith("sched-");
}

async function defaultProbeReachable(url: string): Promise<boolean> {
  const allowed = await assertAllowedHttpUrlResolved(url);
  if (!allowed.ok) return false;
  try {
    const res = await fetch(allowed.url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(3000),
    });
    await res.body?.cancel().catch(() => undefined);
    return true;
  } catch (error) {
    // A TLS handshake with a self-signed cert (Proxmox UI, NAS) still proves the host is up.
    const code = String((error as { cause?: { code?: string } }).cause?.code || "");
    return /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code);
  }
}

function defaultDeps(): PollerDeps {
  return {
    fetchImpl: fetch,
    checkHttp,
    syncPveGuests,
    runSelfUpdate,
    restartPm2,
    sendMagicPacket,
    runSpeedTest,
    resolvePublicIp,
    probeReachable: defaultProbeReachable,
    scheduleMemory,
    now: Date.now,
    reportRetryDelayMs: 2000,
  };
}

function withScheduledJobs(snapshot: PollSnapshot, deps: PollerDeps): PollSnapshot {
  const pending = (snapshot.jobs || []).map((j) => j.kind);
  // An update restarts the agent right after this tick — don't start heavy checks too.
  if (pending.includes("agent_update")) return snapshot;
  const hasPve = (snapshot.servers || []).some((s) => s.pve_enabled);
  const due = scheduledKinds({
    now: deps.now(),
    house: snapshot.house || {},
    services: (snapshot.services || []) as Array<{ last_checked_at?: string | null }>,
    hasPve,
    pendingKinds: pending,
    memory: deps.scheduleMemory,
  });
  if (!due.length) return snapshot;
  const scheduled = due.map((kind) => ({ id: `sched-${kind}`, kind, payload: { scheduled: true } }));
  log("poller.schedule", { phase: "due", kinds: due });
  return { ...snapshot, jobs: [...(snapshot.jobs || []), ...scheduled] };
}

/**
 * Execution order: wake first (a user is waiting), then the rest in queue order,
 * agent_update last (it ends in a restart). With agent_update present, scheduled
 * jobs are dropped for this tick.
 */
export function orderJobs<T extends Job>(jobs: T[]): T[] {
  const hasUpdate = jobs.some((j) => j.kind === "agent_update");
  const list = hasUpdate ? jobs.filter((j) => !isScheduledJob(j)) : jobs;
  const rank = (j: Job) => (j.kind === "wake" ? 0 : j.kind === "agent_update" ? 2 : 1);
  return list
    .map((job, index) => ({ job, index }))
    .sort((a, b) => rank(a.job) - rank(b.job) || a.index - b.index)
    .map((entry) => entry.job);
}

/** Map with at most `limit` concurrent calls; results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export function pollBackoffMs(pollMs: number, failures: number): number {
  if (failures <= 0) return pollMs;
  return Math.max(pollMs, Math.min(MAX_POLL_BACKOFF_MS, pollMs * 2 ** Math.min(failures, 10)));
}

// ---------------------------------------------------------------------------
// WOL verification: a sent packet is not proof the machine is up.
// ---------------------------------------------------------------------------
type WakeCheck = { url: string; deadline: number; sentAt: number };
const wakeChecks = new Map<string, WakeCheck>();

/** Test helper. */
export function _resetWakeChecks(): void {
  wakeChecks.clear();
}

/** Test helper — pending wake verifications by server id. */
export function pendingWakeChecks(): ReadonlyMap<string, WakeCheck> {
  return wakeChecks;
}

async function verifyPendingWakes(
  deps: PollerDeps,
  serverUpdates: Array<{ id: string; is_on: boolean }>,
): Promise<void> {
  for (const [serverId, check] of [...wakeChecks]) {
    const up = await deps.probeReachable(check.url);
    if (up) {
      wakeChecks.delete(serverId);
      serverUpdates.push({ id: serverId, is_on: true });
      log("poller.wake.verified", {
        phase: "complete",
        serverId,
        afterMs: deps.now() - check.sentAt,
      });
    } else if (deps.now() >= check.deadline) {
      wakeChecks.delete(serverId);
      log("poller.wake.unverified", {
        phase: "failed",
        level: "warn",
        serverId,
        url: safeUrlForLog(check.url),
        afterMs: deps.now() - check.sentAt,
        error: "magic packet sent but manage_url did not respond in time",
      });
    }
  }
}

let ticking = false;

/** Log host+pathname only — drop query/hash so tokens in URLs are not written. */
function safeUrlForLog(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return value.split("?")[0]?.split("#")[0] || value;
  }
}

async function api(cfg: PollerConfig, deps: PollerDeps, path: string, init?: RequestInit) {
  const method = init?.method || "GET";
  log("poller.api.received", { phase: "received", method, path });
  log("poller.api.processing", { phase: "processing", method, path });
  const started = performance.now();
  try {
    const res = await deps.fetchImpl(`${cfg.janitorApiUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${cfg.token}`,
        "content-type": "application/json",
        ...(init?.headers || {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error((data as { error?: string }).error || `${res.status} ${path}`);
    }
    log("poller.api.complete", {
      phase: "complete",
      method,
      path,
      status: res.status,
      ms: Math.round(performance.now() - started),
    });
    return data;
  } catch (error) {
    log("poller.api.failed", {
      phase: "failed",
      method,
      path,
      ms: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

type ServiceResult = {
  id: string;
  name: string;
  host?: string;
  url?: string;
  ok: boolean;
  code: number;
  expect: number;
  ms: number;
  error?: string;
  slackOnFail: boolean;
};

export async function handleJobs(cfg: PollerConfig, snapshot: PollSnapshot, deps: PollerDeps = defaultDeps()) {
  const jobResults: Array<{ id: string; status: "done" | "error"; result?: unknown; error?: string }> = [];
  const serviceResults: ServiceResult[] = [];
  const serverUpdates: Array<{ id: string; is_on: boolean }> = [];
  const guests: Array<{
    server_id: string;
    name: string;
    node: string;
    kind: string;
    is_on: boolean;
    vmid?: number;
  }> = [];
  const guestSyncServerIds: string[] = [];
  const guestSyncFailedNodes: Record<string, string[]> = {};
  const pveNodes: Array<{ server_id: string; nodes: Array<{ node: string; online: boolean }> }> = [];
  let speed: { down_mbps: number; up_mbps: number | null } | undefined;
  let publicIp: string | undefined;
  /** pm2 app to restart once the report for this tick has gone out. */
  let restartAfterReport: string | null = null;

  const finishJob = (
    job: { id?: string },
    entry: { status: "done" | "error"; result?: unknown; error?: string },
  ) => {
    if (!isPersistedJobId(job.id)) return;
    jobResults.push({ id: job.id, ...entry });
  };

  await verifyPendingWakes(deps, serverUpdates);

  for (const job of orderJobs(snapshot.jobs || [])) {
    const jobBase = { jobId: job.id, kind: job.kind, scheduled: isScheduledJob(job) };
    log("poller.job.received", { ...jobBase, phase: "received", payload: job.payload });
    log("poller.job.processing", { ...jobBase, phase: "processing" });
    const jobStarted = performance.now();
    const jobStartedAt = deps.now();
    let jobOk = false;

    try {
      if (job.kind === "wake") {
        const server = (snapshot.servers || []).find((s) => s.id === job.payload?.serverId);
        if (!server) throw new Error("server not found");
        const mode = String(server.wol_mode || "off");
        log("poller.wake.processing", {
          ...jobBase,
          phase: "processing",
          serverId: server.id,
          mode,
        });
        if (mode !== "manual" || !server.wol_mac) {
          throw new Error("WOL is not configured: register the server's MAC address");
        }
        const result = await deps.sendMagicPacket({
          mac: String(server.wol_mac),
          broadcast: server.wol_broadcast ? String(server.wol_broadcast) : null,
          port: server.wol_port ? Number(server.wol_port) : null,
        });
        log("poller.wake.complete", { ...jobBase, phase: "complete", ...result });
        // is_on flips only after manage_url answers on a later tick.
        const manage = assertAllowedHttpUrl(String(server.manage_url || ""));
        const deadline = deps.now() + WAKE_VERIFY_MS;
        if (manage.ok) {
          wakeChecks.set(String(server.id), { url: manage.url, deadline, sentAt: deps.now() });
        }
        finishJob(job, {
          status: "done",
          result: {
            mode,
            state: "sent",
            packets: result.sent,
            verify: manage.ok ? "pending" : "unavailable",
            verifyUntil: manage.ok ? new Date(deadline).toISOString() : null,
          },
        });
      } else if (job.kind === "health_one" || job.kind === "health_all") {
        const list =
          job.kind === "health_one"
            ? (snapshot.services || []).filter((s) => s.id === job.payload?.serviceId)
            : snapshot.services || [];
        const results = await mapLimit(list, HEALTH_CONCURRENCY, async (service): Promise<ServiceResult> => {
          const expect = Number(service.expect_status || 200);
          const allowed = assertAllowedHttpUrl(String(service.health_url || ""));
          if (!allowed.ok) {
            log("poller.health.rejected", {
              ...jobBase,
              phase: "rejected",
              serviceId: service.id,
              url: safeUrlForLog(service.health_url),
              error: allowed.error,
            });
            return {
              id: String(service.id),
              name: String(service.name || service.id),
              host: service.host_label ? String(service.host_label) : undefined,
              url: String(service.health_url),
              ok: false,
              code: 0,
              expect,
              ms: 0,
              error: allowed.error,
              slackOnFail: service.slack_on_fail !== false,
            };
          }
          log("poller.health.processing", {
            ...jobBase,
            phase: "processing",
            serviceId: service.id,
            url: safeUrlForLog(allowed.url),
          });
          // HEALTHCHECK_TOKEN goes only to services that opted in (services.use_health_token).
          const sendToken = service.use_health_token === true && Boolean(cfg.healthcheckToken);
          const result = await deps.checkHttp({
            url: allowed.url,
            expectStatus: expect,
            authorization: sendToken ? `Bearer ${cfg.healthcheckToken}` : undefined,
          });
          log("poller.health.complete", {
            ...jobBase,
            phase: "complete",
            serviceId: service.id,
            ok: result.ok,
            status: result.status,
            ms: result.ms,
          });
          return {
            id: String(service.id),
            name: String(service.name || service.id),
            host: service.host_label ? String(service.host_label) : undefined,
            url: allowed.url,
            ok: result.ok,
            code: result.status,
            expect,
            ms: result.ms,
            error: result.error,
            slackOnFail: service.slack_on_fail !== false,
          };
        });
        serviceResults.push(...results);
        finishJob(job, {
          status: "done",
          result: { count: results.length, failed: results.filter((r) => !r.ok).length },
        });
      } else if (job.kind === "pve_sync") {
        const onlyId = job.payload?.serverId ? String(job.payload.serverId) : null;
        let jobGuests = 0;
        let jobServers = 0;
        const failures: string[] = [];
        for (const server of snapshot.servers || []) {
          if (!server.pve_enabled) continue;
          if (onlyId && String(server.id) !== onlyId) continue;
          const secret = snapshot.secrets?.[String(server.id)];
          if (!secret || !server.pve_host || !server.pve_token_id) continue;
          const pveUrl = await assertAllowedHttpUrlResolved(String(server.pve_host));
          if (!pveUrl.ok) {
            log("poller.pve.rejected", {
              ...jobBase,
              phase: "rejected",
              serverId: server.id,
              error: pveUrl.error,
            });
            failures.push(`${server.id}: ${pveUrl.error}`);
            continue;
          }
          log("poller.pve.processing", {
            ...jobBase,
            phase: "processing",
            serverId: server.id,
            nodeFilter: server.pve_node || null,
          });
          try {
            const synced = await deps.syncPveGuests({
              serverId: String(server.id),
              baseUrl: pveUrl.url,
              tokenId: String(server.pve_token_id),
              tokenSecret: secret,
              // Empty node → discover every node on this API root.
              nodeFilter: server.pve_node ? String(server.pve_node) : null,
              tlsInsecure: cfg.pveTlsInsecure,
            });
            guestSyncServerIds.push(String(server.id));
            guests.push(...synced.guests);
            if (synced.failedNodes.length) guestSyncFailedNodes[String(server.id)] = synced.failedNodes;
            if (synced.discovered) pveNodes.push({ server_id: String(server.id), nodes: synced.discovered });
            jobGuests += synced.guests.length;
            jobServers += 1;
            log("poller.pve.complete", {
              ...jobBase,
              phase: "complete",
              serverId: server.id,
              nodes: synced.nodes,
              failedNodes: synced.failedNodes,
              guests: synced.guests.length,
            });
          } catch (error) {
            // Node list failed: leave this link out of guestSyncServerIds / pveNodes so
            // nothing is pruned or deleted on the Worker side.
            const messageText = error instanceof Error ? error.message : String(error);
            failures.push(`${server.id}: ${messageText}`);
            log("poller.pve.failed", { ...jobBase, phase: "failed", serverId: server.id, error: messageText });
          }
        }
        if (failures.length && jobServers === 0) {
          throw new Error(`Proxmox 동기화 실패: ${failures.join("; ")}`);
        }
        finishJob(job, {
          status: "done",
          result: { guests: jobGuests, servers: jobServers, failed: failures.length ? failures : undefined },
        });
      } else if (job.kind === "public_ip") {
        const result = await deps.resolvePublicIp();
        publicIp = result.ip;
        log("poller.public_ip.complete", { ...jobBase, phase: "complete", ip: result.ip, source: result.source });
        finishJob(job, { status: "done", result });
      } else if (job.kind === "speed_probe") {
        log("poller.speed.received", {
          ...jobBase,
          phase: "received",
          provider: cfg.speedTestProvider,
          durationMs: cfg.speedTestDurationMs,
          connections: cfg.speedTestConnections,
        });
        log("poller.speed.processing", { ...jobBase, phase: "processing" });
        // A failed probe throws → job error and no `speed` in the report.
        const result = await deps.runSpeedTest({
          provider: cfg.speedTestProvider,
          durationMs: cfg.speedTestDurationMs,
          connections: cfg.speedTestConnections,
          measureUpload: true,
        });
        speed = {
          down_mbps: result.down_mbps,
          up_mbps: result.up_mbps,
        };
        log("poller.speed.complete", {
          ...jobBase,
          phase: "complete",
          ...result,
        });
        finishJob(job, { status: "done", result });
      } else if (job.kind === "agent_update") {
        const result = await deps.runSelfUpdate(cfg);
        if (result.restartScheduled && result.pm2AppName) restartAfterReport = result.pm2AppName;
        finishJob(job, { status: "done", result });
      } else {
        throw new Error("unknown job");
      }

      jobOk = true;
      log("poller.job.complete", {
        ...jobBase,
        phase: "complete",
        ms: Math.round(performance.now() - jobStarted),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("poller.job.failed", {
        ...jobBase,
        phase: "failed",
        ms: Math.round(performance.now() - jobStarted),
        error: message,
      });
      finishJob(job, { status: "error", error: message });
    } finally {
      // Remember attempts locally (scheduled or explicit) for the scheduler.
      // health_one covers a single service, so it does not reset the health_all clock.
      if (isScheduleKind(job.kind)) deps.scheduleMemory.note(job.kind, jobOk, jobStartedAt);
    }
  }

  return {
    jobResults,
    serviceResults,
    serverUpdates,
    guests,
    guestSyncServerIds,
    guestSyncFailedNodes,
    pveNodes,
    speed,
    publicIp,
    restartAfterReport,
  };
}

export type TickOutcome = { started: true } | { started: false; reason: "already_running" };

export async function tick(cfg: PollerConfig, overrides: Partial<PollerDeps> = {}): Promise<TickOutcome> {
  if (ticking) {
    log("tick_skipped", { phase: "skipped", reason: "already_running" });
    return { started: false, reason: "already_running" };
  }
  const deps: PollerDeps = { ...defaultDeps(), ...overrides };
  ticking = true;
  log("tick.received", { phase: "received" });
  log("tick.processing", { phase: "processing" });
  const started = performance.now();
  let restartApp: string | null = null;
  try {
    const snapshot = withScheduledJobs((await api(cfg, deps, "/api/agent/poll")) as PollSnapshot, deps);
    const handled = await handleJobs(cfg, snapshot, deps);
    restartApp = handled.restartAfterReport;
    const agentStatus = collectRuntimeStatus(cfg);
    const reportBody: Record<string, unknown> = {
      houseName: snapshot.house?.name,
      agentHostLabel: cfg.hostLabel || cfg.tunnelHostname || agentStatus.hostname,
      agentStatus,
      servers: handled.serverUpdates,
      services: handled.serviceResults,
      guests: handled.guests,
      guestSyncServerIds: handled.guestSyncServerIds,
      pveNodes: handled.pveNodes,
      jobs: handled.jobResults.map((j) => ({
        id: j.id,
        kind: snapshot.jobs?.find((job) => job.id === j.id)?.kind,
        status: j.status,
        error: j.error,
        result: j.result,
      })),
    };
    if (Object.keys(handled.guestSyncFailedNodes).length) {
      reportBody.guestSyncFailedNodes = handled.guestSyncFailedNodes;
    }
    // Only refresh public IP when the schedule (or an explicit job) asked for it.
    if (handled.publicIp) reportBody.publicIp = handled.publicIp;
    if (handled.speed) reportBody.speed = handled.speed;
    log("tick.complete", {
      phase: "complete",
      house: snapshot.house?.name,
      jobs: (snapshot.jobs || []).length,
      publicIp: handled.publicIp ?? null,
      speed: handled.speed ?? null,
      agentVersion: agentStatus.version,
      pm2: agentStatus.pm2,
      restartPending: restartApp,
      ms: Math.round(performance.now() - started),
    });
    const logs = drainLogBuffer();
    reportBody.logs = logs;
    const sendReport = () =>
      api(cfg, deps, "/api/agent/report", {
        method: "POST",
        body: JSON.stringify(reportBody),
      });
    try {
      try {
        await sendReport();
      } catch (error) {
        // The update result must reach the Worker before we restart: retry once.
        if (!restartApp) throw error;
        await new Promise((r) => setTimeout(r, deps.reportRetryDelayMs));
        await sendReport();
      }
    } catch (error) {
      restoreLogBuffer(logs);
      throw error;
    }
  } catch (err) {
    log("tick.failed", {
      phase: "failed",
      ms: Math.round(performance.now() - started),
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    ticking = false;
    // Restart even if the report failed twice — never leave new code on disk unloaded forever.
    if (restartApp) deps.restartPm2(restartApp);
  }
  return { started: true };
}

export function startPoller(cfg: PollerConfig): void {
  let failures = 0;
  const loop = async () => {
    let delay = cfg.pollMs;
    try {
      await tick(cfg);
      failures = 0;
    } catch {
      // tick() already emitted tick.failed — only note the backoff.
      failures += 1;
      delay = pollBackoffMs(cfg.pollMs, failures);
      log("poller.backoff", { phase: "scheduled", failures, delayMs: delay });
    } finally {
      setTimeout(loop, delay);
    }
  };
  void loop();
}
