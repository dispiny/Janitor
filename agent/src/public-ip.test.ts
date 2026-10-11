import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPublicIpLiteral } from "./public-ip.js";

describe("public ip literal", () => {
  it("accepts ipv4 and ipv6", () => {
    assert.equal(isPublicIpLiteral("203.0.113.42"), true);
    assert.equal(isPublicIpLiteral("2001:db8::1"), true);
  });

  it("rejects html or junk payloads", () => {
    assert.equal(isPublicIpLiteral("<html>error</html>"), false);
    assert.equal(isPublicIpLiteral("not an ip"), false);
    assert.equal(isPublicIpLiteral("999.1.1.1"), false);
    assert.equal(isPublicIpLiteral(""), false);
  });
});
