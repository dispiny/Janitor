/** Allowed http(s) URL checks for health/PVE fetches (SEC-05, SEC-06). */

const BLOCKED_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "metadata",
  "kubernetes.default",
  "kubernetes.default.svc",
]);

function parseIpv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return parts;
}

function isBlockedIp(host: string): boolean {
  const v4 = parseIpv4(host);
  if (v4) {
    const [a, b] = v4;
    if (a === 169 && b === 254) return true;
    if (a === 0 && b === 0 && v4[2] === 0 && v4[3] === 0) return true;
    return false;
  }
  const lower = host.toLowerCase();
  if (lower === "::" || lower === "0:0:0:0:0:0:0:0") return true;
  if (lower.startsWith("fe80:")) return true;
  return false;
}

export type UrlGuardResult = { ok: true; url: string } | { ok: false; error: string };

export function assertAllowedHttpUrl(raw: string): UrlGuardResult {
  const value = (raw || "").trim();
  if (!value) return { ok: false, error: "url is required" };

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: "invalid url" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "only http(s) urls are allowed" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "url credentials are not allowed" };
  }
  if (!parsed.hostname) {
    return { ok: false, error: "url host is required" };
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".metadata.google.internal")) {
    return { ok: false, error: "url host is not allowed" };
  }
  if (isBlockedIp(host)) {
    return { ok: false, error: "url address is not allowed" };
  }

  return { ok: true, url: parsed.toString() };
}
