import type { Env } from "./env";
import {
  buildAgentOfflineMessage,
  buildDeploySuccessMessage,
  buildOpsAlert,
  buildRecoveryMessage,
  type SlackMessage,
} from "./slack-format.ts";

export { buildAgentOfflineMessage, buildDeploySuccessMessage, buildOpsAlert, buildRecoveryMessage };
export type { SlackMessage };

export const SLACK_TIMEOUT_MS = 8_000;

/**
 * Post to the Slack webhook. Never throws: network errors, timeouts and non-2xx
 * all return false so callers (agent report, cron) can decide whether to retry.
 */
export async function notifySlack(
  env: Pick<Env, "SLACK_WEBHOOK_URL">,
  channel: string,
  message: string | SlackMessage,
): Promise<boolean> {
  if (!env.SLACK_WEBHOOK_URL) return false;
  const payload: SlackMessage =
    typeof message === "string" ? { text: message } : message;
  try {
    const res = await fetch(env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: payload.channel || channel,
        text: payload.text,
        blocks: payload.blocks,
      }),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), event: "slack.failed", status: res.status }));
    }
    return res.ok;
  } catch (error) {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: "slack.failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return false;
  }
}
