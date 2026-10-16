import assert from "node:assert/strict";
import test from "node:test";
import { isUuid, parseServiceInput } from "../src/services.ts";

test("parseServiceInput normalises a full create body", () => {
  const result = parseServiceInput({
    name: "  Home Assistant ",
    hostLabel: " haos ",
    healthUrl: "http://192.168.0.20:8123/api/",
    expectStatus: "401",
    manageUrl: "",
    slackOnFail: false,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.row, {
    name: "Home Assistant",
    host_label: "haos",
    health_url: "http://192.168.0.20:8123/api/",
    expect_status: 401,
    manage_url: "",
    slack_on_fail: false,
    use_health_token: false,
  });
});

test("parseServiceInput health token is opt-in", () => {
  assert.equal(parseServiceInput({ name: "a", healthUrl: "https://a.home" }).row.use_health_token, false);
  assert.equal(parseServiceInput({ name: "a", healthUrl: "https://a.home", useHealthToken: "true" }).row.use_health_token, false);
  assert.equal(parseServiceInput({ name: "a", healthUrl: "https://a.home", useHealthToken: true }).row.use_health_token, true);
  assert.deepEqual(parseServiceInput({ useHealthToken: true }, { partial: true }).row, { use_health_token: true });
});

test("parseServiceInput defaults expect status and slack", () => {
  const result = parseServiceInput({ name: "dns", healthUrl: "https://dns.home/" });
  assert.equal(result.ok, true);
  assert.equal(result.row.expect_status, 200);
  assert.equal(result.row.slack_on_fail, true);
});

test("parseServiceInput rejects bad input", () => {
  assert.equal(parseServiceInput({ name: "", healthUrl: "https://a.home" }).ok, false);
  assert.equal(parseServiceInput({ name: "x".repeat(81), healthUrl: "https://a.home" }).ok, false);
  assert.equal(parseServiceInput({ name: "a", healthUrl: "ftp://a.home" }).ok, false);
  assert.equal(parseServiceInput({ name: "a", healthUrl: "http://169.254.169.254/" }).ok, false);
  assert.equal(parseServiceInput({ name: "a", healthUrl: "https://a.home", expectStatus: 99 }).ok, false);
  assert.equal(parseServiceInput({ name: "a", healthUrl: "https://a.home", expectStatus: 200.5 }).ok, false);
  assert.equal(parseServiceInput({ name: "a", healthUrl: "https://a.home", manageUrl: "javascript:alert(1)" }).ok, false);
});

test("parseServiceInput partial only returns provided keys", () => {
  const result = parseServiceInput({ expectStatus: 204 }, { partial: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.row, { expect_status: 204 });
  assert.equal(parseServiceInput({}, { partial: true }).ok, false);
  assert.equal(parseServiceInput({ name: " " }, { partial: true }).ok, false);
});

test("isUuid accepts only uuid strings", () => {
  assert.equal(isUuid("3f2b1c9e-4a7d-4e2b-9c1a-0b6f8d2e5a71"), true);
  assert.equal(isUuid("1 or 1=1"), false);
  assert.equal(isUuid(undefined), false);
});
