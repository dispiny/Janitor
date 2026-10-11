export type AgentConfig = {
  token: string;
  port: number;
  host: string;
  tunnelHostname?: string;
  uplusRouterUrl?: string;
  uplusRouterPassword?: string;
  healthcheckToken?: string;
};

export function readConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const token = env.AGENT_TOKEN?.trim();
  if (!token) throw new Error("AGENT_TOKEN is required");

  const port = Number(env.PORT ?? "3920");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  return {
    token,
    port,
    host: env.HOST?.trim() || "0.0.0.0",
    tunnelHostname: env.CF_TUNNEL_HOSTNAME?.trim() || undefined,
    uplusRouterUrl: env.UPLUS_ROUTER_URL?.trim() || undefined,
    uplusRouterPassword: env.UPLUS_ROUTER_PASSWORD?.trim() || undefined,
    healthcheckToken: env.HEALTHCHECK_TOKEN?.trim() || undefined,
  };
}
