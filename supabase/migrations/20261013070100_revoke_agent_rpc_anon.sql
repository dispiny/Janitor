-- SEC-10: revoke PostgREST anon/authenticated execute on agent RPCs.
-- Apply ONLY after:
--   1) wrangler secret put SUPABASE_SERVICE_ROLE_KEY
--   2) npm run deploy (Worker uses service role for /api/agent/*)
-- Until then, agents can still call via anon through the Worker.

revoke all on function public.agent_poll(text) from public, anon, authenticated;
revoke all on function public.agent_report(text, jsonb) from public, anon, authenticated;
grant execute on function public.agent_poll(text) to service_role;
grant execute on function public.agent_report(text, jsonb) to service_role;
