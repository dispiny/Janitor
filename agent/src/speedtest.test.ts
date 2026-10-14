import assert from "node:assert/strict";
import { ReadableStream } from "node:stream/web";
import { describe, it } from "node:test";
import { _resetFastTokenCache, runSpeedTest } from "./speedtest.js";

function bytesStream(total: number, chunk = 64_000): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    async pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      // Small delay so Node timers can advance during tests.
      await new Promise((r) => setTimeout(r, 1));
      const size = Math.min(chunk, total - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size));
    },
  });
}

describe("runSpeedTest", () => {
  it("measures Fast.com parallel download and Cloudflare upload", async () => {
    _resetFastTokenCache();
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://fast.com/") {
        return new Response('<script src="/app-abc123.js"></script>', { status: 200 });
      }
      if (url.includes("app-abc123.js")) {
        return new Response('var x={token:"test-token-xyz"};', { status: 200 });
      }
      if (url.includes("api.fast.com/netflix/speedtest/v2")) {
        return Response.json({
          targets: [
            { url: "https://cdn.example/speed1" },
            { url: "https://cdn.example/speed2" },
          ],
        });
      }
      if (url.startsWith("https://cdn.example/")) {
        return new Response(bytesStream(2_000_000), { status: 200 });
      }
      if (url.includes("speed.cloudflare.com/__up") && init?.method === "POST") {
        return new Response("ok", { status: 200 });
      }
      return new Response("missing", { status: 404 });
    };

    const result = await runSpeedTest({
      fetchImpl,
      provider: "fast",
      durationMs: 3000,
      connections: 2,
      measureUpload: true,
      uploadBytes: 100_000,
    });

    assert.equal(result.provider, "fast.com");
    assert.ok(result.down_mbps > 0);
    assert.ok(result.bytes_down > 0);
    assert.equal(result.connections, 2);
    assert.ok(result.up_mbps >= 0);
  });

  it("falls back to Cloudflare when Fast.com token discovery fails", async () => {
    _resetFastTokenCache();
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://fast.com/") {
        return new Response("no script", { status: 200 });
      }
      if (url.includes("speed.cloudflare.com/__down")) {
        return new Response(bytesStream(1_500_000), { status: 200 });
      }
      if (url.includes("speed.cloudflare.com/__up") && init?.method === "POST") {
        return new Response("ok", { status: 200 });
      }
      return new Response("missing", { status: 404 });
    };

    const result = await runSpeedTest({
      fetchImpl,
      provider: "auto",
      durationMs: 3000,
      connections: 2,
      measureUpload: false,
    });

    assert.equal(result.provider, "cloudflare");
    assert.ok(result.down_mbps > 0);
    assert.equal(result.up_mbps, 0);
  });
});
