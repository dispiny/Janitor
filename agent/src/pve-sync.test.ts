import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { syncPveGuests } from "./pve-sync.js";

describe("syncPveGuests", () => {
  it("discovers all nodes from the API and scrapes qemu + lxc", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/nodes")) {
        return Response.json({ data: [{ node: "pve-a", status: "online" }, { node: "pve-b", status: "offline" }] });
      }
      if (url.includes("/nodes/pve-a/qemu")) {
        return Response.json({ data: [{ name: "haos", vmid: 100, status: "running" }] });
      }
      if (url.includes("/nodes/pve-a/lxc")) {
        return Response.json({ data: [{ name: "dns", vmid: 101, status: "stopped" }] });
      }
      if (url.includes("/nodes/pve-b/qemu")) {
        return Response.json({ data: [{ name: "nas", vmid: 200, status: "running" }] });
      }
      if (url.includes("/nodes/pve-b/lxc")) {
        return Response.json({ data: [] });
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;

    const result = await syncPveGuests({
      serverId: "srv-1",
      baseUrl: "https://pve.home:8006/",
      tokenId: "janitor@pve!monitor",
      tokenSecret: "secret",
      fetchImpl,
    });

    assert.deepEqual(result.nodes, ["pve-a", "pve-b"]);
    assert.deepEqual(result.discovered, [
      { node: "pve-a", online: true },
      { node: "pve-b", online: false },
    ]);
    assert.equal(result.guests.length, 3);
    assert.ok(result.guests.some((g) => g.name === "haos" && g.node === "pve-a" && g.is_on));
    assert.ok(result.guests.some((g) => g.name === "dns" && g.node === "pve-a" && !g.is_on));
    assert.ok(result.guests.some((g) => g.name === "nas" && g.node === "pve-b"));
    assert.ok(calls.some((u) => u.endsWith("/api2/json/nodes")));
  });

  it("honours an optional single-node filter", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/nodes")) {
        if (url.endsWith("/nodes")) throw new Error("should not list nodes when filtered");
        if (url.includes("/qemu")) return Response.json({ data: [{ name: "only", vmid: 1, status: "running" }] });
        return Response.json({ data: [] });
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;

    const result = await syncPveGuests({
      serverId: "srv-1",
      baseUrl: "https://pve.home:8006",
      tokenId: "t",
      tokenSecret: "s",
      nodeFilter: "edge",
      fetchImpl,
    });
    assert.deepEqual(result.nodes, ["edge"]);
    assert.equal(result.discovered, undefined);
    assert.equal(result.guests[0]?.name, "only");
  });
});
