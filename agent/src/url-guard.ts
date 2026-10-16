/** Allowed http(s) URL checks for health/PVE fetches (SEC-05, SEC-06). */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

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

/**
 * Link-local (cloud metadata 169.254.169.254) and 0.0.0.0/8 ("this host" on Linux).
 * Private LAN ranges and loopback stay allowed — this is a home agent.
 */
function isBlockedIpv4(parts: number[]): boolean {
  const [a, b] = parts;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;
  return false;
}

/** Expand an IPv6 literal (optionally with trailing dotted IPv4) to 8 hextets. */
export function parseIpv6(host: string): number[] | null {
  let text = host.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  if (!text.includes(":")) return null;

  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const maybeV4 = text.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = parseIpv4(maybeV4);
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    text = text.slice(0, lastColon + 1) + "0";
    // "0" placeholder is dropped below; keeps "::" / ":" splitting simple.
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toHextets = (part: string): number[] | null => {
    if (!part) return [];
    const out: number[] = [];
    for (const piece of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      out.push(Number.parseInt(piece, 16));
    }
    return out;
  };
  const head = toHextets(halves[0]);
  const rest = halves.length === 2 ? toHextets(halves[1]) : [];
  if (!head || !rest) return null;
  if (tail.length) {
    // Replace the "0" placeholder with the two IPv4 hextets.
    if (halves.length === 2) rest.pop();
    else head.pop();
  }
  const known = head.length + rest.length + tail.length;
  if (halves.length === 1) {
    if (known !== 8) return null;
    return [...head, ...tail];
  }
  if (known > 7) return null;
  return [...head, ...Array(8 - known).fill(0), ...rest, ...tail];
}

function embeddedIpv4(h: number[]): number[] {
  return [h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff];
}

function isBlockedIpv6(h: number[]): boolean {
  if (h.every((n) => n === 0)) return true; // ::
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  // AWS IPv6 metadata endpoint fd00:ec2::254
  if (h[0] === 0xfd00 && h[1] === 0x0ec2 && h.slice(2, 7).every((n) => n === 0) && h[7] === 0x254) {
    return true;
  }
  const zeros = (from: number, to: number) => h.slice(from, to).every((n) => n === 0);
  // ::ffff:a.b.c.d (IPv4-mapped) — Node normalizes [::ffff:169.254.169.254] → [::ffff:a9fe:a9fe]
  if (zeros(0, 5) && h[5] === 0xffff) return isBlockedIpv4(embeddedIpv4(h));
  // ::ffff:0:a.b.c.d (IPv4-translated)
  if (zeros(0, 4) && h[4] === 0xffff && h[5] === 0) return isBlockedIpv4(embeddedIpv4(h));
  // 64:ff9b::a.b.c.d (NAT64 well-known prefix)
  if (h[0] === 0x64 && h[1] === 0xff9b && zeros(2, 6)) return isBlockedIpv4(embeddedIpv4(h));
  // ::a.b.c.d (deprecated IPv4-compatible); ::1 stays allowed like 127.0.0.1
  if (zeros(0, 6) && !(h[6] === 0 && h[7] === 1)) return isBlockedIpv4(embeddedIpv4(h));
  return false;
}

/** True for addresses the agent must never fetch (metadata / unspecified / link-local). */
export function isBlockedAddress(address: string): boolean {
  const host = address.replace(/^\[|\]$/g, "");
  const v4 = parseIpv4(host);
  if (v4) return isBlockedIpv4(v4);
  const v6 = parseIpv6(host);
  if (v6) return isBlockedIpv6(v6);
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

  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".metadata.google.internal")) {
    return { ok: false, error: "url host is not allowed" };
  }
  if (isBlockedAddress(host)) {
    return { ok: false, error: "url address is not allowed" };
  }

  return { ok: true, url: parsed.toString() };
}

export type LookupAll = (hostname: string) => Promise<Array<{ address: string }>>;

const defaultLookup: LookupAll = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/**
 * Same as assertAllowedHttpUrl, plus DNS: reject names that resolve to a blocked address
 * (e.g. 169.254.169.254.nip.io). Lookup errors fail open — fetch would fail the same way
 * and report the real error. Residual risk: DNS rebinding between this check and fetch.
 */
function isIpv6LinkLocal(address: string): boolean {
  return isIP(address) === 6 && /^fe[89ab][0-9a-f]:/i.test(address);
}

export async function assertAllowedHttpUrlResolved(
  raw: string,
  opts: { lookup?: LookupAll; timeoutMs?: number } = {},
): Promise<UrlGuardResult> {
  const checked = assertAllowedHttpUrl(raw);
  if (!checked.ok) return checked;
  const host = new URL(checked.url).hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return checked;

  const lookup = opts.lookup ?? defaultLookup;
  let timer: NodeJS.Timeout | undefined;
  try {
    const addresses = await Promise.race([
      lookup(host),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), opts.timeoutMs ?? 5000);
      }),
    ]);
    // mDNS / Avahi often add an fe80:: answer next to the LAN IPv4 for `*.local`;
    // that alone must not block a legit host. Literal fe80 URLs are still rejected above.
    if (addresses?.some((entry) => !isIpv6LinkLocal(entry.address) && isBlockedAddress(entry.address))) {
      return { ok: false, error: "url host resolves to a blocked address" };
    }
  } catch {
    // fail open (see above)
  } finally {
    if (timer) clearTimeout(timer);
  }
  return checked;
}
