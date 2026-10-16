import { DEFAULT_SLACK_CHANNEL, handleApi } from "./api";
import type { Env } from "./env";
import { withSecurityHeaders } from "./security-headers";
import { buildAgentOfflineMessage, notifySlack } from "./slack";
import { serviceClient } from "./supabase";

function log(event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

/** Agent counts as gone after this long without poll/report (cron runs every 5 min). */
const OFFLINE_AFTER_SEC = 600;

type MaintenanceResult = {
  offline?: Array<{
    id: string;
    name?: string | null;
    slack_channel?: string | null;
    agent_last_seen_at?: string | null;
    agent_host_label?: string | null;
  }>;
  speedSamplesDeleted?: number;
  jobsDeleted?: number;
};

/** Cron: retention cleanup + one Slack page per house whose agent just went silent. */
async function runMaintenance(env: Env): Promise<void> {
  const sb = serviceClient(env);
  if (!sb) {
    log("cron.skipped", { reason: "SUPABASE_SERVICE_ROLE_KEY missing" });
    return;
  }
  const { data, error } = await sb.rpc("janitor_maintenance", { p_offline_after_sec: OFFLINE_AFTER_SEC });
  if (error) {
    log("cron.failed", { error: error.message });
    return;
  }
  const result = (data || {}) as MaintenanceResult;
  const offline = Array.isArray(result.offline) ? result.offline : [];
  let notified = 0;
  for (const house of offline) {
    // agent:offline is already set in alert_state; a failed send is not retried
    // (the next successful report clears it and sends "다시 연결됨").
    const ok = await notifySlack(
      env,
      house.slack_channel || DEFAULT_SLACK_CHANNEL,
      buildAgentOfflineMessage({
        houseName: house.name,
        lastSeenAt: house.agent_last_seen_at,
        hostLabel: house.agent_host_label,
      }),
    );
    if (ok) notified += 1;
  }
  log("cron.complete", {
    offline: offline.length,
    notified,
    speedSamplesDeleted: result.speedSamplesDeleted ?? 0,
    jobsDeleted: result.jobsDeleted ?? 0,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();
    const base = {
      requestId,
      method: request.method,
      path: url.pathname,
      hasAuth: Boolean(request.headers.get("authorization")),
    };

    log("request.received", { ...base, phase: "received" });
    const started = Date.now();

    try {
      let response: Response;
      if (url.pathname.startsWith("/api/")) {
        response = await handleApi(request, env, url.pathname);
      } else {
        response = await env.ASSETS.fetch(request);
      }

      response = withSecurityHeaders(response);

      log("request.complete", {
        ...base,
        phase: "complete",
        status: response.status,
        ms: Date.now() - started,
      });
      return response;
    } catch (error) {
      log("request.failed", {
        ...base,
        phase: "failed",
        ms: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    log("cron.start", { cron: controller.cron });
    ctx.waitUntil(
      runMaintenance(env).catch((error) => {
        log("cron.failed", { error: error instanceof Error ? error.message : String(error) });
      }),
    );
  },
};
