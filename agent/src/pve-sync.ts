import { Agent, fetch as undiciFetch } from "undici";
import { log } from "./log.js";

export type PveGuest = {
  server_id: string;
  name: string;
  node: string;
  kind: string;
  is_on: boolean;
  vmid?: number;
};

export type PveSyncInput = {
  serverId: string;
  baseUrl: string;
  tokenId: string;
  tokenSecret: string;
  /** If set, only this node; otherwise discover every node on the API. */
  nodeFilter?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Skip TLS verification (PVE_TLS_INSECURE=true) for the default self-signed
   * Proxmox certificate. Prefer NODE_EXTRA_CA_CERTS with the PVE CA instead.
   */
  tlsInsecure?: boolean;
};

export type PveSyncResult = {
  nodes: string[];
  /** Only set when nodes were discovered from the API (no node filter). */
  discovered?: Array<{ node: string; online: boolean }>;
  guests: PveGuest[];
  /** Nodes whose qemu/lxc listing failed this round — their guests must not be pruned. */
  failedNodes: string[];
};

type NodesResponse = { data?: Array<{ node?: string; status?: string }> };
type GuestResponse = { data?: Array<{ name?: string; vmid?: number; status?: string }> };

let insecureAgent: Agent | null = null;

function insecureFetch(): typeof fetch {
  insecureAgent ??= new Agent({ connect: { rejectUnauthorized: false } });
  const dispatcher = insecureAgent;
  // undici's own fetch so the dispatcher always matches the client implementation.
  return ((url: string | URL, init?: RequestInit) =>
    undiciFetch(url, { ...(init as object), dispatcher } as Parameters<typeof undiciFetch>[1])) as unknown as typeof fetch;
}

async function pveJson<T>(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<T> {
  const path = new URL(url).pathname;
  // manual: a redirect must never carry the PVEAPIToken header to another host.
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const code = String((error as { cause?: { code?: string } }).cause?.code || "");
    if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) {
      throw new Error(
        `Proxmox TLS 인증서 검증 실패 (${code}) — NODE_EXTRA_CA_CERTS에 PVE CA를 지정하거나 PVE_TLS_INSECURE=true`,
      );
    }
    throw error;
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`Proxmox API redirected (${res.status}) on ${path} — use the final https://host:8006 URL`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`Proxmox API ${res.status} on ${path}`);
  }
  return (await res.json()) as T;
}

/**
 * List cluster/node names from a Proxmox API root, then scrape qemu + lxc on each.
 * Node listing failure throws (caller must not prune or touch node rows for this link).
 * Per-node failures are returned in `failedNodes` so their guests are kept.
 */
export async function syncPveGuests(input: PveSyncInput): Promise<PveSyncResult> {
  const fetchImpl = input.fetchImpl || (input.tlsInsecure ? insecureFetch() : fetch);
  const timeoutMs = input.timeoutMs ?? 15_000;
  const base = input.baseUrl.replace(/\/$/, "");
  const headers = { Authorization: `PVEAPIToken=${input.tokenId}=${input.tokenSecret}` };

  let nodeNames: string[];
  let discovered: PveSyncResult["discovered"];
  const filter = input.nodeFilter?.trim();
  if (filter) {
    nodeNames = [filter];
  } else {
    const nodesBody = await pveJson<NodesResponse>(`${base}/api2/json/nodes`, headers, fetchImpl, timeoutMs);
    discovered = (nodesBody?.data || [])
      .filter((n): n is { node: string; status?: string } => Boolean(n.node))
      .map((n) => ({ node: n.node, online: n.status === "online" }));
    nodeNames = discovered.map((n) => n.node);
    if (!nodeNames.length) {
      throw new Error("Proxmox API returned no nodes — check the URL and API token privileges");
    }
  }

  const guests: PveGuest[] = [];
  const failedNodes: string[] = [];
  for (const node of nodeNames) {
    const enc = encodeURIComponent(node);
    const [qemu, lxc] = await Promise.allSettled([
      pveJson<GuestResponse>(`${base}/api2/json/nodes/${enc}/qemu`, headers, fetchImpl, timeoutMs),
      pveJson<GuestResponse>(`${base}/api2/json/nodes/${enc}/lxc`, headers, fetchImpl, timeoutMs),
    ]);
    if (qemu.status === "rejected" || lxc.status === "rejected") {
      // Offline node in a cluster, or a token without VM.Audit on it. Keep what we
      // got (upsert is safe) but mark the node so the report does not prune it.
      failedNodes.push(node);
      const reason = qemu.status === "rejected" ? qemu.reason : (lxc as PromiseRejectedResult).reason;
      log("pve.node.failed", {
        phase: "failed",
        serverId: input.serverId,
        node,
        error: reason instanceof Error ? reason.message : String(reason),
      });
    }
    for (const item of (qemu.status === "fulfilled" ? qemu.value?.data : undefined) || []) {
      guests.push({
        server_id: input.serverId,
        name: item.name || String(item.vmid),
        node,
        kind: "VM",
        is_on: item.status === "running",
        vmid: item.vmid,
      });
    }
    for (const item of (lxc.status === "fulfilled" ? lxc.value?.data : undefined) || []) {
      guests.push({
        server_id: input.serverId,
        name: item.name || String(item.vmid),
        node,
        kind: "LXC",
        is_on: item.status === "running",
        vmid: item.vmid,
      });
    }
  }

  return { nodes: nodeNames, discovered, guests, failedNodes };
}
