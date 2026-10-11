import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("wrangler config exposes supabase url without service role", () => {
  const raw = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(raw, /ypklxfwpbyroxdolgiun\.supabase\.co/);
  assert.doesNotMatch(raw, /SERVICE_ROLE/);
});

test("public app has no demo or sample seed data", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const js = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(html, /demo-enter|샘플 집|203\.0\.113\.42/);
  assert.doesNotMatch(js, /sampleServers|sampleServices|demo@example\.com|historyMbps/);
});

test("agent requires real env and does not ship dummy inventory", () => {
  const agent = readFileSync(new URL("../agent/src/index.js", import.meta.url), "utf8");
  assert.match(agent, /JANITOR_API_URL/);
  assert.match(agent, /AGENT_TOKEN/);
  assert.doesNotMatch(agent, /sampleServers|203\.0\.113\.42/);
});
