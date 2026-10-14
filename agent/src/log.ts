export type LogFields = Record<string, unknown>;

const MAX_BUFFER = 100;
const MAX_STRING = 500;

/** High-frequency phases that drown the web log viewer. */
const SKIP_EVENTS = new Set([
  "request.received",
  "request.processing",
  "request.complete",
  "poller.api.received",
  "poller.api.processing",
  "poller.api.complete",
  "tick.received",
  "tick.processing",
  "poller.job.received",
  "poller.job.processing",
]);

const buffer: Record<string, unknown>[] = [];

function truncate(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(truncate);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const lower = key.toLowerCase();
      if (
        lower.includes("password") ||
        lower.includes("token") ||
        lower.includes("secret") ||
        lower.includes("authorization")
      ) {
        out[key] = "[redacted]";
        continue;
      }
      if (lower === "body") continue;
      out[key] = truncate(entry);
    }
    return out;
  }
  return value;
}

function slimEntry(event: string, fields: LogFields): Record<string, unknown> {
  const base = truncate({ ts: new Date().toISOString(), event, ...fields }) as Record<
    string,
    unknown
  >;
  return base;
}

/** Structured JSON line to stdout + ring buffer for dashboard. Never log secrets. */
export function log(event: string, fields: LogFields = {}): void {
  const entry = slimEntry(event, fields);
  console.log(JSON.stringify(entry));
  if (SKIP_EVENTS.has(event)) return;
  if (event.endsWith(".processing")) return;
  buffer.push(entry);
  while (buffer.length > MAX_BUFFER) buffer.shift();
}

/** Copy then clear buffered events (for a successful agent_report). */
export function drainLogBuffer(): Record<string, unknown>[] {
  return buffer.splice(0, buffer.length);
}

/** Prepend entries back if report failed (so the next tick can retry). */
export function restoreLogBuffer(entries: Record<string, unknown>[]): void {
  if (!entries.length) return;
  buffer.unshift(...entries);
  while (buffer.length > MAX_BUFFER) buffer.pop();
}

/** Test helper — current buffer snapshot. */
export function peekLogBuffer(): readonly Record<string, unknown>[] {
  return buffer;
}

/** Test helper. */
export function clearLogBuffer(): void {
  buffer.length = 0;
}
