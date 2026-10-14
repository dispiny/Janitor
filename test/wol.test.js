import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMac, parseWol } from "../src/wol.ts";

test("normalizeMac accepts common notations", () => {
  assert.equal(normalizeMac("aa-bb-cc-dd-ee-01"), "AA:BB:CC:DD:EE:01");
  assert.equal(normalizeMac("AABBCCDDEE01"), "AA:BB:CC:DD:EE:01");
  assert.equal(normalizeMac("aa:bb:cc:dd:ee:01"), "AA:BB:CC:DD:EE:01");
  assert.equal(normalizeMac("bad"), null);
});

test("parseWol defaults empty broadcast to null (agent uses 255.255.255.255)", () => {
  const ok = parseWol({ mac: "02:00:00:00:00:10", broadcast: "", port: 9 });
  assert.equal(ok.ok, true);
  assert.equal(ok.broadcast, null);
  assert.equal(ok.port, 9);
});

test("parseWol rejects bad broadcast and port", () => {
  assert.equal(parseWol({ mac: "02:00:00:00:00:10", broadcast: "not-an-ip" }).ok, false);
  assert.equal(parseWol({ mac: "02:00:00:00:00:10", port: 0 }).ok, false);
});
