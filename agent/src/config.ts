export type AgentConfig = {
  token: string;
  port: number;
  host: string;
  tunnelHostname?: string;
  healthcheckToken?: string;
  /** When set, agent polls the Worker job queue with AGENT_TOKEN. */
  janitorApiUrl?: string;
  pollMs: number;
  hostLabel?: string;
  /**
   * Legacy single-shot byte cap (kept for env compat).
   * Fast.com-style tests prefer duration/connections below.
   */
  speedProbeBytes: number;
  /** Sustained download window for speed_probe (default 12s). */
  speedTestDurationMs: number;
  /** Parallel CDN connections (default 4, Fast.com-like). */
  speedTestConnections: number;
  /** fast | cloudflare | auto (default auto: Fast.com then Cloudflare fallback). */
  speedTestProvider: "fast" | "cloudflare" | "auto";
  /** Opt-in: allow dashboard-triggered git pull + npm install + pm2 restart. */
  allowRemoteUpdate: boolean;
  /** pm2 process name used for remote restart (defaults to PM2_APP_NAME / process.name). */
  pm2AppName?: string;
  /** Repo/workdir for remote updates (defaults to process.cwd()). */
  agentRepoDir?: string;
};

export function readConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const token = env.AGENT_TOKEN?.trim();
  if (!token) throw new Error("AGENT_TOKEN is required");

  const port = Number(env.PORT ?? "3920");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const pollMs = Number(env.AGENT_POLL_MS ?? "15000");
  if (!Number.isFinite(pollMs) || pollMs < 3000) {
    throw new Error("AGENT_POLL_MS must be >= 3000");
  }

  const speedProbeBytes = Number(env.SPEED_PROBE_BYTES ?? "2000000");
  if (!Number.isInteger(speedProbeBytes) || speedProbeBytes < 1000 || speedProbeBytes > 5_000_000) {
    throw new Error("SPEED_PROBE_BYTES must be between 1000 and 5000000");
  }

  const speedTestDurationMs = Number(env.SPEEDTEST_DURATION_MS ?? "12000");
  if (!Number.isInteger(speedTestDurationMs) || speedTestDurationMs < 3000 || speedTestDurationMs > 60_000) {
    throw new Error("SPEEDTEST_DURATION_MS must be between 3000 and 60000");
  }

  const speedTestConnections = Number(env.SPEEDTEST_CONNECTIONS ?? "4");
  if (!Number.isInteger(speedTestConnections) || speedTestConnections < 1 || speedTestConnections > 8) {
    throw new Error("SPEEDTEST_CONNECTIONS must be between 1 and 8");
  }

  const providerRaw = (env.SPEEDTEST_PROVIDER?.trim() || "auto").toLowerCase();
  if (providerRaw !== "fast" && providerRaw !== "cloudflare" && providerRaw !== "auto") {
    throw new Error("SPEEDTEST_PROVIDER must be fast, cloudflare, or auto");
  }
  const speedTestProvider = providerRaw as "fast" | "cloudflare" | "auto";

  const allowRemoteUpdate = /^(1|true|yes)$/i.test(env.AGENT_ALLOW_REMOTE_UPDATE?.trim() || "");

  return {
    token,
    port,
    host: env.HOST?.trim() || "0.0.0.0",
    tunnelHostname: env.CF_TUNNEL_HOSTNAME?.trim() || undefined,
    healthcheckToken: env.HEALTHCHECK_TOKEN?.trim() || undefined,
    janitorApiUrl: env.JANITOR_API_URL?.trim().replace(/\/$/, "") || undefined,
    pollMs,
    hostLabel: env.AGENT_HOST_LABEL?.trim() || undefined,
    speedProbeBytes,
    speedTestDurationMs,
    speedTestConnections,
    speedTestProvider,
    allowRemoteUpdate,
    pm2AppName: env.PM2_APP_NAME?.trim() || undefined,
    agentRepoDir: env.AGENT_REPO_DIR?.trim() || undefined,
  };
}
