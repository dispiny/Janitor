import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentConfig } from "./config.js";

export type SelfUpdateResult = {
  ok: true;
  repoDir: string;
  packageDir: string;
  gitPull?: string;
  gitStash?: string;
  rootNpmInstall?: string;
  deploy?: string;
  npmInstall?: string;
  restartScheduled: boolean;
  pm2AppName: string | null;
  deployOnUpdate: boolean;
  note: string;
};

function run(cmd: string, args: string[], cwd: string, timeoutMs = 180_000): Promise<string> {
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

async function findGitRoot(start: string): Promise<string | null> {
  let dir = start;
  for (;;) {
    if (await exists(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function npmInstallIn(dir: string): Promise<string> {
  const hasLock = await exists(join(dir, "package-lock.json"));
  return hasLock ? run("npm", ["ci"], dir) : run("npm", ["install"], dir);
}

/** Schedule pm2 restart after the current tick can report job results. */
export function schedulePm2Restart(appName: string, delayMs = 2500): void {
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

  // Package dir = agent/ (where package.json + tsx live)
  const packageDir = cfg.agentRepoDir || process.cwd();
  const gitRoot = (await findGitRoot(packageDir)) || packageDir;
  let gitPull: string | undefined;
  let gitStash: string | undefined;
  let rootNpmInstall: string | undefined;
  let deploy: string | undefined;
  let npmInstall: string | undefined;

  if (await exists(join(gitRoot, ".git"))) {
    await run("git", ["fetch", "--all", "--prune"], gitRoot);
    // Tracked local edits (e.g. hand-edited wrangler.jsonc) block ff-only pull.
    // Stash them, pull remote, then drop the stash — host secrets stay in agent/.env (gitignored).
    const dirty = (await run("git", ["status", "--porcelain"], gitRoot)).trim();
    if (dirty && dirty !== "ok") {
      gitStash = await run(
        "git",
        ["stash", "push", "-m", `janitor-agent-update-${Date.now()}`],
        gitRoot,
      );
      console.log(JSON.stringify({ event: "self_update.git.stash", phase: "stashed", dirty: dirty.slice(0, 500) }));
    }
    try {
      gitPull = await run("git", ["pull", "--ff-only"], gitRoot);
    } catch (error) {
      if (gitStash) {
        await run("git", ["stash", "pop"], gitRoot).catch(() => undefined);
      }
      throw error;
    }
    if (gitStash && !/No local changes to save/i.test(gitStash)) {
      // Prefer remote tracked files; domain/secrets belong in env, not wrangler.jsonc.
      await run("git", ["stash", "drop"], gitRoot).catch(() => undefined);
      gitStash = `${gitStash}\n(dropped after pull — local tracked edits discarded)`;
    }
  }

  // Worker deploy from monorepo root (package.json "deploy": "wrangler deploy").
  if (cfg.deployOnUpdate) {
    if (!(await exists(join(gitRoot, "package.json")))) {
      throw new Error(`repo root package.json not found in ${gitRoot} — cannot npm run deploy`);
    }
    if (!process.env.CLOUDFLARE_API_TOKEN?.trim() && !process.env.CLOUDFLARE_API_KEY?.trim()) {
      throw new Error(
        "AGENT_DEPLOY_ON_UPDATE is on but CLOUDFLARE_API_TOKEN is missing on the agent host",
      );
    }
    rootNpmInstall = await npmInstallIn(gitRoot);
    console.log(
      JSON.stringify({
        event: "self_update.deploy.start",
        cwd: gitRoot,
        customDomain: process.env.CLOUDFLARE_CUSTOM_DOMAIN || null,
        keepVars: true,
      }),
    );
    // CI=1 → wrangler skips the interactive "config differs" prompt (defaults to continue).
    // scripts/deploy.mjs uses --keep-vars and optional CLOUDFLARE_CUSTOM_DOMAIN routes.
    deploy = await new Promise((resolve, reject) => {
      const child = spawn("npm", ["run", "deploy"], {
        cwd: gitRoot,
        env: { ...process.env, CI: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("npm run deploy timed out after 300000ms"));
      }, 300_000);
      child.stdout.on("data", (c) => {
        out += String(c);
      });
      child.stderr.on("data", (c) => {
        err += String(c);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const text = (out + err).trim().slice(0, 4000);
        if (code === 0) resolve(text || "ok");
        else reject(new Error(`npm run deploy failed (${code}): ${text || "no output"}`));
      });
    });
    console.log(JSON.stringify({ event: "self_update.deploy.complete", cwd: gitRoot }));
  }

  if (!(await exists(join(packageDir, "package.json")))) {
    throw new Error(`package.json not found in ${packageDir}`);
  }

  // Never --omit=dev: older package.json kept tsx in devDependencies; wiping it
  // breaks `node --import tsx` / pm2 after restart.
  npmInstall = await npmInstallIn(packageDir);

  const loader = join(packageDir, "node_modules/tsx/dist/loader.mjs");
  if (!(await exists(loader))) {
    npmInstall += "\n" + (await run("npm", ["install", "tsx"], packageDir));
  }
  if (!(await exists(loader))) {
    throw new Error("tsx loader missing after npm install; aborting restart");
  }

  const pm2AppName =
    cfg.pm2AppName ||
    process.env.PM2_APP_NAME?.trim() ||
    process.env.name?.trim() ||
    null;

  const restartScheduled = Boolean(pm2AppName);
  if (pm2AppName) schedulePm2Restart(pm2AppName);

  const notes = [
    restartScheduled ? `pm2 restart ${pm2AppName} scheduled` : "Updated files; set PM2_APP_NAME to auto-restart under pm2",
    cfg.deployOnUpdate ? "Worker npm run deploy finished" : "Worker deploy skipped (AGENT_DEPLOY_ON_UPDATE=false)",
    gitStash ? "stashed+dropped local tracked edits before pull" : "",
  ].filter(Boolean);

  return {
    ok: true,
    repoDir: gitRoot,
    packageDir,
    gitPull,
    gitStash,
    rootNpmInstall,
    deploy,
    npmInstall,
    restartScheduled,
    pm2AppName,
    deployOnUpdate: cfg.deployOnUpdate,
    note: notes.join("; "),
  };
}
