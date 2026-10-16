import assert from "node:assert/strict";
import dgram from "node:dgram";
import { describe, it } from "node:test";
import { buildMagicPacket, normalizeMac, parseMac, sendMagicPacket } from "./magic-packet.js";

const UNREACHABLE = new Set(["EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL", "EPERM", "EACCES"]);

describe("magic packet", () => {
  it("rejects invalid mac", () => {
    assert.throws(() => parseMac("zz:00:00:00:00:01"), /invalid MAC/);
    assert.throws(() => parseMac("02:00:00:00:00"), /invalid MAC/);
  });

  it("normalizes common MAC notations", () => {
    assert.equal(normalizeMac("02-00-00-00-00-1a"), "02:00:00:00:00:1A");
    assert.equal(normalizeMac("0200.0000.001a"), "02:00:00:00:00:1A");
    assert.equal(normalizeMac(" 02000000001A "), "02:00:00:00:00:1A");
  });

  it("builds 102-byte magic packet", () => {
    const packet = buildMagicPacket("02:00:00:00:00:10");
    assert.equal(packet.length, 102);
    assert.deepEqual([...packet.subarray(0, 6)], [255, 255, 255, 255, 255, 255]);
    assert.deepEqual([...packet.subarray(6, 12)], [0x02, 0x00, 0x00, 0x00, 0x00, 0x10]);
    assert.deepEqual([...packet.subarray(96, 102)], [0x02, 0x00, 0x00, 0x00, 0x00, 0x10]);
  });

  it("sends the packet as a broadcast that a listener on the segment receives", async (t) => {
    const rx = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const received: Buffer[] = [];
    rx.on("message", (msg) => received.push(msg));
    await new Promise<void>((resolve) => rx.bind(40010, "0.0.0.0", () => resolve()));
    try {
      let result;
      try {
        result = await sendMagicPacket({ mac: "02:00:00:00:00:10", port: 40010 });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code || "";
        // Sandboxes / CI runners / VPN-only hosts have no route for 255.255.255.255.
        if (UNREACHABLE.has(code)) {
          t.skip(`broadcast not available here: ${code}`);
          return;
        }
        throw error;
      }
      assert.equal(result.broadcast, "255.255.255.255");
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(received.length, 3);
      assert.ok(received[0].equals(buildMagicPacket("02:00:00:00:00:10")));
    } finally {
      rx.close();
    }
  });
});
