import { checkHttp } from "./health-check.js";
import type { AgentConfig } from "./config.js";
import { resolvePublicIp } from "./public-ip.js";
import { log } from "./log.js";
import { collectRuntimeStatus } from "./runtime-status.js";
import { runSelfUpdate } from "./self-update.js";
import { runSpeedTest } from "./speedtest.js";
import { assertAllowedHttpUrl } from "./url-guard.js";
import { syncPveGuests } from "./pve-sync.js";
import { scheduledKinds } from "./schedule.js";
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPersistedJobId(id: unknown): id is string {
  return typeof id === "string" && UUID_RE.test(id);
}

function withScheduledJobs(snapshot: PollSnapshot): PollSnapshot {
  const pending = (snapshot.jobs || []).map((j) => j.kind);
  const hasPve = (snapshot.servers || []).some((s) => s.pve_enabled);
  const due = scheduledKinds({
    house: snapshot.house || {},
    services: (snapshot.services || []) as Array<{ last_checked_at?: string | null }>,
    hasPve,
    pendingKinds: pending,
  });
  if (!due.length) return snapshot;
  const scheduled = due.map((kind) => ({ id: `sched-${kind}`, kind, payload: { scheduled: true } }));
  log("poller.schedule", { phase: "due", kinds: due });
  return { ...snapshot, jobs: [...(snapshot.jobs || []), ...scheduled] };
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

async function api(cfg: PollerConfig, path: string, init?: RequestInit) {
  const method = init?.method || "GET";
  log("poller.api.received", { phase: "received", method, path });
  log("poller.api.processing", { phase: "processing", method, path });
  const started = performance.now();
  try {
    const res = await fetch(`${cfg.janitorApiUrl}${path}`, {
      ...init,
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

async function handleJobs(cfg: PollerConfig, snapshot: PollSnapshot) {
  const jobResults: Array<{ id: string; status: "done" | "error"; result?: unknown; error?: string }> = [];
  const serviceResults: Array<{
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
  }> = [];
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
  let speed: { down_mbps: number; up_mbps: number } | undefined;
  let publicIp: string | undefined;

  const finishJob = (
    job: { id?: string },
    entry: { status: "done" | "error"; result?: unknown; error?: string },
  ) => {
    if (!isPersistedJobId(job.id)) return;
    jobResults.push({ id: job.id, ...entry });
  };

  for (const job of snapshot.jobs || []) {
    const jobBase = { jobId: job.id, kind: job.kind, scheduled: Boolean(job.payload?.scheduled) };
    log("poller.job.received", { ...jobBase, phase: "received", payload: job.payload });
    log("poller.job.processing", { ...jobBase, phase: "processing" });
    const jobStarted = performance.now();

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
        const result = await sendMagicPacket({
          mac: String(server.wol_mac),
          broadcast: server.wol_broadcast ? String(server.wol_broadcast) : null,
          port: server.wol_port ? Number(server.wol_port) : null,
        });
        log("poller.wake.complete", { ...jobBase, phase: "complete", ...result });
        serverUpdates.push({ id: String(server.id), is_on: true });
        finishJob(job, { status: "done", result: { mode } });
      } else if (job.kind === "health_one" || job.kind === "health_all") {
        const list =
          job.kind === "health_one"
            ? (snapshot.services || []).filter((s) => s.id === job.payload?.serviceId)
            : snapshot.services || [];
        for (const service of list) {
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
            serviceResults.push({
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
            });
            continue;
          }
          log("poller.health.processing", {
            ...jobBase,
            phase: "processing",
            serviceId: service.id,
            url: safeUrlForLog(allowed.url),
          });
          const result = await checkHttp({
            url: allowed.url,
            expectStatus: expect,
            authorization: cfg.healthcheckToken
              ? `Bearer ${cfg.healthcheckToken}`
              : undefined,
          });
          log("poller.health.complete", {
            ...jobBase,
            phase: "complete",
            serviceId: service.id,
            ok: result.ok,
            status: result.status,
            ms: result.ms,
          });
          serviceResults.push({
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
          });
        }
        finishJob(job, { status: "done", result: { count: serviceResults.length } });
      } else if (job.kind === "pve_sync") {
        const onlyId = job.payload?.serverId ? String(job.payload.serverId) : null;
        for (const server of snapshot.servers || []) {
          if (!server.pve_enabled) continue;
          if (onlyId && String(server.id) !== onlyId) continue;
          const secret = snapshot.secrets?.[String(server.id)];
          if (!secret || !server.pve_host || !server.pve_token_id) continue;
          const pveUrl = assertAllowedHttpUrl(String(server.pve_host));
          if (!pveUrl.ok) {
            log("poller.pve.rejected", {
              ...jobBase,
              phase: "rejected",
              serverId: server.id,
              error: pveUrl.error,
            });
            continue;
          }
          log("poller.pve.processing", {
            ...jobBase,
            phase: "processing",
            serverId: server.id,
            nodeFilter: server.pve_node || null,
          });
          const synced = await syncPveGuests({
            serverId: String(server.id),
            baseUrl: pveUrl.url,
            tokenId: String(server.pve_token_id),
            tokenSecret: secret,
            // Empty node → discover every node on this API root.
            nodeFilter: server.pve_node ? String(server.pve_node) : null,
          });
          guestSyncServerIds.push(String(server.id));
          guests.push(...synced.guests);
          log("poller.pve.complete", {
            ...jobBase,
            phase: "complete",
            serverId: server.id,
            nodes: synced.nodes,
            guests: synced.guests.length,
          });
        }
        finishJob(job, {
          status: "done",
          result: { guests: guests.length, servers: guestSyncServerIds.length },
        });
      } else if (job.kind === "public_ip") {
        const result = await resolvePublicIp();
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
        const result = await runSpeedTest({
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
        const result = await runSelfUpdate(cfg);
        finishJob(job, { status: "done", result });
      } else {
        throw new Error("unknown job");
      }

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
    }
  }

  return { jobResults, serviceResults, serverUpdates, guests, guestSyncServerIds, speed, publicIp };
}

export async function tick(cfg: PollerConfig): Promise<void> {
  if (ticking) {
    log("tick_skipped", { phase: "skipped", reason: "already_running" });
    return;
  }
  ticking = true;
  log("tick.received", { phase: "received" });
  log("tick.processing", { phase: "processing" });
  const started = performance.now();
  try {
    const snapshot = withScheduledJobs((await api(cfg, "/api/agent/poll")) as PollSnapshot);
    const handled = await handleJobs(cfg, snapshot);
    const agentStatus = collectRuntimeStatus(cfg);
    const reportBody: Record<string, unknown> = {
      houseName: snapshot.house?.name,
      agentHostLabel: cfg.hostLabel || cfg.tunnelHostname || agentStatus.hostname,
      agentStatus,
      servers: handled.serverUpdates,
      services: handled.serviceResults,
      guests: handled.guests,
      guestSyncServerIds: handled.guestSyncServerIds,
      jobs: handled.jobResults.map((j) => ({
        id: j.id,
        kind: snapshot.jobs?.find((job) => job.id === j.id)?.kind,
        status: j.status,
        error: j.error,
        result: j.result,
      })),
    };
    // Only refresh public IP when the schedule (or an explicit job) asked for it.
    if (handled.publicIp) reportBody.publicIp = handled.publicIp;
    if (handled.speed) reportBody.speed = handled.speed;
    await api(cfg, "/api/agent/report", {
      method: "POST",
      body: JSON.stringify(reportBody),
    });
    log("tick.complete", {
      phase: "complete",
      house: snapshot.house?.name,
      jobs: (snapshot.jobs || []).length,
      publicIp: handled.publicIp ?? null,
      speed: handled.speed ?? null,
      agentVersion: agentStatus.version,
      pm2: agentStatus.pm2,
      ms: Math.round(performance.now() - started),
    });
  } catch (err) {
    log("tick.failed", {
      phase: "failed",
      ms: Math.round(performance.now() - started),
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    ticking = false;
  }
}

export function startPoller(cfg: PollerConfig): void {
  const loop = async () => {
    try {
      await tick(cfg);
    } catch {
      // tick() already emitted tick.failed — do not log again.
    } finally {
      setTimeout(loop, cfg.pollMs);
    }
  };
  void loop();
}
