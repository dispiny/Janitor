-- SEC-01..04, SEC-10, SEC-11: lock down RLS, owner helpers, agent RPC surface, report integrity.
-- Depends on 20261011181000_agent_rpcs_and_invites.sql

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.is_house_owner(target_house uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.house_members m
    where m.house_id = target_house
      and m.user_id = auth.uid()
      and m.role = 'owner'
  );
$$;

revoke all on function public.is_house_owner(uuid) from public, anon;
grant execute on function public.is_house_owner(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- SEC-01: no direct house_members INSERT (claim_house_invites / create_house only)
-- ---------------------------------------------------------------------------
drop policy if exists members_insert on public.house_members;

-- ---------------------------------------------------------------------------
-- SEC-03: no direct houses INSERT (create_house only)
-- ---------------------------------------------------------------------------
drop policy if exists houses_insert on public.houses;

-- ---------------------------------------------------------------------------
-- SEC-02 / SEC-04: owner-only destructive / privileged house ops
-- ---------------------------------------------------------------------------
drop policy if exists houses_delete on public.houses;
create policy houses_delete on public.houses for delete to authenticated
  using (public.is_house_owner(id));

drop policy if exists houses_update on public.houses;
create policy houses_update on public.houses for update to authenticated
  using (public.is_house_owner(id))
  with check (public.is_house_owner(id));

drop policy if exists members_delete on public.house_members;
create policy members_delete on public.house_members for delete to authenticated
  using (
    (public.is_house_owner(house_id) and user_id <> auth.uid())
    or (user_id = auth.uid() and role = 'member')
  );

drop policy if exists invites_insert on public.house_invites;
create policy invites_insert on public.house_invites for insert to authenticated
  with check (public.is_house_owner(house_id));

drop policy if exists invites_delete on public.house_invites;
create policy invites_delete on public.house_invites for delete to authenticated
  using (public.is_house_owner(house_id));

-- ---------------------------------------------------------------------------
-- SEC-11: agent_report must only touch servers that belong to the token house
-- ---------------------------------------------------------------------------
create or replace function public.agent_report(p_token text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  h public.houses%rowtype;
  token_hash text := encode(digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex');
  item jsonb;
  server_ok boolean;
begin
  select * into h from public.houses where agent_token_hash = token_hash;
  if not found then
    raise exception 'unauthorized';
  end if;

  update public.houses set
    agent_last_seen_at = now(),
    updated_at = now(),
    public_ip = coalesce(p_payload->>'publicIp', public_ip),
    public_ip_checked_at = case when p_payload ? 'publicIp' then now() else public_ip_checked_at end,
    agent_host_label = coalesce(p_payload->>'agentHostLabel', agent_host_label)
  where id = h.id;

  for item in select * from jsonb_array_elements(coalesce(p_payload->'servers', '[]'::jsonb))
  loop
    update public.servers
      set is_on = (item->>'is_on')::boolean, updated_at = now()
      where id = (item->>'id')::uuid and house_id = h.id;
  end loop;

  for item in select * from jsonb_array_elements(coalesce(p_payload->'services', '[]'::jsonb))
  loop
    update public.services set
      last_ok = (item->>'ok')::boolean,
      last_code = (item->>'code')::int,
      last_ms = (item->>'ms')::int,
      last_checked_at = now(),
      updated_at = now()
    where id = (item->>'id')::uuid and house_id = h.id;
  end loop;

  for item in select * from jsonb_array_elements(coalesce(p_payload->'guests', '[]'::jsonb))
  loop
    select exists (
      select 1 from public.servers s
      where s.id = (item->>'server_id')::uuid and s.house_id = h.id
    ) into server_ok;
    if not server_ok then
      continue;
    end if;

    insert into public.pve_guests(server_id, house_id, name, kind, is_on, vmid, updated_at)
    values (
      (item->>'server_id')::uuid,
      h.id,
      item->>'name',
      coalesce(item->>'kind', 'VM'),
      coalesce((item->>'is_on')::boolean, false),
      nullif(item->>'vmid', '')::int,
      now()
    )
    on conflict (server_id, name) do update set
      kind = excluded.kind,
      is_on = excluded.is_on,
      vmid = excluded.vmid,
      updated_at = now();
  end loop;

  if p_payload ? 'speed' then
    insert into public.speed_samples(house_id, down_mbps, up_mbps, recorded_at)
    values (
      h.id,
      (p_payload->'speed'->>'down_mbps')::numeric,
      (p_payload->'speed'->>'up_mbps')::numeric,
      now()
    );
  end if;

  for item in select * from jsonb_array_elements(coalesce(p_payload->'jobs', '[]'::jsonb))
  loop
    update public.agent_jobs set
      status = item->>'status',
      result = item->'result',
      error = item->>'error',
      updated_at = now()
    where id = (item->>'id')::uuid and house_id = h.id;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'house', jsonb_build_object(
      'id', h.id,
      'slack_channel', h.slack_channel,
      'speed_threshold_mbps', h.speed_threshold_mbps
    )
  );
end;
$$;

-- Ensure service_role can execute agent RPCs (Worker path).
-- Anon revoke is in 20261013070100_revoke_agent_rpc_anon.sql — apply after
-- Worker has SUPABASE_SERVICE_ROLE_KEY and is redeployed.
grant execute on function public.agent_poll(text) to service_role;
grant execute on function public.agent_report(text, jsonb) to service_role;
