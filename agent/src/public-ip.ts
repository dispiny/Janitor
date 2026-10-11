export type PublicIpResult = {
  ip: string;
  checkedAt: string;
  source: string;
};

const SOURCES = [
  "https://api.ipify.org?format=json",
  "https://ifconfig.me/ip",
] as const;

async function fromIpify(signal: AbortSignal): Promise<string> {
  const response = await fetch(SOURCES[0], { signal });
  if (!response.ok) throw new Error(`ipify ${response.status}`);
  const body = (await response.json()) as { ip?: string };
  if (!body.ip) throw new Error("ipify missing ip");
  return body.ip.trim();
}

async function fromIfconfig(signal: AbortSignal): Promise<string> {
  const response = await fetch(SOURCES[1], { signal });
  if (!response.ok) throw new Error(`ifconfig.me ${response.status}`);
  const text = (await response.text()).trim();
  if (!text) throw new Error("ifconfig.me empty");
  return text;
}

export async function resolvePublicIp(timeoutMs = 5000): Promise<PublicIpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    try {
      const ip = await fromIpify(controller.signal);
      return { ip, checkedAt: new Date().toISOString(), source: "ipify" };
    } catch {
      const ip = await fromIfconfig(controller.signal);
      return { ip, checkedAt: new Date().toISOString(), source: "ifconfig.me" };
    }
  } finally {
    clearTimeout(timer);
  }
}
