import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAgentOfflineMessage,
  buildDeploySuccessMessage,
  buildOpsAlert,
  buildRecoveryMessage,
  escapeMrkdwn,
} from "../src/slack-format.ts";
import { notifySlack } from "../src/slack.ts";

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

test("buildOpsAlert escapes Slack mrkdwn in user text", () => {
  const msg = buildOpsAlert({
    houseName: "A&B <!channel>",
    failingServices: [
      { name: "<!here>", host: "<h>", url: "https://x/?a=1&b=<2>", ok: false, code: 500, error: "<@U123> boom", slackOnFail: true },
    ],
    failedJobs: [{ kind: "pve_sync", status: "error", error: "<https://evil|click>" }],
  });
  const mrkdwn = [msg.text, ...msg.blocks.filter((b) => b.type === "section").map((b) => b.text.text)].join("\n");
  assert.doesNotMatch(mrkdwn, /<!channel>|<!here>|<@U123>|<https:\/\/evil/);
  assert.match(mrkdwn, /&lt;!here&gt;/);
  assert.match(mrkdwn, /A&amp;B/);
  assert.match(mrkdwn, /a=1&amp;b=&lt;2&gt;/);
  assert.equal(escapeMrkdwn("a<b>&c"), "a&lt;b&gt;&amp;c");
});

test("buildRecoveryMessage and buildAgentOfflineMessage", () => {
  const rec = buildRecoveryMessage({
    houseName: "우리집",
    services: [{ name: "<HA>", host: "ha" }],
    speed: { since: "2026-10-17T00:00:00Z" },
    agentReconnected: { since: "2026-10-17T00:00:00Z" },
  });
  assert.match(rec.text, /복구됨/);
  assert.match(rec.text, /에이전트 다시 연결됨/);
  assert.match(JSON.stringify(rec.blocks), /&lt;HA&gt;/);
  const off = buildAgentOfflineMessage({ houseName: "우리집", lastSeenAt: "2026-10-17T00:00:00Z", hostLabel: "nuc" });
  assert.match(off.text, /에이전트 응답 없음/);
  assert.match(off.text, /마지막 연결/);
});

test("notifySlack never throws and reports failure", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const env = { SLACK_WEBHOOK_URL: "https://hooks.slack.invalid/x" };
  assert.equal(await notifySlack({}, "#c", "hi"), false);

  globalThis.fetch = async () => { throw new TypeError("network down"); };
  assert.equal(await notifySlack(env, "#c", "hi"), false);

  globalThis.fetch = async () => new Response("no", { status: 500 });
  assert.equal(await notifySlack(env, "#c", "hi"), false);

  let sent;
  globalThis.fetch = async (_url, init) => { sent = init; return new Response("ok", { status: 200 }); };
  assert.equal(await notifySlack(env, "#c", { text: "hi" }), true);
  assert.ok(sent.signal, "uses a timeout signal");
  assert.equal(JSON.parse(sent.body).channel, "#c");
});
