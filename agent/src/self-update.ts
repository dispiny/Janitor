import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { AgentConfig } from "./config.js";

export type SelfUpdateResult = {
  ok: true;
  repoDir: string;
  gitPull?: string;
  npmInstall?: string;
  restartScheduled: boolean;
  pm2AppName: string | null;
  note: string;
};

function run(cmd: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = (out + err).trim().slice(0, 4000);
      if (code === 0) resolve(text || "ok");
      else reject(new Error(`${cmd} ${args.join(" ")} failed (${code}): ${text || "no output"}`));
    });
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Schedule pm2 restart after the current tick can report job results. */
export function schedulePm2Restart(appName: string, delayMs = 2000): void {
  setTimeout(() => {
    const child = spawn("pm2", ["restart", appName, "--update-env"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    console.log(JSON.stringify({ event: "pm2_restart_scheduled", appName }));
  }, delayMs);
}

export async function runSelfUpdate(cfg: AgentConfig): Promise<SelfUpdateResult> {
  if (!cfg.allowRemoteUpdate) {
    throw new Error("AGENT_ALLOW_REMOTE_UPDATE is not enabled on this agent");
  }

  const repoDir = cfg.agentRepoDir || process.cwd();
  const gitDir = join(repoDir, ".git");
  let gitPull: string | undefined;
  let npmInstall: string | undefined;

  if (await exists(gitDir)) {
    await run("git", ["fetch", "--all", "--prune"], repoDir);
    gitPull = await run("git", ["pull", "--ff-only"], repoDir);
  }

  if (await exists(join(repoDir, "package.json"))) {
    // Prefer lockfile install when present.
    const hasLock = await exists(join(repoDir, "package-lock.json"));
    npmInstall = hasLock
      ? await run("npm", ["ci", "--omit=dev"], repoDir)
      : await run("npm", ["install", "--omit=dev"], repoDir);
  }

  const pm2AppName =
    cfg.pm2AppName ||
    process.env.PM2_APP_NAME?.trim() ||
    process.env.name?.trim() ||
    null;

  const restartScheduled = Boolean(pm2AppName);
  if (pm2AppName) schedulePm2Restart(pm2AppName);

  return {
    ok: true,
    repoDir,
    gitPull,
    npmInstall,
    restartScheduled,
    pm2AppName,
    note: restartScheduled
      ? `pm2 restart ${pm2AppName} scheduled`
      : "Updated files; set PM2_APP_NAME to auto-restart under pm2",
  };
}
