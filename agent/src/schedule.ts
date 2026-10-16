export type ScheduleKind = "health_all" | "pve_sync" | "speed_probe" | "public_ip";

export type HouseSchedule = {
  health_interval_sec?: number | null;
  speed_interval_sec?: number | null;
  pve_interval_sec?: number | null;
  public_ip_interval_sec?: number | null;
  last_speed_at?: string | null;
  last_pve_at?: string | null;
  public_ip_checked_at?: string | null;
};

/**
 * Defaults tuned to how often things actually change and how expensive each check is.
 * 0 disables that kind. Overridable per house in the dashboard.
 */
export const DEFAULT_HEALTH_INTERVAL_SEC = 5 * 60; // services can flap — 5 min
export const DEFAULT_PVE_INTERVAL_SEC = 15 * 60; // guest list changes occasionally
export const DEFAULT_SPEED_INTERVAL_SEC = 60 * 60; // Fast.com-style test is heavy — 1 h
export const DEFAULT_PUBLIC_IP_INTERVAL_SEC = 2 * 60 * 60; // ISP IP rarely moves — 2 h

function intervalSec(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(Math.floor(n), 7 * 24 * 3600));
}

function timestampMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Stalest service check; null last_checked_at means "never" → due immediately. */
export function oldestServiceCheckAt(
  services: Array<{ last_checked_at?: string | null }>,
): string | null {
  if (!services.length) return null;
  let oldest: string | null = null;
  let oldestMs = Infinity;
  for (const service of services) {
    if (!service.last_checked_at) return null;
    const ms = new Date(service.last_checked_at).getTime();
    if (!Number.isFinite(ms)) return null;
    if (ms < oldestMs) {
      oldestMs = ms;
      oldest = service.last_checked_at;
    }
  }
  return oldest;
}

/** Backoff never stretches a kind beyond this many intervals. */
export const MAX_BACKOFF_FACTOR = 4;

/**
 * Local (in-memory) record of scheduled attempts. Server timestamps alone are not
 * enough: they stay null when there is nothing to store (e.g. Proxmox with no guests)
 * or stale when the report fails, which would rerun heavy jobs every tick.
 */
export class ScheduleMemory {
  private lastAttempt = new Map<ScheduleKind, number>();
  private failures = new Map<ScheduleKind, number>();

  /** Record a finished attempt (scheduled or explicit) of `kind` that started at `at`. */
  note(kind: ScheduleKind, ok: boolean, at: number = Date.now()): void {
    this.lastAttempt.set(kind, Math.max(at, this.lastAttempt.get(kind) ?? 0));
    if (ok) this.failures.delete(kind);
    else this.failures.set(kind, (this.failures.get(kind) ?? 0) + 1);
  }

  lastAttemptAt(kind: ScheduleKind): number | null {
    return this.lastAttempt.get(kind) ?? null;
  }

  consecutiveFailures(kind: ScheduleKind): number {
    return this.failures.get(kind) ?? 0;
  }

  /** 1 failure → 1× interval, 2 → 2×, 3+ → 4× (capped). */
  backoffFactor(kind: ScheduleKind): number {
    const n = this.consecutiveFailures(kind);
    if (n <= 1) return 1;
    return Math.min(MAX_BACKOFF_FACTOR, 2 ** (n - 1));
  }

  clear(): void {
    this.lastAttempt.clear();
    this.failures.clear();
  }
}

/** Process-wide memory used by the poller. */
export const scheduleMemory = new ScheduleMemory();

export function isScheduleKind(kind: string): kind is ScheduleKind {
  return kind === "health_all" || kind === "pve_sync" || kind === "speed_probe" || kind === "public_ip";
}

function isDue(
  kind: ScheduleKind,
  lastIso: string | null | undefined,
  intervalSec: number,
  now: number,
  memory: ScheduleMemory,
): boolean {
  if (intervalSec <= 0) return false;
  const serverMs = timestampMs(lastIso);
  const localMs = memory.lastAttemptAt(kind);
  if (serverMs === null && localMs === null) return true; // never ran
  const last = Math.max(serverMs ?? -Infinity, localMs ?? -Infinity);
  return Math.max(0, now - last) >= intervalSec * 1000 * memory.backoffFactor(kind);
}

/**
 * Decide which automatic checks are due this tick.
 * Due = interval (× failure backoff) elapsed since max(server timestamp, local last attempt).
 * Skips kinds already present in the explicit job queue.
 * Interval 0 disables that kind.
 */
export function scheduledKinds(input: {
  now?: number;
  house: HouseSchedule;
  services: Array<{ last_checked_at?: string | null }>;
  hasPve: boolean;
  pendingKinds?: Iterable<string>;
  memory?: ScheduleMemory;
}): ScheduleKind[] {
  const now = input.now ?? Date.now();
  const memory = input.memory ?? scheduleMemory;
  const pending = new Set(input.pendingKinds || []);
  const healthSec = intervalSec(input.house.health_interval_sec, DEFAULT_HEALTH_INTERVAL_SEC);
  const speedSec = intervalSec(input.house.speed_interval_sec, DEFAULT_SPEED_INTERVAL_SEC);
  const pveSec = intervalSec(input.house.pve_interval_sec, DEFAULT_PVE_INTERVAL_SEC);
  const publicIpSec = intervalSec(input.house.public_ip_interval_sec, DEFAULT_PUBLIC_IP_INTERVAL_SEC);
  const due: ScheduleKind[] = [];

  if (
    input.services.length > 0 &&
    !pending.has("health_all") &&
    !pending.has("health_one") &&
    isDue("health_all", oldestServiceCheckAt(input.services), healthSec, now, memory)
  ) {
    due.push("health_all");
  }

  if (input.hasPve && !pending.has("pve_sync") && isDue("pve_sync", input.house.last_pve_at, pveSec, now, memory)) {
    due.push("pve_sync");
  }

  // Public IP before speed so a long speed test does not block a cheap IP refresh forever.
  if (!pending.has("public_ip") && isDue("public_ip", input.house.public_ip_checked_at, publicIpSec, now, memory)) {
    due.push("public_ip");
  }

  if (!pending.has("speed_probe") && isDue("speed_probe", input.house.last_speed_at, speedSec, now, memory)) {
    due.push("speed_probe");
  }

  return due;
}
