import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertAllowedHttpUrl, assertAllowedHttpUrlResolved, isBlockedAddress, parseIpv6 } from "./url-guard.js";

describe("assertAllowedHttpUrl", () => {
  it("allows public https and private lan http", () => {
    assert.equal(assertAllowedHttpUrl("https://example.com/health").ok, true);
    assert.equal(assertAllowedHttpUrl("http://192.168.0.10:8006/").ok, true);
    assert.equal(assertAllowedHttpUrl("http://10.0.0.5/status").ok, true);
    assert.equal(assertAllowedHttpUrl("http://172.16.0.5/").ok, true);
    assert.equal(assertAllowedHttpUrl("http://127.0.0.1:8123/").ok, true);
    assert.equal(assertAllowedHttpUrl("http://[::1]:8123/").ok, true);
    assert.equal(assertAllowedHttpUrl("http://[fd12:3456::10]/").ok, true);
    assert.equal(assertAllowedHttpUrl("http://[::ffff:192.168.0.10]/").ok, true);
  });

  it("rejects dangerous schemes and metadata", () => {
    assert.equal(assertAllowedHttpUrl("javascript:alert(1)").ok, false);
    assert.equal(assertAllowedHttpUrl("https://169.254.169.254/latest/meta-data").ok, false);
    assert.equal(assertAllowedHttpUrl("http://metadata.google.internal/").ok, false);
    assert.equal(assertAllowedHttpUrl("https://user:pass@example.com/").ok, false);
  });

  it("rejects IPv4-mapped / translated / NAT64 forms of blocked IPv4", () => {
    // Node normalizes this to [::ffff:a9fe:a9fe]
    assert.equal(new URL("http://[::ffff:169.254.169.254]/").hostname, "[::ffff:a9fe:a9fe]");
    assert.equal(assertAllowedHttpUrl("http://[::ffff:169.254.169.254]/").ok, false);
    assert.equal(assertAllowedHttpUrl("http://[::ffff:a9fe:a9fe]/").ok, false);
    assert.equal(assertAllowedHttpUrl("http://[0:0:0:0:0:ffff:a9fe:a9fe]/").ok, false);
    assert.equal(assertAllowedHttpUrl("http://[::ffff:0:a9fe:a9fe]/").ok, false);
    assert.equal(assertAllowedHttpUrl("http://[64:ff9b::a9fe:a9fe]/").ok, false);
    assert.equal(assertAllowedHttpUrl("http://[::ffff:0.0.0.0]/").ok, false);
    // decimal / hex IPv4 spellings are normalized by URL first
    assert.equal(assertAllowedHttpUrl("http://2852039166/").ok, false);
    assert.equal(assertAllowedHttpUrl("http://0xa9fea9fe/").ok, false);
    assert.equal(assertAllowedHttpUrl("http://0.0.0.0:3920/").ok, false);
  });

  it("rejects the whole fe80::/10 link-local range and ::", () => {
    assert.equal(assertAllowedHttpUrl("http://[fe80::1]/").ok, false);
    assert.equal(assertAllowedHttpUrl("http://[fe9a::1]/").ok, false);
    assert.equal(assertAllowedHttpUrl("http://[febf:ffff::1]/").ok, false);
    assert.equal(assertAllowedHttpUrl("http://[::]/").ok, false);
    assert.equal(assertAllowedHttpUrl("http://[fd00:ec2::254]/").ok, false);
    assert.equal(assertAllowedHttpUrl("http://[fec0::1]/").ok, true);
  });

  it("parses IPv6 literals", () => {
    assert.deepEqual(parseIpv6("::ffff:1.2.3.4"), [0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    assert.deepEqual(parseIpv6("fe80::1"), [0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    assert.equal(parseIpv6("1::2::3"), null);
    assert.equal(isBlockedAddress("fe80::1%en0"), true);
  });
});

describe("assertAllowedHttpUrlResolved", () => {
  it("rejects names that resolve to a blocked address", async () => {
    const lookup = async (host: string) =>
      host === "169.254.169.254.nip.io" ? [{ address: "169.254.169.254" }] : [{ address: "93.184.216.34" }];
    const bad = await assertAllowedHttpUrlResolved("http://169.254.169.254.nip.io/latest", { lookup });
    assert.equal(bad.ok, false);
    const ok = await assertAllowedHttpUrlResolved("https://example.com/", { lookup });
    assert.equal(ok.ok, true);
  });

  it("rejects when any of several resolved addresses is blocked (incl. mapped v6)", async () => {
    const lookup = async () => [{ address: "192.168.0.10" }, { address: "::ffff:169.254.169.254" }];
    const result = await assertAllowedHttpUrlResolved("http://nas.home/", { lookup });
    assert.equal(result.ok, false);
  });

  it("allows LAN names and fails open on lookup errors", async () => {
    const lan = await assertAllowedHttpUrlResolved("http://nas.home/", {
      lookup: async () => [{ address: "192.168.0.10" }],
    });
    assert.equal(lan.ok, true);
    const missing = await assertAllowedHttpUrlResolved("http://nope.invalid/", {
      lookup: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    assert.equal(missing.ok, true);
  });

  it("skips DNS for IP literals", async () => {
    let called = false;
    const result = await assertAllowedHttpUrlResolved("http://10.0.0.5/", {
      lookup: async () => {
        called = true;
        return [];
      },
    });
    assert.equal(result.ok, true);
    assert.equal(called, false);
  });
});

it("resolved check ignores fe80 mDNS answers next to a LAN address", async () => {
  const lookup = async () => [
    { address: "192.168.0.10", family: 4 },
    { address: "fe80::1c2b:3cff:fe4d:5e6f", family: 6 },
  ];
  const result = await assertAllowedHttpUrlResolved("http://nas.local/health", { lookup });
  assert.equal(result.ok, true);
});

it("resolved check still rejects names that resolve to the metadata address", async () => {
  const lookup = async () => [{ address: "169.254.169.254", family: 4 }];
  const result = await assertAllowedHttpUrlResolved("http://meta.example/", { lookup });
  assert.equal(result.ok, false);
});
