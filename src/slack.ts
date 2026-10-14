import type { Env } from "./env";
import {
  buildDeploySuccessMessage,
  buildOpsAlert,
  type SlackMessage,
} from "./slack-format";

export { buildDeploySuccessMessage, buildOpsAlert };
export type { SlackMessage };

export async function notifySlack(
  env: Env,
  channel: string,
  message: string | SlackMessage,
): Promise<boolean> {
  if (!env.SLACK_WEBHOOK_URL) return false;
  const payload: SlackMessage =
    typeof message === "string" ? { text: message } : message;
  const res = await fetch(env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      channel: payload.channel || channel,
      text: payload.text,
      blocks: payload.blocks,
    }),
  });
  return res.ok;
}
