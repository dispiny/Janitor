import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildMagicPacket, parseMac } from "./magic-packet.js";

describe("magic packet", () => {
  it("rejects invalid mac", () => {
    assert.throws(() => parseMac("zz:00:00:00:00:01"), /invalid MAC/);
  });

  it("builds 102-byte magic packet", () => {
    const packet = buildMagicPacket("02:00:00:00:00:10");
    assert.equal(packet.length, 102);
    assert.deepEqual([...packet.subarray(0, 6)], [255, 255, 255, 255, 255, 255]);
    assert.deepEqual([...packet.subarray(6, 12)], [0x02, 0x00, 0x00, 0x00, 0x00, 0x10]);
    assert.deepEqual([...packet.subarray(96, 102)], [0x02, 0x00, 0x00, 0x00, 0x00, 0x10]);
  });
});
