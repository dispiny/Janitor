export type AgentConfig = {
  token: string;
  port: number;
  host: string;
  tunnelHostname?: string;
  uplusRouterUrl?: string;
  uplusRouterPassword?: string;
  healthcheckToken?: string;
  /** When set, agent polls the Worker job queue with AGENT_TOKEN. */
  janitorApiUrl?: string;
  pollMs: number;
  hostLabel?: string;
  /** Cap for speed_probe download sample (default 2 MiB). */
  speedProbeBytes: number;
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

  return {
    token,
    port,
    host: env.HOST?.trim() || "0.0.0.0",
    tunnelHostname: env.CF_TUNNEL_HOSTNAME?.trim() || undefined,
    uplusRouterUrl: env.UPLUS_ROUTER_URL?.trim() || undefined,
    uplusRouterPassword: env.UPLUS_ROUTER_PASSWORD?.trim() || undefined,
    healthcheckToken: env.HEALTHCHECK_TOKEN?.trim() || undefined,
    janitorApiUrl: env.JANITOR_API_URL?.trim().replace(/\/$/, "") || undefined,
    pollMs,
    hostLabel: env.AGENT_HOST_LABEL?.trim() || undefined,
    speedProbeBytes,
  };
}
