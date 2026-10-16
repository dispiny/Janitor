import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentConfig } from "./config.js";
import { log } from "./log.js";

export type SelfUpdateResult = {
  ok: true;
  repoDir: string;
  packageDir: string;
  previousHead?: string;
  head?: string;
  gitPull?: string;
  gitStash?: string;
  /** Stash commit holding local tracked edits (kept, never dropped). */
  gitStashRef?: string;
  signatureVerified?: boolean;
  rootNpmInstall?: string;
  deploy?: string;
  npmInstall?: string;
  /**
   * pm2 restart is pending — the poller runs it only after this tick's report
   * (job result) has been delivered. Field name kept for the Worker / Slack contract.
   */
  restartScheduled: boolean;
  pm2AppName: string | null;
  deployOnUpdate: boolean;
  note: string;
};

export type RunCommand = (
  cmd: string,
  args: string[],
  cwd: string,
  opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
) => Promise<string>;

export type SelfUpdateDeps = {
  run?: RunCommand;
  exists?: (path: string) => Promise<boolean>;
};

/**
 * Spawn in its own process group (detached) so a timeout kills npm *and* the
 * wrangler / node children it started, not just the npm wrapper.
 */
export const runCommand: RunCommand = (cmd, args, cwd, opts = {}) => {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let out = "";
    let err = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      finish(() => reject(new Error(`${cmd} ${args.join(" ")} timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => {
      const text = (out + err).trim().slice(0, 4000);
      finish(() => {
        if (code === 0) resolve(text || "ok");
        else reject(new Error(`${cmd} ${args.join(" ")} failed (${code}): ${text || "no output"}`));
      });
    });
  });
};

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function findGitRoot(start: string, exists: (p: string) => Promise<boolean>): Promise<string | null> {
  let dir = start;
  for (;;) {
    if (await exists(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Restart the agent under pm2. Call only after the tick's report was sent.
 * Spawn errors (pm2 not on PATH) are logged, never thrown — no uncaught crash.
 */
export function restartPm2(appName: string): void {
  try {
    const child = spawn("pm2", ["restart", appName, "--update-env"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.on("error", (error) => {
      log("self_update.pm2.failed", { phase: "failed", appName, error: error.message });
    });
    child.unref();
    log("self_update.pm2.restart", { phase: "processing", appName });
  } catch (error) {
    log("self_update.pm2.failed", {
      phase: "failed",
      appName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runSelfUpdate(cfg: AgentConfig, deps: SelfUpdateDeps = {}): Promise<SelfUpdateResult> {
  if (!cfg.allowRemoteUpdate) {
    throw new Error("AGENT_ALLOW_REMOTE_UPDATE is not enabled on this agent");
  }
  const run = deps.run ?? runCommand;
  const exists = deps.exists ?? fileExists;
  const npmInstallIn = async (dir: string): Promise<string> =>
    (await exists(join(dir, "package-lock.json"))) ? run("npm", ["ci"], dir) : run("npm", ["install"], dir);

  // Package dir = agent/ (where package.json + tsx live)
  const packageDir = cfg.agentRepoDir || process.cwd();
  const gitRoot = (await findGitRoot(packageDir, exists)) || packageDir;
  const isGit = await exists(join(gitRoot, ".git"));
  let previousHead: string | undefined;
  let head: string | undefined;
  let gitPull: string | undefined;
  let gitStash: string | undefined;
  let gitStashRef: string | undefined;
  let signatureVerified: boolean | undefined;
  let rootNpmInstall: string | undefined;
  let deploy: string | undefined;
  let npmInstall: string | undefined;

  if (isGit) {
    await run("git", ["fetch", "--all", "--prune"], gitRoot);
    previousHead = (await run("git", ["rev-parse", "HEAD"], gitRoot)).trim();
    // Tracked local edits (e.g. hand-edited wrangler.jsonc) block ff-only pull.
    // Stash them and KEEP the stash — `git stash list` / `git stash pop` to recover.
    const dirty = (await run("git", ["status", "--porcelain", "--untracked-files=no"], gitRoot)).trim();
    if (dirty && dirty !== "ok") {
      gitStash = await run(
        "git",
        ["stash", "push", "-m", `janitor-agent-update-${Date.now()}`],
        gitRoot,
      );
      if (!/No local changes to save/i.test(gitStash)) {
        gitStashRef = (await run("git", ["rev-parse", "--short", "stash@{0}"], gitRoot).catch(() => "")).trim() || "stash@{0}";
      }
      log("self_update.git.stash", { phase: "stashed", dirty: dirty.slice(0, 500), stashRef: gitStashRef ?? null });
    }
    try {
      gitPull = await run("git", ["pull", "--ff-only"], gitRoot);
    } catch (error) {
      if (gitStashRef) {
        await run("git", ["stash", "pop"], gitRoot).catch(() => undefined);
      }
      throw error;
    }
    head = (await run("git", ["rev-parse", "HEAD"], gitRoot)).trim();

    if (cfg.requireSignedUpdate && head !== previousHead) {
      try {
        await run("git", ["verify-commit", head], gitRoot);
        signatureVerified = true;
      } catch (error) {
        await run("git", ["reset", "--hard", previousHead], gitRoot).catch(() => undefined);
        log("self_update.verify.failed", { phase: "failed", head, previousHead, error: message(error) });
        throw new Error(
          `AGENT_UPDATE_REQUIRE_SIGNED: ${head.slice(0, 12)} 서명 검증 실패 — ${previousHead.slice(0, 12)}로 되돌림: ${message(error)}`,
        );
      }
    }
  }

  let rootInstalled = false;
  try {
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
      rootInstalled = true;
      rootNpmInstall = await npmInstallIn(gitRoot);
      log("self_update.deploy.start", {
        cwd: gitRoot,
        customDomain: process.env.CLOUDFLARE_CUSTOM_DOMAIN || null,
        keepVars: true,
      });
      // CI=1 → wrangler skips the interactive "config differs" prompt (defaults to continue).
      // scripts/deploy.mjs uses --keep-vars and optional CLOUDFLARE_CUSTOM_DOMAIN routes.
      deploy = await run("npm", ["run", "deploy"], gitRoot, {
        timeoutMs: 300_000,
        env: { ...process.env, CI: "1" },
      });
      log("self_update.deploy.complete", { cwd: gitRoot });
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
  } catch (error) {
    if (!isGit || !previousHead) throw error;
    // Roll back code AND node_modules so the running process / next restart keeps working.
    log("self_update.rollback", { phase: "processing", to: previousHead, error: message(error) });
    const rollbackNotes: string[] = [];
    try {
      await run("git", ["reset", "--hard", previousHead], gitRoot);
      if (rootInstalled && gitRoot !== packageDir) {
        await npmInstallIn(gitRoot).catch((e) => rollbackNotes.push(`root npm 복구 실패: ${message(e)}`));
      }
      await npmInstallIn(packageDir).catch((e) => rollbackNotes.push(`agent npm 복구 실패: ${message(e)}`));
      log("self_update.rollback.complete", { phase: "complete", to: previousHead, notes: rollbackNotes });
    } catch (rollbackError) {
      rollbackNotes.push(`git reset 실패: ${message(rollbackError)}`);
      log("self_update.rollback.failed", { phase: "failed", error: message(rollbackError) });
    }
    const deployedNote = deploy ? " (Worker는 새 버전으로 이미 배포됨)" : "";
    const stashNote = gitStashRef ? ` 로컬 수정은 stash ${gitStashRef}에 보관.` : "";
    throw new Error(
      `${message(error)} — ${previousHead.slice(0, 12)}로 롤백${deployedNote}.${stashNote}${
        rollbackNotes.length ? ` ${rollbackNotes.join("; ")}` : ""
      }`,
    );
  }

  const pm2AppName =
    cfg.pm2AppName ||
    process.env.PM2_APP_NAME?.trim() ||
    process.env.name?.trim() ||
    null;

  const restartScheduled = Boolean(pm2AppName);

  const notes = [
    restartScheduled
      ? `pm2 restart ${pm2AppName} after report`
      : "Updated files; set PM2_APP_NAME to auto-restart under pm2",
    cfg.deployOnUpdate ? "Worker npm run deploy finished" : "Worker deploy skipped (AGENT_DEPLOY_ON_UPDATE=false)",
    gitStashRef ? `local tracked edits kept in git stash ${gitStashRef} (git stash list)` : "",
    signatureVerified ? `signed commit ${head?.slice(0, 12)} verified` : "",
  ].filter(Boolean);

  return {
    ok: true,
    repoDir: gitRoot,
    packageDir,
    previousHead,
    head,
    gitPull,
    gitStash,
    gitStashRef,
    signatureVerified,
    rootNpmInstall,
    deploy,
    npmInstall,
    restartScheduled,
    pm2AppName,
    deployOnUpdate: cfg.deployOnUpdate,
    note: notes.join("; "),
  };
}
