import type { Env } from "./env";

export async function notifySlack(env: Env, channel: string, text: string): Promise<boolean> {
  if (!env.SLACK_WEBHOOK_URL) return false;
  const res = await fetch(env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel, text }),
  });
  return res.ok;
}
