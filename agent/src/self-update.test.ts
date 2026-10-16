import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentConfig } from "./config.js";
import { runSelfUpdate, type RunCommand } from "./self-update.js";

const cfg: AgentConfig = {
  token: "t",
  port: 3920,
  host: "127.0.0.1",
  pollMs: 15000,
  speedProbeBytes: 2_000_000,
  speedTestDurationMs: 12_000,
  speedTestConnections: 4,
  speedTestProvider: "auto",
  allowRemoteUpdate: true,
  deployOnUpdate: false,
  pm2AppName: "janitor-agent",
  agentRepoDir: "/repo/agent",
};

/** Fake git/npm: HEAD moves from aaa → bbb on pull; `fail` decides which command breaks. */
function fakeRun(fail: (cmd: string, args: string[], calls: string[]) => boolean, dirty = "") {
  const calls: string[] = [];
  let head = "aaa111";
  const run: RunCommand = async (cmd, args, cwd) => {
    const line = `${cwd}$ ${cmd} ${args.join(" ")}`;
    calls.push(line);
    if (fail(cmd, args, calls)) throw new Error(`${cmd} ${args.join(" ")} failed (1): boom`);
    if (cmd === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return head;
    if (cmd === "git" && args[0] === "rev-parse") return "5ta5h";
    if (cmd === "git" && args[0] === "status") return dirty;
    if (cmd === "git" && args[0] === "stash") return "Saved working directory and index state";
    if (cmd === "git" && args[0] === "pull") {
      head = "bbb222";
      return "Fast-forward";
    }
    if (cmd === "git" && args[0] === "reset") {
      head = args[2];
      return "HEAD is now at";
    }
    return "ok";
  };
  return { run, calls };
}

const exists = async (path: string) =>
  path === "/repo/.git" ||
  path.endsWith("package.json") ||
  path.endsWith("package-lock.json") ||
  path.endsWith("loader.mjs");

describe("runSelfUpdate", () => {
  it("does not restart by itself; returns restartScheduled for the poller and keeps the stash", async () => {
    const { run, calls } = fakeRun(() => false, " M wrangler.jsonc");
    const result = await runSelfUpdate(cfg, { run, exists });
    assert.equal(result.restartScheduled, true);
    assert.equal(result.pm2AppName, "janitor-agent");
    assert.equal(result.previousHead, "aaa111");
    assert.equal(result.head, "bbb222");
    assert.equal(result.gitStashRef, "5ta5h");
    assert.match(result.note, /5ta5h/);
    assert.ok(!calls.some((c) => c.includes("stash drop")));
    assert.ok(!calls.some((c) => c.includes("pm2")));
  });

  it("rolls back to the previous HEAD and reinstalls node_modules when npm ci fails", async () => {
    let npmCalls = 0;
    const { run, calls } = fakeRun((cmd, args) => {
      if (cmd === "npm" && args[0] === "ci") {
        npmCalls += 1;
        return npmCalls === 1; // first install (new code) fails, restore succeeds
      }
      return false;
    });
    await assert.rejects(() => runSelfUpdate(cfg, { run, exists }), /aaa111로 롤백/);
    const resetAt = calls.findIndex((c) => c.includes("git reset --hard aaa111"));
    assert.ok(resetAt > 0, "git reset --hard <prev> ran");
    assert.ok(
      calls.slice(resetAt + 1).some((c) => c === "/repo/agent$ npm ci"),
      "npm ci re-ran after the reset",
    );
  });

  it("rolls back when the pulled commit fails signature verification", async () => {
    const { run, calls } = fakeRun((cmd, args) => cmd === "git" && args[0] === "verify-commit");
    await assert.rejects(
      () => runSelfUpdate({ ...cfg, requireSignedUpdate: true }, { run, exists }),
      /서명 검증 실패/,
    );
    assert.ok(calls.some((c) => c.includes("git reset --hard aaa111")));
    assert.ok(!calls.some((c) => c.endsWith("npm ci")), "nothing installed from the unsigned commit");
  });
});
