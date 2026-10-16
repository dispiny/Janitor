-- Review hardening (2026-10-17)
--  1. agent_set_alert_state: service_role only (SEC-10 gap)
--  2. Owner-only: Proxmox fields, server delete, agent_update jobs
--  3. Members can no longer write pve_guests / speed_samples directly (agent only)
--  4. Hide houses.agent_token_hash from clients (column-level SELECT)
--  5. services.use_health_token; houses.alert_after_failures (HEALTHCHECK_TOKEN is opt-in per service)
--  6. agent_jobs.attempts: stale running jobs retry at most 3x (agent_update: once)
--  7. agent_report: house filter on PVE node rows, no prune on empty/failed node lists,
--     skip malformed ids/status instead of rolling back the whole report
--  8. Invite revoke also drops the provisioning allowlist entry
--  9. janitor_maintenance(): retention + agent offline detection (Worker cron)
-- 10. Indexes for token lookup / guests

-- ---------------------------------------------------------------------------
-- 1. alert state RPC
-- ---------------------------------------------------------------------------
revoke all on function public.agent_set_alert_state(text, jsonb) from public, anon, authenticated;
grant execute on function public.agent_set_alert_state(text, jsonb) to service_role;

-- RLS helper is evaluated per row; it only reads, so mark it stable.
create or replace function public.is_house_member(target_house uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.house_members m
    where m.house_id = target_house and m.user_id = auth.uid()
  );
$$;

create or replace function public.is_uuid_text(v text)
returns boolean
language sql
immutable
as $$
  select coalesce(v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false);
$$;

-- ---------------------------------------------------------------------------
-- 2. servers: members read/add/edit, owner deletes; PVE fields owner-only
-- ---------------------------------------------------------------------------
drop policy if exists servers_all on public.servers;
drop policy if exists servers_select on public.servers;
drop policy if exists servers_insert on public.servers;
drop policy if exists servers_update on public.servers;
drop policy if exists servers_delete on public.servers;
create policy servers_select on public.servers for select to authenticated
  using (public.is_house_member(house_id));
create policy servers_insert on public.servers for insert to authenticated
  with check (public.is_house_member(house_id));
create policy servers_update on public.servers for update to authenticated
  using (public.is_house_member(house_id)) with check (public.is_house_member(house_id));
create policy servers_delete on public.servers for delete to authenticated
  using (public.is_house_owner(house_id));

-- Guard runs for every writer. User context (auth.uid() set) must be owner to touch
-- Proxmox fields; any context must keep pve_parent_id inside the same house.
create or replace function public.guard_server_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  pve_changed boolean;
begin
  if new.pve_parent_id is not null and not exists (
    select 1 from public.servers p where p.id = new.pve_parent_id and p.house_id = new.house_id
  ) then
    raise exception 'pve_parent_id must reference a server in the same house';
  end if;

  if tg_op = 'INSERT' then
    pve_changed := new.pve_enabled or new.pve_host is not null or new.pve_token_id is not null
      or new.pve_parent_id is not null;
  else
    pve_changed := new.pve_enabled is distinct from old.pve_enabled
      or new.pve_host is distinct from old.pve_host
      or new.pve_token_id is distinct from old.pve_token_id
      or new.pve_node is distinct from old.pve_node
      or new.pve_parent_id is distinct from old.pve_parent_id
      or new.house_id is distinct from old.house_id;
  end if;

  if pve_changed and auth.uid() is not null and not public.is_house_owner(new.house_id) then
    raise exception 'Proxmox 연동 설정은 owner만 바꿀 수 있습니다.';
  end if;

  -- Never send an existing token to a new host / token id.
  if tg_op = 'UPDATE' and (
    new.pve_host is distinct from old.pve_host
    or new.pve_token_id is distinct from old.pve_token_id
    or new.house_id is distinct from old.house_id
  ) then
    delete from public.server_secrets where server_id = old.id;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_server_write on public.servers;
create trigger guard_server_write
before insert or update on public.servers
for each row execute function public.guard_server_write();

