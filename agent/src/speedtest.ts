import { log } from "./log.js";

export type SpeedTestResult = {
  down_mbps: number;
  up_mbps: number;
  provider: "fast.com" | "cloudflare";
  connections: number;
  duration_ms: number;
  bytes_down: number;
  bytes_up: number;
};

export type SpeedTestOptions = {
  /** How long to measure download (default 12s, Fast.com-like). */
  durationMs?: number;
  /** Parallel download workers (default 4). */
  connections?: number;
  /** Prefer Fast.com CDN; fall back to Cloudflare on failure. */
  provider?: "fast" | "cloudflare" | "auto";
  /** Also measure upload via Cloudflare __up (default true). */
  measureUpload?: boolean;
  /** Upload sample size in bytes (default 4 MiB). */
  uploadBytes?: number;
  fetchImpl?: typeof fetch;
};

type FastTargets = { targets: Array<{ url: string }> };

let cachedFastToken: { token: string; expiresAt: number } | null = null;

function roundMbps(bitsPerSecond: number): number {
  return Math.round((bitsPerSecond / 1_000_000) * 10) / 10;
}

async function discoverFastToken(fetchImpl: typeof fetch): Promise<string> {
  if (cachedFastToken && cachedFastToken.expiresAt > Date.now()) {
    return cachedFastToken.token;
  }

  const home = await fetchImpl("https://fast.com/", {
    signal: AbortSignal.timeout(15000),
  });
  if (!home.ok) throw new Error(`fast.com home ${home.status}`);
  const html = await home.text();
  const scriptMatch = html.match(/src="(\/?app-[^"]+\.js)"/);
  if (!scriptMatch) throw new Error("fast.com app script not found");

  const scriptUrl = scriptMatch[1].startsWith("http")
    ? scriptMatch[1]
    : `https://fast.com${scriptMatch[1].startsWith("/") ? "" : "/"}${scriptMatch[1]}`;
  const scriptRes = await fetchImpl(scriptUrl, { signal: AbortSignal.timeout(15000) });
  if (!scriptRes.ok) throw new Error(`fast.com script ${scriptRes.status}`);
  const script = await scriptRes.text();
  const tokenMatch = script.match(/token:"([A-Za-z0-9_-]+)"/);
  if (!tokenMatch) throw new Error("fast.com token not found");

  cachedFastToken = { token: tokenMatch[1], expiresAt: Date.now() + 30 * 60_000 };
  return tokenMatch[1];
}

async function fetchFastTargets(
  fetchImpl: typeof fetch,
  urlCount: number,
): Promise<string[]> {
  const token = await discoverFastToken(fetchImpl);
  const api = `https://api.fast.com/netflix/speedtest/v2?https=true&token=${encodeURIComponent(token)}&urlCount=${urlCount}`;
  const res = await fetchImpl(api, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`fast.com api ${res.status}`);
  const body = (await res.json()) as FastTargets;
  const urls = (body.targets || []).map((t) => t.url).filter(Boolean);
  if (!urls.length) throw new Error("fast.com returned no targets");
  return urls;
}

async function drainUntil(
  response: Response,
  shouldStop: () => boolean,
  onBytes: (n: number) => void,
): Promise<void> {
  if (!response.body) throw new Error("empty body");
  const reader = response.body.getReader();
  let chunks = 0;
  try {
    while (!shouldStop()) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.byteLength) onBytes(value.byteLength);
      // Yield so timers (warmup / measure window) can fire under fast mocks.
      chunks += 1;
      if (chunks % 8 === 0) await new Promise((r) => setImmediate(r));
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
}

/**
 * Fast.com-style download: parallel CDN streams for a sustained window.
 * Mbps = total bits / active seconds after a short warmup.
 */
