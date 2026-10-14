export type WolParseResult =
  | { ok: true; mac: string; broadcast: string | null; port: number }
  | { ok: false; error: string };

/** Accepts AA:BB:CC:DD:EE:FF, AA-BB-CC-DD-EE-FF (Windows ipconfig) or bare hex; stores colon form. */
export function normalizeMac(raw: unknown): string | null {
  const hex = (typeof raw === "string" ? raw : "").trim().replace(/[:\-.\s]/g, "");
  if (!/^[0-9A-Fa-f]{12}$/.test(hex)) return null;
  return hex.toUpperCase().match(/../g)!.join(":");
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** Empty broadcast is stored as null; the agent then uses 255.255.255.255. */
export function parseWol(input: { mac?: unknown; broadcast?: unknown; port?: unknown }): WolParseResult {
  const mac = normalizeMac(input.mac);
  if (!mac) return { ok: false, error: "MAC 주소 형식이 올바르지 않습니다. 예: AA:BB:CC:DD:EE:FF" };
  const rawBroadcast = typeof input.broadcast === "string" ? input.broadcast.trim() : "";
  if (rawBroadcast && !isIpv4(rawBroadcast)) {
    return { ok: false, error: "브로드캐스트 주소는 IPv4여야 합니다. 예: 192.168.219.255" };
  }
  const port = input.port === undefined || input.port === null || input.port === "" ? 9 : Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: "WOL 포트는 1~65535 사이 정수여야 합니다." };
  }
  return { ok: true, mac, broadcast: rawBroadcast || null, port };
}
