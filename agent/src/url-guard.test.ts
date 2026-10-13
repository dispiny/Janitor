import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertAllowedHttpUrl } from "./url-guard.js";

describe("assertAllowedHttpUrl", () => {
  it("allows public https and private lan http", () => {
    assert.equal(assertAllowedHttpUrl("https://example.com/health").ok, true);
    assert.equal(assertAllowedHttpUrl("http://192.168.0.10:8006/").ok, true);
    assert.equal(assertAllowedHttpUrl("http://10.0.0.5/status").ok, true);
  });

  it("rejects dangerous schemes and metadata", () => {
    assert.equal(assertAllowedHttpUrl("javascript:alert(1)").ok, false);
    assert.equal(assertAllowedHttpUrl("https://169.254.169.254/latest/meta-data").ok, false);
    assert.equal(assertAllowedHttpUrl("http://metadata.google.internal/").ok, false);
    assert.equal(assertAllowedHttpUrl("https://user:pass@example.com/").ok, false);
  });
});