async function measureParallelDownload(
  urls: string[],
  opts: {
    connections: number;
    durationMs: number;
    warmupMs: number;
    fetchImpl: typeof fetch;
    label: string;
  },
): Promise<{ mbps: number; bytes: number; ms: number }> {
  const warmupMs = Math.min(opts.warmupMs, Math.max(0, opts.durationMs - 500));
  const measureMsTarget = Math.max(500, opts.durationMs - warmupMs);
  let bytes = 0;
  let stopped = false;
  const shouldStop = () => stopped;

  const workers = Array.from({ length: opts.connections }, async (_, index) => {
    while (!shouldStop()) {
      const url = urls[index % urls.length];
      try {
        const res = await opts.fetchImpl(url, {
          signal: AbortSignal.timeout(opts.durationMs + 5_000),
          headers: { "cache-control": "no-cache" },
        });
        if (!res.ok || !res.body) {
          await new Promise((r) => setTimeout(r, 50));
          continue;
        }
        await drainUntil(res, shouldStop, (n) => {
          bytes += n;
        });
      } catch {
        if (shouldStop()) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  });

  // Warmup: let TCP ramp; score uses only bytes after this snapshot.
  await new Promise((r) => setTimeout(r, warmupMs));
  const bytesAfterWarmup = bytes;
  const measureStarted = Date.now();
  await new Promise((r) => setTimeout(r, measureMsTarget));
  stopped = true;
  await Promise.all(workers);
  const measureMs = Math.max(1, Date.now() - measureStarted);
  const countedBytes = Math.max(0, bytes - bytesAfterWarmup);
  const bitsPerSecond = (countedBytes * 8) / (measureMs / 1000);
  const mbps = roundMbps(bitsPerSecond);
  log("speedtest.download.complete", {
    provider: opts.label,
    connections: opts.connections,
    bytes: countedBytes,
    totalBytes: bytes,
    ms: measureMs,
    down_mbps: mbps,
  });
  return { mbps, bytes: countedBytes, ms: measureMs };
}

async function measureCloudflareUpload(
  fetchImpl: typeof fetch,
  uploadBytes: number,
): Promise<{ mbps: number; bytes: number; ms: number }> {
  const payload = new Uint8Array(uploadBytes);
  // Avoid crypto.randomFill cost on large buffers — pattern is enough for CDN.
  for (let i = 0; i < payload.length; i += 4096) payload[i] = i % 251;

  const started = Date.now();
  const res = await fetchImpl("https://speed.cloudflare.com/__up", {
    method: "POST",
    body: payload,
    signal: AbortSignal.timeout(60000),
    headers: { "content-type": "application/octet-stream" },
  });
  if (!res.ok) throw new Error(`cloudflare upload ${res.status}`);
  // Drain response so the transfer fully completes.
  await res.arrayBuffer().catch(() => undefined);
  const ms = Math.max(1, Date.now() - started);
  const mbps = roundMbps((uploadBytes * 8) / (ms / 1000));
  log("speedtest.upload.complete", {
    provider: "cloudflare",
    bytes: uploadBytes,
    ms,
    up_mbps: mbps,
  });
  return { mbps, bytes: uploadBytes, ms };
}

function cloudflareDownloadUrls(connections: number): string[] {
  // Large enough that a single connection can feed a multi-second test.
  const bytes = 100_000_000;
  return Array.from(
    { length: connections },
    () => `https://speed.cloudflare.com/__down?bytes=${bytes}&r=${Math.random()}`,
  );
}

export async function runSpeedTest(options: SpeedTestOptions = {}): Promise<SpeedTestResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const durationMs = options.durationMs ?? 12_000;
  const connections = options.connections ?? 4;
  const provider = options.provider ?? "auto";
  const measureUpload = options.measureUpload !== false;
  const uploadBytes = options.uploadBytes ?? 4_000_000;
  const warmupMs = Math.min(2_000, Math.floor(durationMs / 4));

  log("speedtest.received", {
    phase: "received",
    provider,
    durationMs,
    connections,
  });
  log("speedtest.processing", {
    phase: "processing",
    provider,
    durationMs,
    connections,
  });

  let down: { mbps: number; bytes: number; ms: number };
  let used: "fast.com" | "cloudflare";

  const tryFast = provider === "fast" || provider === "auto";
  const tryCf = provider === "cloudflare" || provider === "auto";

  if (tryFast) {
    try {
      const targets = await fetchFastTargets(fetchImpl, Math.max(connections, 3));
      down = await measureParallelDownload(targets, {
        connections,
        durationMs,
        warmupMs,
        fetchImpl,
        label: "fast.com",
      });
      used = "fast.com";
    } catch (error) {
      if (!tryCf) throw error;
      log("speedtest.fast_fallback", {
        error: error instanceof Error ? error.message : String(error),
      });
      down = await measureParallelDownload(cloudflareDownloadUrls(connections), {
        connections,
        durationMs,
        warmupMs,
        fetchImpl,
        label: "cloudflare",
      });
      used = "cloudflare";
    }
  } else {
    down = await measureParallelDownload(cloudflareDownloadUrls(connections), {
      connections,
      durationMs,
      warmupMs,
      fetchImpl,
      label: "cloudflare",
    });
    used = "cloudflare";
  }

  let up = { mbps: 0, bytes: 0, ms: 0 };
  if (measureUpload) {
    try {
      up = await measureCloudflareUpload(fetchImpl, uploadBytes);
    } catch (error) {
      log("speedtest.upload.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const result: SpeedTestResult = {
    down_mbps: down.mbps,
    up_mbps: up.mbps,
    provider: used,
    connections,
    duration_ms: down.ms,
    bytes_down: down.bytes,
    bytes_up: up.bytes,
  };

  log("speedtest.complete", { phase: "complete", ...result });
  return result;
}

/** Test helper */
export function _resetFastTokenCache(): void {
  cachedFastToken = null;
}
