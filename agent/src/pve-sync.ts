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
};

export type PveSyncResult = {
  nodes: string[];
  guests: PveGuest[];
};

type NodesResponse = { data?: Array<{ node?: string; status?: string }> };
type GuestResponse = { data?: Array<{ name?: string; vmid?: number; status?: string }> };

async function pveJson<T>(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<T | null> {
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

/** List cluster/node names from a Proxmox API root, then scrape qemu + lxc on each. */
export async function syncPveGuests(input: PveSyncInput): Promise<PveSyncResult> {
  const fetchImpl = input.fetchImpl || fetch;
  const timeoutMs = input.timeoutMs ?? 15_000;
  const base = input.baseUrl.replace(/\/$/, "");
  const headers = { Authorization: `PVEAPIToken=${input.tokenId}=${input.tokenSecret}` };

  let nodeNames: string[];
  const filter = input.nodeFilter?.trim();
  if (filter) {
    nodeNames = [filter];
  } else {
    const nodesBody = await pveJson<NodesResponse>(`${base}/api2/json/nodes`, headers, fetchImpl, timeoutMs);
    nodeNames = (nodesBody?.data || [])
      .map((n) => n.node)
      .filter((n): n is string => Boolean(n));
    if (!nodeNames.length) {
      throw new Error("Proxmox API returned no nodes — check the URL and API token privileges");
    }
  }

  const guests: PveGuest[] = [];
  for (const node of nodeNames) {
    const enc = encodeURIComponent(node);
    const [qemu, lxc] = await Promise.all([
      pveJson<GuestResponse>(`${base}/api2/json/nodes/${enc}/qemu`, headers, fetchImpl, timeoutMs),
      pveJson<GuestResponse>(`${base}/api2/json/nodes/${enc}/lxc`, headers, fetchImpl, timeoutMs),
    ]);
    for (const item of qemu?.data || []) {
      guests.push({
        server_id: input.serverId,
        name: item.name || String(item.vmid),
        node,
        kind: "VM",
        is_on: item.status === "running",
        vmid: item.vmid,
      });
    }
    for (const item of lxc?.data || []) {
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

  return { nodes: nodeNames, guests };
}
