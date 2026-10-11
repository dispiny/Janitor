import dgram from "node:dgram";
import { createServer } from "node:http";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

const API_URL = (process.env.JANITOR_API_URL || "").replace(/\/$/, "");
const AGENT_TOKEN = process.env.AGENT_TOKEN || "";
const POLL_MS = Number(process.env.AGENT_POLL_MS || 15000);
const PORT = Number(process.env.PORT || 8788);
const UPLUS_ROUTER_URL = process.env.UPLUS_ROUTER_URL || "";
const UPLUS_ROUTER_PASSWORD = process.env.UPLUS_ROUTER_PASSWORD || "";
const HEALTHCHECK_TOKEN = process.env.HEALTHCHECK_TOKEN || "";

if (!API_URL || !AGENT_TOKEN) {
  console.error("JANITOR_API_URL and AGENT_TOKEN are required");
  process.exit(1);
}

const headers = {
  authorization: `Bearer ${AGENT_TOKEN}`,
  "content-type": "application/json",
};

async function api(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${path}`);
  return data;
}

async function publicIp() {
  const endpoints = [
    "https://api.ipify.org?format=json",
    "https://ifconfig.me/ip",
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const text = await res.text();
      try {
        const json = JSON.parse(text);
        if (json.ip) return json.ip;
      } catch {
        const ip = text.trim();
        if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
      }
    } catch {
      // try next
    }
  }
  return null;
}

function sendMagicPacket(mac, broadcast = "255.255.255.255", port = 9) {
  return new Promise((resolve, reject) => {
    const clean = mac.replace(/[^0-9a-fA-F]/g, "");
    if (clean.length !== 12) {
      reject(new Error("invalid mac"));
      return;
    }
    const macBuf = Buffer.from(clean, "hex");
    const packet = Buffer.alloc(6 + 16 * 6, 0xff);
    for (let i = 0; i < 16; i++) macBuf.copy(packet, 6 + i * 6);
    const socket = dgram.createSocket("udp4");
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, 0, packet.length, port, broadcast, (err) => {
        socket.close();
        if (err) reject(err);
        else resolve(true);
      });
    });
  });
}

async function wakeUplus(deviceName) {
  if (!UPLUS_ROUTER_URL || !UPLUS_ROUTER_PASSWORD) {
    throw new Error("UPLUS_ROUTER_URL / UPLUS_ROUTER_PASSWORD not set on agent");
  }
  // LG U+ home routers expose a local admin CGI that varies by firmware.
  // We POST a WOL request for a registered device name; adjust path if your firmware differs.
  const res = await fetch(new URL("/wol.cgi", UPLUS_ROUTER_URL), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: "Basic " + Buffer.from(`admin:${UPLUS_ROUTER_PASSWORD}`).toString("base64"),
    },
    body: new URLSearchParams({ device: deviceName, action: "wake" }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`U+ WOL failed: ${res.status}`);
  return true;
}

async function wakeServer(server) {
  if (server.wol_mode === "manual") {
    await sendMagicPacket(server.wol_mac, server.wol_broadcast || "255.255.255.255", server.wol_port || 9);
    return { mode: "manual", mac: server.wol_mac };
  }
  if (server.wol_mode === "uplus") {
    await wakeUplus(server.wol_uplus_device);
    return { mode: "uplus", device: server.wol_uplus_device };
  }
  throw new Error("WOL disabled for server");
}

async function checkService(service) {
  const started = Date.now();
  try {
    const res = await fetch(service.health_url, {
      method: "GET",
      redirect: "manual",
      headers: HEALTHCHECK_TOKEN ? { authorization: `Bearer ${HEALTHCHECK_TOKEN}` } : {},
      signal: AbortSignal.timeout(15000),
    });
    const ms = Date.now() - started;
    return {
      id: service.id,
      ok: res.status === service.expect_status,
      code: res.status,
      ms,
    };
  } catch {
    return { id: service.id, ok: false, code: 0, ms: Date.now() - started };
  }
}

async function syncPve(server, secret) {
  if (!server.pve_enabled || !server.pve_host || !server.pve_token_id || !secret) return [];
  const base = server.pve_host.replace(/\/$/, "");
  const auth = `${server.pve_token_id}=${secret}`;
  const node = server.pve_node;
  const headersPve = { Authorization: `PVEAPIToken=${auth}` };
  const [qemu, lxc] = await Promise.all([
    fetch(`${base}/api2/json/nodes/${encodeURIComponent(node)}/qemu`, {
      headers: headersPve,
      signal: AbortSignal.timeout(15000),
    }),
    fetch(`${base}/api2/json/nodes/${encodeURIComponent(node)}/lxc`, {
      headers: headersPve,
      signal: AbortSignal.timeout(15000),
    }),
  ]);
  const guests = [];
  if (qemu.ok) {
    const body = await qemu.json();
    for (const item of body.data || []) {
      guests.push({
        server_id: server.id,
        name: item.name || String(item.vmid),
        kind: "VM",
        is_on: item.status === "running",
        vmid: item.vmid,
      });
    }
  }
  if (lxc.ok) {
    const body = await lxc.json();
    for (const item of body.data || []) {
      guests.push({
        server_id: server.id,
        name: item.name || String(item.vmid),
        kind: "LXC",
        is_on: item.status === "running",
        vmid: item.vmid,
      });
    }
  }
  return guests;
}

async function probeSpeed() {
  // Lightweight throughput sample against a public file; not a full Ookla test.
  const url = process.env.SPEEDTEST_URL || "https://speed.cloudflare.com/__down?bytes=25000000";
  const started = Date.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok || !res.body) throw new Error("speed probe failed");
  let bytes = 0;
  for await (const chunk of res.body) bytes += chunk.byteLength;
  const seconds = Math.max(0.001, (Date.now() - started) / 1000);
  const downMbps = (bytes * 8) / seconds / 1_000_000;
  // Upload probe is optional; report 0 when not configured.
  let upMbps = 0;
  const upUrl = process.env.SPEEDTEST_UPLOAD_URL;
  if (upUrl) {
    const payload = Buffer.alloc(5_000_000, 1);
    const upStarted = Date.now();
    const upRes = await fetch(upUrl, {
      method: "POST",
      body: payload,
      signal: AbortSignal.timeout(60000),
    });
    if (upRes.ok) {
      const upSeconds = Math.max(0.001, (Date.now() - upStarted) / 1000);
      upMbps = (payload.length * 8) / upSeconds / 1_000_000;
    }
  }
  return {
    down_mbps: Math.round(downMbps * 10) / 10,
    up_mbps: Math.round(upMbps * 10) / 10,
  };
}

async function pingHost(hostHint) {
  // Presence is inferred from health/manage reachability when no dedicated probe exists.
  if (!hostHint) return null;
  try {
    const res = await fetch(hostHint, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(4000) });
    return res.status > 0;
  } catch {
    return false;
  }
}

async function handleJobs(snapshot) {
  const jobResults = [];
  const serviceResults = [];
  const serverUpdates = [];
  let guests = [];
  let speed = null;

  for (const job of snapshot.jobs || []) {
    try {
      if (job.kind === "wake") {
        const server = (snapshot.servers || []).find((s) => s.id === job.payload?.serverId);
        if (!server) throw new Error("server not found");
        const result = await wakeServer(server);
        serverUpdates.push({ id: server.id, is_on: true });
        jobResults.push({ id: job.id, status: "done", result });
      } else if (job.kind === "health_one") {
        const service = (snapshot.services || []).find((s) => s.id === job.payload?.serviceId);
        if (!service) throw new Error("service not found");
        const result = await checkService(service);
        serviceResults.push(result);
        jobResults.push({ id: job.id, status: "done", result });
      } else if (job.kind === "health_all") {
        for (const service of snapshot.services || []) {
          serviceResults.push(await checkService(service));
        }
        jobResults.push({ id: job.id, status: "done", result: { count: serviceResults.length } });
      } else if (job.kind === "pve_sync") {
        for (const server of snapshot.servers || []) {
          const secret = snapshot.secrets?.[server.id];
          guests = guests.concat(await syncPve(server, secret));
        }
        jobResults.push({ id: job.id, status: "done", result: { guests: guests.length } });
      } else if (job.kind === "speed_probe") {
        speed = await probeSpeed();
        jobResults.push({ id: job.id, status: "done", result: speed });
      } else {
        jobResults.push({ id: job.id, status: "error", error: "unknown job" });
      }
    } catch (err) {
      jobResults.push({ id: job.id, status: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Opportunistic server presence when manage_url is set
  for (const server of snapshot.servers || []) {
    if (serverUpdates.some((u) => u.id === server.id)) continue;
    const on = await pingHost(server.manage_url || server.pve_host);
    if (on != null) serverUpdates.push({ id: server.id, is_on: on });
  }

  return { jobResults, serviceResults, serverUpdates, guests, speed };
}

async function tick() {
  const snapshot = await api("/api/agent/poll");
  const ip = await publicIp();
  const handled = await handleJobs(snapshot);
  await api("/api/agent/report", {
    method: "POST",
    body: JSON.stringify({
      publicIp: ip || undefined,
      agentHostLabel: process.env.AGENT_HOST_LABEL || os.hostname(),
      servers: handled.serverUpdates,
      services: handled.serviceResults,
      guests: handled.guests,
      speed: handled.speed || undefined,
      jobs: handled.jobResults,
    }),
  });
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      house: snapshot.house?.name,
      jobs: (snapshot.jobs || []).length,
      publicIp: ip,
    }),
  );
}

createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "POST" && req.url === "/job") {
    // Wake the poll loop early when Worker pushes.
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ accepted: true }));
    tick().catch((err) => console.error("push tick failed", err));
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(PORT, () => {
  console.log(`janitor-agent listening on :${PORT}, polling ${API_URL}`);
});

async function loop() {
  for (;;) {
    try {
      await tick();
    } catch (err) {
      console.error("tick failed", err instanceof Error ? err.message : err);
    }
    await sleep(POLL_MS);
  }
}

loop();
