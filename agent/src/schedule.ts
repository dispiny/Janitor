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

function ageMs(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, now - t);
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

function isDue(lastIso: string | null | undefined, intervalSec: number, now: number): boolean {
  if (intervalSec <= 0) return false;
  return (ageMs(lastIso, now) ?? Infinity) >= intervalSec * 1000;
}

/**
 * Decide which automatic checks are due this tick.
 * Skips kinds already present in the explicit job queue.
 * Interval 0 disables that kind.
 */
export function scheduledKinds(input: {
  now?: number;
  house: HouseSchedule;
  services: Array<{ last_checked_at?: string | null }>;
  hasPve: boolean;
  pendingKinds?: Iterable<string>;
}): ScheduleKind[] {
  const now = input.now ?? Date.now();
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
    isDue(oldestServiceCheckAt(input.services), healthSec, now)
  ) {
    due.push("health_all");
  }

  if (input.hasPve && !pending.has("pve_sync") && isDue(input.house.last_pve_at, pveSec, now)) {
    due.push("pve_sync");
  }

  // Public IP before speed so a long speed test does not block a cheap IP refresh forever.
  if (!pending.has("public_ip") && isDue(input.house.public_ip_checked_at, publicIpSec, now)) {
    due.push("public_ip");
  }

  if (!pending.has("speed_probe") && isDue(input.house.last_speed_at, speedSec, now)) {
    due.push("speed_probe");
  }

  return due;
}
