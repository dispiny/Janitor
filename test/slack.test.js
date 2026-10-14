import assert from "node:assert/strict";
import test from "node:test";
import { buildDeploySuccessMessage, buildOpsAlert } from "../src/slack-format.ts";

test("buildDeploySuccessMessage celebrates Worker deploy", () => {
  const msg = buildDeploySuccessMessage({
    houseName: "우리집",
    agentVersion: "0.1.8",
    hostname: "nuc",
    pm2AppName: "janitor-agent",
    restartScheduled: true,
    note: "Worker npm run deploy finished",
  });
  assert.match(msg.text, /배포 성공/);
  assert.match(msg.text, /우리집/);
  assert.match(msg.text, /0\.1\.8/);
  const blob = JSON.stringify(msg.blocks);
  assert.match(blob, /배포가 완료/);
  assert.match(blob, /janitor-agent/);
  assert.match(blob, /nuc/);
});

test("buildOpsAlert lists failing services and speed clearly", () => {
  const msg = buildOpsAlert({
    houseName: "우리집",
    failingServices: [
      {
        name: "Home Assistant",
        host: "ha",
        url: "https://ha.home/api/",
        ok: false,
        code: 503,
        expect: 200,
        ms: 120,
        slackOnFail: true,
      },
      {
        name: "silent",
        ok: false,
        code: 500,
        expect: 200,
        slackOnFail: false,
      },
    ],
    speed: { downMbps: 42.5, thresholdMbps: 100, upMbps: 10 },
    failedJobs: [{ kind: "pve_sync", status: "error", error: "token expired" }],
  });

  assert.match(msg.text, /우리집/);
  assert.match(msg.text, /죽은 서비스/);
  assert.match(msg.text, /Home Assistant/);
  assert.doesNotMatch(msg.text, /silent/);
  assert.match(msg.text, /42\.5/);
  assert.match(msg.text, /pve_sync/);
  assert.ok(Array.isArray(msg.blocks));
  assert.ok(msg.blocks.some((b) => b.type === "header"));
  const blob = JSON.stringify(msg.blocks);
  assert.match(blob, /다운된 서비스/);
  assert.match(blob, /Home Assistant/);
  assert.match(blob, /DOWN/);
  assert.match(blob, /회선 속도 저하/);
  assert.match(blob, /에이전트 작업 실패/);
  assert.match(blob, /HTTP 503/);
});
