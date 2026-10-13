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

export type AlertState = Record<string, { since?: string; name?: string; kind?: string }>;

export type DedupeResult = {
  /** Open incident keys after this report (persisted). */
  nextState: AlertState;
  /** Brand-new problems that should page Slack once. */
  freshServices: AlertService[];
  freshSpeed: AlertSpeed | null;
  freshJobs: AlertJob[];
  hasFresh: boolean;
};

function svcKey(id: string): string {
  return `svc:${id}`;
}

/** Merge this report into prior alert_state; only first transition to bad fires. */
export function dedupeAlerts(input: {
  prev: AlertState | null | undefined;
  services?: AlertService[];
  speed?: AlertSpeed | null;
  /** true when this report includes a speed sample (even if healthy). */
  speedReported?: boolean;
  jobs?: AlertJob[];
  now?: string;
}): DedupeResult {
  const now = input.now || new Date().toISOString();
  const nextState: AlertState = { ...(input.prev || {}) };
  const freshServices: AlertService[] = [];
  let freshSpeed: AlertSpeed | null = null;
  const freshJobs: AlertJob[] = [];

  for (const s of input.services || []) {
    const id = (s.id || s.name || "").trim();
    if (!id) continue;
    const key = svcKey(id);
    if (s.ok) {
      delete nextState[key];
      continue;
    }
    if (s.slackOnFail === false) {
      delete nextState[key];
      continue;
    }
    if (!nextState[key]) {
      freshServices.push(s);
      nextState[key] = { since: now, name: s.name };
    } else {
      nextState[key] = {
        ...nextState[key],
        name: s.name || nextState[key].name,
      };
    }
  }

  if (input.speedReported) {
    if (!input.speed) {
      delete nextState.speed;
    } else if (!nextState.speed) {
      freshSpeed = input.speed;
      nextState.speed = { since: now, name: "speed" };
    }
  }

  for (const j of input.jobs || []) {
    if (j.status !== "error") continue;
    const id = (j.id || `${j.kind || "job"}:${j.error || "error"}`).trim();
    const key = `job:${id}`;
    if (!nextState[key]) {
      freshJobs.push(j);
      nextState[key] = { since: now, kind: j.kind, name: j.kind };
    }
  }

  return {
    nextState,
    freshServices,
    freshSpeed,
    freshJobs,
    hasFresh: freshServices.length > 0 || freshSpeed != null || freshJobs.length > 0,
  };
}
