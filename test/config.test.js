import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("agent API requires service role and does not fall back to anon", () => {
  const api = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
  assert.match(api, /agentServiceRoleConfigured/);
  assert.match(api, /Never fall back to the anon key/);
  assert.doesNotMatch(api, /serviceClient\(env\)\s*\?\?\s*anonClient/);
});

test("wrangler config exposes supabase url without secrets or service role", () => {
  const raw = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(raw, /ypklxfwpbyroxdolgiun\.supabase\.co/);
  // Secret names may appear in comments; values must not be committed under vars.
  assert.doesNotMatch(raw, /"SUPABASE_SERVICE_ROLE_KEY"\s*:/);
  assert.doesNotMatch(raw, /"SUPABASE_ANON_KEY"\s*:/);
  assert.doesNotMatch(raw, /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9/);
});

test("public app has no demo or sample seed data", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const js = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(html, /demo-enter|샘플 집|203\.0\.113\.42/);
  assert.doesNotMatch(js, /sampleServers|sampleServices|demo@example\.com|historyMbps/);
});

test("agent requires real env and does not ship dummy inventory", () => {
  const index = readFileSync(new URL("../agent/src/index.ts", import.meta.url), "utf8");
  const config = readFileSync(new URL("../agent/src/config.ts", import.meta.url), "utf8");
  const poller = readFileSync(new URL("../agent/src/poller.ts", import.meta.url), "utf8");
  assert.match(config, /JANITOR_API_URL/);
  assert.match(config, /AGENT_TOKEN/);
  assert.match(index, /startPoller/);
  assert.match(poller, /ticking/);
  assert.doesNotMatch(index + config + poller, /sampleServers|203\.0\.113\.42|\/wol\.cgi/);
});

test("house check interval migration exposes schedule fields on agent_poll", () => {
  const sql = readFileSync(
    new URL("../supabase/migrations/20261014180000_house_check_intervals.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /public_ip_interval_sec/);
  assert.match(sql, /health_interval_sec/);
  assert.match(sql, /last_speed_at/);
  assert.match(sql, /create or replace function public\.agent_poll/);
});

test("migrations ship full RLS RPC and invites SQL", () => {
  const rpc = readFileSync(
    new URL("../supabase/migrations/20261011181000_agent_rpcs_and_invites.sql", import.meta.url),
    "utf8",
  );
  assert.match(rpc, /create table if not exists public\.house_invites/);
  assert.match(rpc, /create or replace function public\.agent_poll/);
  assert.match(rpc, /create policy houses_select/);
  assert.ok(rpc.length > 2000, "migration must not be an empty stub");
});

test("security lockdown migration removes self-join and scopes agent RPCs", () => {
  const sql = readFileSync(
    new URL("../supabase/migrations/20261013070000_security_lockdown.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /is_house_owner/);
  assert.match(sql, /drop policy if exists members_insert/);
  assert.match(sql, /drop policy if exists houses_insert/);
  assert.match(sql, /grant execute on function public\.agent_poll\(text\) to service_role/);

  const revoke = readFileSync(
    new URL("../supabase/migrations/20261013070100_revoke_agent_rpc_anon.sql", import.meta.url),
    "utf8",
  );
  assert.match(revoke, /revoke all on function public\.agent_poll\(text\) from public, anon, authenticated/);
});

test("admin-provisioned auth: no client signUp UI", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const js = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(html, /id="panel-signup"|id="tab-signup"/);
  assert.doesNotMatch(js, /\.signUp\s*\(/);
  const mig = readFileSync(
    new URL("../supabase/migrations/20261014090000_admin_provisioned_users.sql", import.meta.url),
    "utf8",
  );
  assert.match(mig, /auth_provision_allowlist/);
  assert.match(mig, /adminProvisionedOnly/);
  assert.match(mig, /invite_house_member/);
});