create or replace function public.save_server_secret(p_server_id uuid, p_secret text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  hid uuid;
begin
  select house_id into hid from public.servers where id = p_server_id;
  if hid is null or not public.is_house_owner(hid) then
    raise exception 'forbidden';
  end if;
  if p_secret is null or length(trim(p_secret)) = 0 then
    return;
  end if;
  insert into public.server_secrets(server_id, house_id, pve_token_secret)
  values (p_server_id, hid, p_secret)
  on conflict (server_id) do update
    set pve_token_secret = excluded.pve_token_secret;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. agent-only tables
-- ---------------------------------------------------------------------------
drop policy if exists guests_all on public.pve_guests;
drop policy if exists guests_select on public.pve_guests;
create policy guests_select on public.pve_guests for select to authenticated
  using (public.is_house_member(house_id));

drop policy if exists speed_insert on public.speed_samples;

-- Agent may omit upload when only download succeeded.
alter table public.speed_samples alter column up_mbps drop not null;

drop policy if exists jobs_insert on public.agent_jobs;
create policy jobs_insert on public.agent_jobs for insert to authenticated
  with check (
    public.is_house_member(house_id)
    and (kind <> 'agent_update' or public.is_house_owner(house_id))
  );

-- Alert only after N consecutive failed checks (1 = alert on first failure).
alter table public.houses
  add column if not exists alert_after_failures integer not null default 1
    check (alert_after_failures between 1 and 10);

-- ---------------------------------------------------------------------------
-- 4. houses: token hash is never readable by clients.
--    New houses columns must be added to this grant to be visible in the app.
-- ---------------------------------------------------------------------------
-- Lets the UI know a token was issued without exposing the hash.
alter table public.houses
  add column if not exists agent_token_configured boolean
    generated always as (agent_token_hash is not null) stored;

revoke select on table public.houses from anon, authenticated;
grant select (
  id, name, speed_threshold_mbps, slack_channel, agent_url, agent_host_label,
  agent_last_seen_at, public_ip, public_ip_checked_at, created_at, updated_at,
  agent_status, alert_state, health_interval_sec, pve_interval_sec,
  speed_interval_sec, public_ip_interval_sec, agent_log_tail, alert_after_failures,
  agent_token_configured
) on public.houses to authenticated;

-- ---------------------------------------------------------------------------
-- 5. per-service health token opt-in
-- ---------------------------------------------------------------------------
alter table public.services
  add column if not exists use_health_token boolean not null default false;
comment on column public.services.use_health_token is
  'Send the agent HEALTHCHECK_TOKEN as Bearer only for this service';
-- Rows existing when this migration runs used to receive the token unconditionally;
-- keep that for them (no 401 storm on upgrade). New services default to false —
-- untick per service in the UI. The column was just added, so this touches only pre-existing rows.
update public.services set use_health_token = true where not use_health_token;

-- ---------------------------------------------------------------------------
-- 6. bounded retries
-- ---------------------------------------------------------------------------
alter table public.agent_jobs
  add column if not exists attempts integer not null default 0;

create or replace function public.agent_poll(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  h public.houses%rowtype;
  token_hash text := encode(digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex');
  job_ids uuid[];
  jobs jsonb;
  servers jsonb;
  services jsonb;
  secrets jsonb;
  last_speed timestamptz;
  last_pve timestamptz;
begin
  select * into h from public.houses where agent_token_hash = token_hash;
  if not found then
    raise exception 'unauthorized';
  end if;

  update public.houses set agent_last_seen_at = now(), updated_at = now() where id = h.id;

  -- Agent never reported back (crash / restart). agent_update is not retried:
  -- repeating git pull + deploy on a loop is worse than surfacing the failure.
  update public.agent_jobs j set
    status = case
      when j.kind = 'agent_update' or j.attempts >= 3 then 'error'
      else 'queued'
    end,
    error = case
      when j.kind = 'agent_update' or j.attempts >= 3
        then format('에이전트가 %s회 시도 후 결과를 보고하지 않았습니다.', j.attempts)
      else j.error
    end,
    updated_at = now()
  where j.house_id = h.id and j.status = 'running' and j.updated_at < now() - interval '5 minutes';

  select array_agg(id) into job_ids from (
    select id from public.agent_jobs
    where house_id = h.id and status = 'queued'
    order by created_at asc
    limit 10
    for update skip locked
  ) q;

  if job_ids is not null then
    update public.agent_jobs
      set status = 'running', attempts = attempts + 1, updated_at = now()
      where id = any(job_ids);
  end if;

  select coalesce(jsonb_agg(to_jsonb(j) order by j.created_at), '[]'::jsonb)
    into jobs from public.agent_jobs j
    where job_ids is not null and j.id = any(job_ids);

  select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) into servers from public.servers s where s.house_id = h.id;
  select coalesce(jsonb_agg(to_jsonb(svc)), '[]'::jsonb) into services from public.services svc where svc.house_id = h.id;

  select coalesce(jsonb_object_agg(ss.server_id::text, ss.pve_token_secret), '{}'::jsonb)
    into secrets
    from public.server_secrets ss
    where ss.house_id = h.id;

  select max(recorded_at) into last_speed from public.speed_samples where house_id = h.id;
  select max(updated_at) into last_pve from public.pve_guests where house_id = h.id;

  return jsonb_build_object(
    'house', jsonb_build_object(
      'id', h.id,
      'name', h.name,
      'speed_threshold_mbps', h.speed_threshold_mbps,
      'slack_channel', h.slack_channel,
      'health_interval_sec', h.health_interval_sec,
      'pve_interval_sec', h.pve_interval_sec,
      'speed_interval_sec', h.speed_interval_sec,
      'public_ip_interval_sec', h.public_ip_interval_sec,
      'public_ip_checked_at', h.public_ip_checked_at,
      'last_speed_at', last_speed,
      'last_pve_at', last_pve
    ),
    'jobs', coalesce(jobs, '[]'::jsonb),
    'servers', coalesce(servers, '[]'::jsonb),
    'services', coalesce(services, '[]'::jsonb),
    'secrets', coalesce(secrets, '{}'::jsonb)
  );
end;
$$;

revoke all on function public.agent_poll(text) from public, anon, authenticated;
grant execute on function public.agent_poll(text) to service_role;

-- ---------------------------------------------------------------------------
-- 7. agent_report
--    guestSyncFailedNodes: { "<server_id>": ["node", ...] } — nodes the agent
--    could not list this round; their guests are kept instead of pruned.
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
  agent_st jsonb;
  server_ok boolean;
  sync_id uuid;
  merged_logs jsonb := '[]'::jsonb;
  link public.servers%rowtype;
  node_item jsonb;
  failed_nodes jsonb := coalesce(p_payload->'guestSyncFailedNodes', '{}'::jsonb);
begin
  select * into h from public.houses where agent_token_hash = token_hash;
  if not found then
    raise exception 'unauthorized';
  end if;

  agent_st := coalesce(p_payload->'agentStatus', '{}'::jsonb);
  if jsonb_typeof(failed_nodes) <> 'object' then
    failed_nodes := '{}'::jsonb;
  end if;

  if p_payload ? 'logs' and jsonb_typeof(p_payload->'logs') = 'array' then
    select coalesce(jsonb_agg(value order by rn desc), '[]'::jsonb)
      into merged_logs
    from (
      select value, row_number() over (order by batch desc, n desc) as rn
      from (
        select value, 0::int as batch, ordinality as n
        from jsonb_array_elements(coalesce(h.agent_log_tail, '[]'::jsonb)) with ordinality
        union all
        select value, 1::int as batch, ordinality as n
        from jsonb_array_elements(coalesce(p_payload->'logs', '[]'::jsonb)) with ordinality
      ) u
    ) ranked
    where rn <= 100;
  else
    merged_logs := coalesce(h.agent_log_tail, '[]'::jsonb);
  end if;

  update public.houses set
    agent_last_seen_at = now(),
    updated_at = now(),
    public_ip = coalesce(p_payload->>'publicIp', public_ip),
    public_ip_checked_at = case when p_payload ? 'publicIp' then now() else public_ip_checked_at end,
    agent_host_label = coalesce(
      nullif(p_payload->>'agentHostLabel', ''),
      nullif(agent_st->>'hostname', ''),
      agent_host_label
    ),
    agent_status = case
      when p_payload ? 'agentStatus' and length(agent_st::text) <= 65536 then agent_st
      else agent_status
    end,
    agent_log_tail = merged_logs
  where id = h.id;

  for item in select * from jsonb_array_elements(coalesce(p_payload->'servers', '[]'::jsonb))
  loop
    if not public.is_uuid_text(item->>'id') then
      continue;
    end if;
    update public.servers
      set is_on = coalesce((item->>'is_on')::boolean, is_on), updated_at = now()
      where id = (item->>'id')::uuid and house_id = h.id;
  end loop;

  for item in select * from jsonb_array_elements(coalesce(p_payload->'services', '[]'::jsonb))
  loop
    if not public.is_uuid_text(item->>'id') then
      continue;
    end if;
    update public.services set
      last_ok = (item->>'ok')::boolean,
      last_code = case when item->>'code' ~ '^-?[0-9]+$' then (item->>'code')::int end,
      last_ms = case when item->>'ms' ~ '^[0-9]+$' then (item->>'ms')::int end,
      last_checked_at = now(),
      updated_at = now()
    where id = (item->>'id')::uuid and house_id = h.id;
  end loop;

  for item in select * from jsonb_array_elements(coalesce(p_payload->'guests', '[]'::jsonb))
  loop
    if not public.is_uuid_text(item->>'server_id') or coalesce(item->>'name', '') = '' then
      continue;
    end if;
    select exists (
      select 1 from public.servers s
      where s.id = (item->>'server_id')::uuid and s.house_id = h.id
    ) into server_ok;
    if not server_ok then
      continue;
    end if;

    insert into public.pve_guests(server_id, house_id, name, node, kind, is_on, vmid, updated_at)
    values (
      (item->>'server_id')::uuid,
      h.id,
      item->>'name',
      coalesce(item->>'node', ''),
      coalesce(item->>'kind', 'VM'),
      coalesce((item->>'is_on')::boolean, false),
      case when item->>'vmid' ~ '^[0-9]+$' then (item->>'vmid')::int end,
      now()
    )
    on conflict (server_id, node, name) do update set
      kind = excluded.kind,
      is_on = excluded.is_on,
      vmid = excluded.vmid,
      updated_at = now()
    where pve_guests.house_id = h.id;
  end loop;

  -- Full replace for servers included in this pve_sync (drop guests that disappeared),
  -- except on nodes the agent failed to list this round.
  for sync_id in
    select (value)::uuid
    from jsonb_array_elements_text(coalesce(p_payload->'guestSyncServerIds', '[]'::jsonb)) value
    where public.is_uuid_text(value)
  loop
    if not exists (select 1 from public.servers s where s.id = sync_id and s.house_id = h.id) then
      continue;
    end if;
    delete from public.pve_guests g
    where g.house_id = h.id
      and g.server_id = sync_id
      and not (
        jsonb_typeof(failed_nodes->(sync_id::text)) = 'array'
        and failed_nodes->(sync_id::text) ? g.node
      )
      and not exists (
        select 1
        from jsonb_array_elements(coalesce(p_payload->'guests', '[]'::jsonb)) guest_row
        where guest_row->>'server_id' = sync_id::text
          and coalesce(guest_row->>'node', '') = g.node
          and guest_row->>'name' = g.name
      );
  end loop;

  -- Register every discovered node as a server under its Proxmox API link.
  for item in select * from jsonb_array_elements(coalesce(p_payload->'pveNodes', '[]'::jsonb))
  loop
    if not public.is_uuid_text(item->>'server_id') then
      continue;
    end if;
    select * into link from public.servers s
    where s.id = (item->>'server_id')::uuid
      and s.house_id = h.id
      and s.pve_parent_id is null;
    if not found or jsonb_typeof(item->'nodes') <> 'array' then
      continue;
    end if;

    for node_item in select * from jsonb_array_elements(item->'nodes')
    loop
      if coalesce(node_item->>'node', '') = '' then
        continue;
      end if;
      update public.servers set
        is_on = coalesce((node_item->>'online')::boolean, false),
        updated_at = now()
      where house_id = h.id and pve_parent_id = link.id and pve_node = node_item->>'node';
      if not found then
        insert into public.servers(
          house_id, name, role, manage_url, wol_mode, is_on, pve_enabled, pve_node, pve_parent_id
        ) values (
          h.id,
          node_item->>'node',
          'Proxmox 노드',
          coalesce(nullif(link.manage_url, ''), link.pve_host, ''),
          'off',
          coalesce((node_item->>'online')::boolean, false),
          false,
          node_item->>'node',
          link.id
        );
      end if;
    end loop;

    -- An empty list is far more likely a transient API glitch than "cluster has no
    -- nodes"; keep user-edited node rows (MAC, manage_url) in that case.
    if jsonb_array_length(item->'nodes') > 0 then
      delete from public.servers c
      where c.house_id = h.id
        and c.pve_parent_id = link.id
        and not exists (
          select 1 from jsonb_array_elements(item->'nodes') node_row
          where node_row->>'node' = c.pve_node
        );
    end if;
  end loop;

  if p_payload ? 'speed'
    and coalesce(p_payload->'speed'->>'down_mbps', '') ~ '^[0-9]+(\.[0-9]+)?$' then
    insert into public.speed_samples(house_id, down_mbps, up_mbps, recorded_at)
    values (
      h.id,
      (p_payload->'speed'->>'down_mbps')::numeric,
      case when coalesce(p_payload->'speed'->>'up_mbps', '') ~ '^[0-9]+(\.[0-9]+)?$'
        then (p_payload->'speed'->>'up_mbps')::numeric end,
      now()
    );
  end if;

  for item in select * from jsonb_array_elements(coalesce(p_payload->'jobs', '[]'::jsonb))
  loop
    if not public.is_uuid_text(item->>'id') or coalesce(item->>'status', '') not in ('done', 'error') then
      continue;
    end if;
    update public.agent_jobs set
      status = item->>'status',
      result = item->'result',
      error = item->>'error',
      updated_at = now()
    where id = (item->>'id')::uuid and house_id = h.id;
  end loop;

  select * into h from public.houses where id = h.id;

  return jsonb_build_object(
    'ok', true,
    'house', jsonb_build_object(
      'id', h.id,
      'name', h.name,
      'slack_channel', h.slack_channel,
      'speed_threshold_mbps', h.speed_threshold_mbps,
      'alert_after_failures', h.alert_after_failures,
      'alert_state', coalesce(h.alert_state, '{}'::jsonb),
      'service_ids', (
        select coalesce(jsonb_agg(svc.id), '[]'::jsonb) from public.services svc where svc.house_id = h.id
      )
    )
  );
end;
$$;

revoke all on function public.agent_report(text, jsonb) from public, anon, authenticated;
grant execute on function public.agent_report(text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 8. revoking an invite also revokes the signup allowlist entry
-- ---------------------------------------------------------------------------
create or replace function public.cleanup_allowlist_on_invite_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Keep the entry if the address already has an account or another pending invite.
  if exists (select 1 from auth.users u where lower(u.email) = lower(old.email))
     or exists (select 1 from public.house_invites i where lower(i.email) = lower(old.email) and i.id <> old.id) then
    return old;
  end if;
  delete from public.auth_provision_allowlist a where lower(a.email) = lower(old.email);
  return old;
end;
$$;

drop trigger if exists cleanup_allowlist_on_invite_delete on public.house_invites;
create trigger cleanup_allowlist_on_invite_delete
after delete on public.house_invites
for each row execute function public.cleanup_allowlist_on_invite_delete();

-- ---------------------------------------------------------------------------
-- 9. maintenance (called by the Worker cron with service_role)
--    Returns houses whose agent just went silent so the Worker can alert once.
--    The 'agent:offline' alert_state key is cleared by the Worker on next report.
-- ---------------------------------------------------------------------------
create or replace function public.janitor_maintenance(p_offline_after_sec integer default 600)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  offline jsonb;
  speed_deleted integer;
  jobs_deleted integer;
begin
  delete from public.speed_samples where recorded_at < now() - interval '90 days';
  get diagnostics speed_deleted = row_count;

  delete from public.agent_jobs
    where status in ('done', 'error') and updated_at < now() - interval '30 days';
  get diagnostics jobs_deleted = row_count;

  with gone as (
    update public.houses h set
      alert_state = coalesce(h.alert_state, '{}'::jsonb) || jsonb_build_object(
        'agent:offline',
        jsonb_build_object('since', now(), 'kind', 'agent', 'name', '홈 에이전트')
      ),
      updated_at = now()
    where h.agent_token_hash is not null
      and h.agent_last_seen_at is not null
      and h.agent_last_seen_at < now() - make_interval(secs => greatest(p_offline_after_sec, 120))
      and not (coalesce(h.alert_state, '{}'::jsonb) ? 'agent:offline')
    returning h.id, h.name, h.slack_channel, h.agent_last_seen_at, h.agent_host_label
  )
  select coalesce(jsonb_agg(to_jsonb(gone)), '[]'::jsonb) into offline from gone;

  return jsonb_build_object(
    'offline', offline,
    'speedSamplesDeleted', speed_deleted,
    'jobsDeleted', jobs_deleted
  );
end;
$$;

revoke all on function public.janitor_maintenance(integer) from public, anon, authenticated;
grant execute on function public.janitor_maintenance(integer) to service_role;

-- ---------------------------------------------------------------------------
-- 10. indexes
-- ---------------------------------------------------------------------------
create index if not exists houses_agent_token_hash_idx
  on public.houses(agent_token_hash) where agent_token_hash is not null;
create index if not exists pve_guests_house_id_idx on public.pve_guests(house_id);
create index if not exists agent_jobs_status_updated_idx on public.agent_jobs(status, updated_at);

-- Unique health URL per house (only when existing data is already clean).
do $$
begin
  if not exists (
    select 1 from public.services group by house_id, health_url having count(*) > 1
  ) then
    create unique index if not exists services_house_health_url_key
      on public.services(house_id, health_url);
  else
    raise notice 'services has duplicate (house_id, health_url); unique index skipped';
  end if;
end;
$$;
