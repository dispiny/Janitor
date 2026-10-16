import { AgentError } from "./errors.js";

export type PublicIpResult = {
  ip: string;
  checkedAt: string;
  source: string;
};

const SOURCES = [
  "https://api.ipify.org?format=json",
  "https://ifconfig.me/ip",
] as const;

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6_RE = /^[0-9a-f:]+$/i;

export function isPublicIpLiteral(value: string): boolean {
  const text = value.trim();
  if (!text || /\s/.test(text) || text.length > 45) return false;
  if (IPV4_RE.test(text)) {
    return text.split(".").every((part) => {
      const n = Number(part);
      return Number.isInteger(n) && n >= 0 && n <= 255;
    });
  }
  return text.includes(":") && IPV6_RE.test(text);
}

function assertIp(value: string, source: string): string {
  const ip = value.trim();
  if (!isPublicIpLiteral(ip)) {
    throw new Error(`${source} returned non-ip payload`);
  }
  return ip;
}

async function fromIpify(signal: AbortSignal): Promise<string> {
  const response = await fetch(SOURCES[0], { signal });
  if (!response.ok) throw new Error(`ipify ${response.status}`);
  const body = (await response.json()) as { ip?: string };
  if (!body.ip) throw new Error("ipify missing ip");
  return assertIp(body.ip, "ipify");
}

async function fromIfconfig(signal: AbortSignal): Promise<string> {
  const response = await fetch(SOURCES[1], { signal });
  if (!response.ok) throw new Error(`ifconfig.me ${response.status}`);
  return assertIp(await response.text(), "ifconfig.me");
}

/** Each source gets its own timeout so a slow first source cannot pre-abort the fallback. */
export async function resolvePublicIp(timeoutMs = 5000): Promise<PublicIpResult> {
  const failures: string[] = [];

  try {
    const ip = await fromIpify(AbortSignal.timeout(timeoutMs));
    return { ip, checkedAt: new Date().toISOString(), source: "ipify" };
  } catch (error) {
    failures.push(error instanceof Error ? error.message : "ipify failed");
  }

  try {
    const ip = await fromIfconfig(AbortSignal.timeout(timeoutMs));
    return { ip, checkedAt: new Date().toISOString(), source: "ifconfig.me" };
  } catch (error) {
    failures.push(error instanceof Error ? error.message : "ifconfig.me failed");
  }

  throw new AgentError("PUBLIC_IP_FAILED", failures.join("; "));
}
