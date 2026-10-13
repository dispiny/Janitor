export type LogFields = Record<string, unknown>;

/** Structured JSON line to stdout. Never log secrets (tokens, passwords). */
export function log(event: string, fields: LogFields = {}): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...fields,
    }),
  );
}
