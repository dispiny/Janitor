import { hostname } from "node:os";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "./config.js";

export type AgentRuntimeStatus = {
  version: string;
  node: string;
  platform: string;
  arch: string;
  hostname: string;
  uptimeSec: number;
  pid: number;
  cwd: string;
  pollMs: number;
  pm2: boolean;
  pm2Name: string | null;
  remoteUpdate: boolean;
  deployOnUpdate: boolean;
  reportedAt: string;
};

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function collectRuntimeStatus(cfg: AgentConfig): AgentRuntimeStatus {
  const pm2 = Boolean(process.env.PM2_HOME || process.env.pm_id || process.env.PM2_APP_NAME);
  const pm2Name =
    cfg.pm2AppName ||
    process.env.PM2_APP_NAME?.trim() ||
    process.env.name?.trim() ||
    null;

  return {
    version: readPackageVersion(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    hostname: hostname(),
    uptimeSec: Math.round(process.uptime()),
    pid: process.pid,
    cwd: process.cwd(),
    pollMs: cfg.pollMs,
    pm2,
    pm2Name,
    remoteUpdate: Boolean(cfg.allowRemoteUpdate),
    deployOnUpdate: Boolean(cfg.allowRemoteUpdate && cfg.deployOnUpdate),
    reportedAt: new Date().toISOString(),
  };
}
