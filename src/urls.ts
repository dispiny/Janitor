/** Allowed http(s) URL checks for manage/health/PVE targets (SEC-05, SEC-06). */

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

/** Block cloud link-local / metadata ranges; private LAN remains allowed for homelab. */
function isBlockedIp(host: string): boolean {
  const v4 = parseIpv4(host);
  if (v4) {
    const [a, b] = v4;
    // 169.254.0.0/16 link-local / cloud metadata
    if (a === 169 && b === 254) return true;
    // 0.0.0.0
    if (a === 0 && b === 0 && v4[2] === 0 && v4[3] === 0) return true;
    return false;
  }
  const lower = host.toLowerCase();
  if (lower === "::" || lower === "0:0:0:0:0:0:0:0") return true;
  // IPv6 link-local fe80::/10
  if (lower.startsWith("fe80:")) return true;
  return false;
}

export type UrlCheckResult = { ok: true; url: string } | { ok: false; error: string };

export function assertHttpUrl(
  raw: string,
  options: { allowEmpty?: boolean; field?: string } = {},
): UrlCheckResult {
  const field = options.field || "url";
  const value = (raw || "").trim();
  if (!value) {
    if (options.allowEmpty) return { ok: true, url: "" };
    return { ok: false, error: `${field}이(가) 필요합니다.` };
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: `${field} 형식이 올바르지 않습니다.` };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `${field}은(는) http(s)만 허용됩니다.` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: `${field}에 사용자 정보를 넣을 수 없습니다.` };
  }
  if (!parsed.hostname) {
    return { ok: false, error: `${field}에 호스트가 필요합니다.` };
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".metadata.google.internal")) {
    return { ok: false, error: `${field} 대상 호스트가 허용되지 않습니다.` };
  }
  if (isBlockedIp(host)) {
    return { ok: false, error: `${field} 대상 주소가 허용되지 않습니다.` };
  }

  return { ok: true, url: parsed.toString() };
}
