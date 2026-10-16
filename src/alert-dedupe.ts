export type AlertService = {
  id?: string;
  name: string;
  host?: string | null;
  url?: string | null;
  ok: boolean;
  code?: number | null;
  expect?: number | null;
  ms?: number | null;
  error?: string | null;
  slackOnFail?: boolean;
};

export type AlertJob = {
  id?: string;
  kind?: string;
  status: string;
  error?: string | null;
};

export type AlertSpeed = {
  downMbps: number;
  thresholdMbps: number;
  upMbps?: number | null;
};

export type AlertEntry = {
  since?: string;
  name?: string;
  kind?: string;
  host?: string | null;
  /** Consecutive failed reports (services only). */
  count?: number;
  /** false while below alert_after_failures. Missing = legacy entry that already paged. */
  notified?: boolean;
};

export type AlertState = Record<string, AlertEntry>;

export type RecoveredService = { id: string; name: string; host?: string | null; since?: string };

export type DedupeResult = {
  /** Open incident keys after this report (persisted). */
  nextState: AlertState;
  /** Brand-new problems that should page Slack once. */
  freshServices: AlertService[];
  freshSpeed: AlertSpeed | null;
  freshJobs: AlertJob[];
  /** Keys whose first page is in this report; revert them if the Slack send fails. */
  freshKeys: string[];
  hasFresh: boolean;
  /** Previously paged services that are healthy again. */
  recoveredServices: RecoveredService[];
  /** Previously paged speed drop that is back above threshold. */
  speedRecovered: AlertEntry | null;
  /** prev had agent:offline; any successful report means the agent is back. */
  agentReconnected: AlertEntry | null;
  hasRecovery: boolean;
};

export const AGENT_OFFLINE_KEY = "agent:offline";
/** job:<id> keys only guard against the agent re-sending the same result; keep them a day. */
export const JOB_KEY_TTL_MS = 24 * 60 * 60 * 1000;

function svcKey(id: string): string {
  return `svc:${id}`;
}

function wasNotified(entry: AlertEntry | undefined): boolean {
  return Boolean(entry) && entry!.notified !== false;
}

export function clampAlertAfterFailures(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(10, n));
}

/**
 * Merge this report into prior alert_state.
 * - A service pages once after `alertAfterFailures` consecutive failed reports.
 * - Recovery is reported only for incidents that actually paged.
 * - svc:<id> keys for deleted services (not in `serviceIds`) are dropped; job keys expire after 24h.
 * - Unknown keys are kept, except agent:offline which any successful report clears.
 */
export function dedupeAlerts(input: {
  prev: AlertState | null | undefined;
  services?: AlertService[];
  speed?: AlertSpeed | null;
  /** true when this report includes a speed sample (even if healthy). */
  speedReported?: boolean;
  jobs?: AlertJob[];
  now?: string;
  alertAfterFailures?: number | null;
  /** All service ids of the house (from agent_report). Omit to skip pruning. */
  serviceIds?: string[] | null;
}): DedupeResult {
  const now = input.now || new Date().toISOString();
  const nowMs = new Date(now).getTime();
  const threshold = clampAlertAfterFailures(input.alertAfterFailures ?? 1);
  const prev: AlertState = input.prev && typeof input.prev === "object" ? input.prev : {};
  const nextState: AlertState = { ...prev };
  const freshServices: AlertService[] = [];
  let freshSpeed: AlertSpeed | null = null;
  const freshJobs: AlertJob[] = [];
  const freshKeys: string[] = [];
  const recoveredServices: RecoveredService[] = [];
  let speedRecovered: AlertEntry | null = null;
  let agentReconnected: AlertEntry | null = null;

  if (nextState[AGENT_OFFLINE_KEY]) {
    agentReconnected = nextState[AGENT_OFFLINE_KEY];
    delete nextState[AGENT_OFFLINE_KEY];
  }

  for (const s of input.services || []) {
    const id = (s.id || s.name || "").trim();
    if (!id) continue;
    const key = svcKey(id);
    const existing = nextState[key];
    if (s.ok) {
      if (wasNotified(existing) && s.slackOnFail !== false) {
        recoveredServices.push({ id, name: s.name || existing!.name || id, host: s.host ?? existing!.host, since: existing!.since });
      }
      delete nextState[key];
      continue;
    }
    if (s.slackOnFail === false) {
      delete nextState[key];
      continue;
    }
    const notified = wasNotified(existing);
    const count = (existing?.count ?? (existing ? 1 : 0)) + 1;
    const entry: AlertEntry = {
      ...(existing || {}),
      since: existing?.since || now,
      name: s.name || existing?.name,
      host: s.host ?? existing?.host ?? null,
      count,
      notified: notified || count >= threshold,
    };
    nextState[key] = entry;
    if (!notified && entry.notified) {
      freshServices.push(s);
      freshKeys.push(key);
    }
  }

  if (input.speedReported) {
    if (!input.speed) {
      if (wasNotified(nextState.speed)) speedRecovered = nextState.speed;
      delete nextState.speed;
    } else if (!nextState.speed) {
      freshSpeed = input.speed;
      nextState.speed = { since: now, name: "speed", notified: true };
      freshKeys.push("speed");
    }
  }

  for (const key of Object.keys(nextState)) {
    if (!key.startsWith("job:")) continue;
    const since = new Date(nextState[key].since || "").getTime();
    if (!Number.isFinite(since) || nowMs - since > JOB_KEY_TTL_MS) delete nextState[key];
  }

  for (const j of input.jobs || []) {
    if (j.status !== "error") continue;
    const id = (j.id || `${j.kind || "job"}:${j.error || "error"}`).trim();
    const key = `job:${id}`;
    if (!nextState[key]) {
      freshJobs.push(j);
      nextState[key] = { since: now, kind: j.kind, name: j.kind, notified: true };
      freshKeys.push(key);
    }
  }

  if (Array.isArray(input.serviceIds)) {
    const known = new Set(input.serviceIds.map(String));
    for (const key of Object.keys(nextState)) {
      if (key.startsWith("svc:") && !known.has(key.slice(4))) delete nextState[key];
    }
  }

  return {
    nextState,
    freshServices,
    freshSpeed,
    freshJobs,
    freshKeys,
    hasFresh: freshServices.length > 0 || freshSpeed != null || freshJobs.length > 0,
    recoveredServices,
    speedRecovered,
    agentReconnected,
    hasRecovery: recoveredServices.length > 0 || speedRecovered != null || agentReconnected != null,
  };
}

/**
 * State to persist when the page for fresh incidents was not delivered:
 * fresh keys go back to their previous value so the next report retries.
 */
export function withoutFresh(result: DedupeResult, prev: AlertState | null | undefined): AlertState {
  const before: AlertState = prev && typeof prev === "object" ? prev : {};
  const state: AlertState = { ...result.nextState };
  for (const key of result.freshKeys) {
    if (before[key]) state[key] = before[key];
    else delete state[key];
  }
  return state;
}
