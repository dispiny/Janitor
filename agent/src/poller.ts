import { checkHttp } from "./health-check.js";
import type { AgentConfig } from "./config.js";
import { resolvePublicIp } from "./public-ip.js";
import { log } from "./log.js";
import { sendMagicPacket } from "./wol/magic-packet.js";
import { wakeViaUplus } from "./wol/uplus.js";

export type PollerConfig = AgentConfig & {
  janitorApiUrl: string;
  pollMs: number;
  hostLabel?: string;
  /** Max download bytes for optional speed_probe jobs (default 2_000_000). */
  speedProbeBytes: number;
};

type PollSnapshot = {
  house: { id: string; name: string; speed_threshold_mbps: number; slack_channel: string };
  jobs: Array<{ id: string; kind: string; payload?: Record<string, unknown> }>;
  servers: Array<Record<string, unknown>>;
  services: Array<Record<string, unknown>>;
  secrets: Record<string, string>;
};

let ticking = false;

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
  const serviceResults: Array<{ id: string; ok: boolean; code: number; ms: number }> = [];
  const serverUpdates: Array<{ id: string; is_on: boolean }> = [];
  const guests: Array<{
    server_id: string;
    name: string;
    kind: string;
    is_on: boolean;
    vmid?: number;
  }> = [];
  let speed: { down_mbps: number; up_mbps: number } | undefined;

  for (const job of snapshot.jobs || []) {
    const jobBase = { jobId: job.id, kind: job.kind };
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
        if (mode === "manual") {
          const result = await sendMagicPacket({
            mac: String(server.wol_mac),
            broadcast: String(server.wol_broadcast || "192.168.0.255"),
            port: Number(server.wol_port || 9),
          });
          log("poller.wake.complete", { ...jobBase, phase: "complete", ...result });
        } else if (mode === "uplus") {
          const result = await wakeViaUplus({
            device: String(server.wol_uplus_device || ""),
            routerUrl: cfg.uplusRouterUrl,
            routerPassword: cfg.uplusRouterPassword,
          });
          log("poller.wake.complete", { ...jobBase, phase: "complete", ...result });
        } else {
          throw new Error("WOL disabled");
        }
        serverUpdates.push({ id: String(server.id), is_on: true });
        jobResults.push({ id: job.id, status: "done", result: { mode } });
      } else if (job.kind === "health_one" || job.kind === "health_all") {
        const list =
          job.kind === "health_one"
            ? (snapshot.services || []).filter((s) => s.id === job.payload?.serviceId)
            : snapshot.services || [];
        for (const service of list) {
          log("poller.health.processing", {
            ...jobBase,
            phase: "processing",
            serviceId: service.id,
            url: service.health_url,
          });
          const result = await checkHttp({
            url: String(service.health_url),
            expectStatus: Number(service.expect_status || 200),
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
            ok: result.ok,
            code: result.status,
            ms: result.ms,
          });
        }
        jobResults.push({ id: job.id, status: "done", result: { count: serviceResults.length } });
      } else if (job.kind === "pve_sync") {
        for (const server of snapshot.servers || []) {
          if (!server.pve_enabled) continue;
          const secret = snapshot.secrets?.[String(server.id)];
          if (!secret || !server.pve_host || !server.pve_token_id || !server.pve_node) continue;
          log("poller.pve.processing", {
            ...jobBase,
            phase: "processing",
            serverId: server.id,
            node: server.pve_node,
          });
          const base = String(server.pve_host).replace(/\/$/, "");
          const auth = `${server.pve_token_id}=${secret}`;
          const headers = { Authorization: `PVEAPIToken=${auth}` };
          const node = encodeURIComponent(String(server.pve_node));
          const [qemu, lxc] = await Promise.all([
            fetch(`${base}/api2/json/nodes/${node}/qemu`, { headers, signal: AbortSignal.timeout(15000) }),
            fetch(`${base}/api2/json/nodes/${node}/lxc`, { headers, signal: AbortSignal.timeout(15000) }),
          ]);
          if (qemu.ok) {
            const body = (await qemu.json()) as { data?: Array<{ name?: string; vmid?: number; status?: string }> };
            for (const item of body.data || []) {
              guests.push({
                server_id: String(server.id),
                name: item.name || String(item.vmid),
                kind: "VM",
                is_on: item.status === "running",
                vmid: item.vmid,
              });
            }
          }
          if (lxc.ok) {
            const body = (await lxc.json()) as { data?: Array<{ name?: string; vmid?: number; status?: string }> };
            for (const item of body.data || []) {
              guests.push({
                server_id: String(server.id),
                name: item.name || String(item.vmid),
                kind: "LXC",
                is_on: item.status === "running",
                vmid: item.vmid,
              });
            }
          }
          log("poller.pve.complete", {
            ...jobBase,
            phase: "complete",
            serverId: server.id,
            guests: guests.filter((g) => g.server_id === String(server.id)).length,
          });
        }
        jobResults.push({ id: job.id, status: "done", result: { guests: guests.length } });
      } else if (job.kind === "speed_probe") {
        const bytes = cfg.speedProbeBytes;
        const url =
          process.env.SPEEDTEST_URL ||
          `https://speed.cloudflare.com/__down?bytes=${bytes}`;
        log("poller.speed.received", { ...jobBase, phase: "received", url, bytes });
        log("poller.speed.processing", { ...jobBase, phase: "processing", url, bytes });
        const started = Date.now();
        const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
        if (!res.ok || !res.body) throw new Error("speed probe failed");
        let read = 0;
        for await (const chunk of res.body) {
          read += chunk.byteLength;
          if (read >= bytes) break;
        }
        const ms = Date.now() - started;
        const seconds = Math.max(0.001, ms / 1000);
        speed = {
          down_mbps: Math.round(((read * 8) / seconds / 1_000_000) * 10) / 10,
          up_mbps: 0,
        };
        log("poller.speed.complete", {
          ...jobBase,
          phase: "complete",
          bytesRead: read,
          ms,
          down_mbps: speed.down_mbps,
          up_mbps: speed.up_mbps,
        });
        jobResults.push({ id: job.id, status: "done", result: speed });
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
      jobResults.push({
        id: job.id,
        status: "error",
        error: message,
      });
    }
  }

  return { jobResults, serviceResults, serverUpdates, guests, speed };
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
    const snapshot = (await api(cfg, "/api/agent/poll")) as PollSnapshot;
    const ip = await resolvePublicIp().catch(() => null);
    const handled = await handleJobs(cfg, snapshot);
    await api(cfg, "/api/agent/report", {
      method: "POST",
      body: JSON.stringify({
        publicIp: ip?.ip,
        agentHostLabel: cfg.hostLabel || cfg.tunnelHostname || undefined,
        servers: handled.serverUpdates,
        services: handled.serviceResults,
        guests: handled.guests,
        speed: handled.speed,
        jobs: handled.jobResults,
      }),
    });
    log("tick.complete", {
      phase: "complete",
      house: snapshot.house?.name,
      jobs: (snapshot.jobs || []).length,
      publicIp: ip?.ip ?? null,
      speed: handled.speed ?? null,
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
    } catch (err) {
      log("tick.failed", {
        phase: "failed",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTimeout(loop, cfg.pollMs);
    }
  };
  void loop();
}
