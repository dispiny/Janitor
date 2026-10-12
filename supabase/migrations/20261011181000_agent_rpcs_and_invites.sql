-- RPCs, RLS, house_invites, grants (reproducible; mirrors remote project)
-- Depends on 20261011180000_janitor_init.sql

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.is_house_member(target_house uuid)
returns boolean
language sql
volatile
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.house_members m
    where m.house_id = target_house and m.user_id = auth.uid()
  );
$$;

create or replace function public.current_house_ids()
returns setof uuid
language sql
volatile
security definer
set search_path = public
as $$
  select house_id from public.house_members where user_id = auth.uid();
$$;

create or replace function public.handle_new_house_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.house_members (house_id, user_id, email, role)
  values (new.id, auth.uid(), coalesce(auth.jwt() ->> 'email', ''), 'owner')
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists on_house_created on public.houses;
create trigger on_house_created
after insert on public.houses
for each row execute function public.handle_new_house_owner();

-- ---------------------------------------------------------------------------
-- Invites
-- ---------------------------------------------------------------------------
create table if not exists public.house_invites (
  id uuid primary key default gen_random_uuid(),
  house_id uuid not null references public.houses(id) on delete cascade,
  email text not null,
  invited_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (house_id, email)
);

alter table public.house_invites enable row level security;

-- ---------------------------------------------------------------------------
-- RLS (core tables — init may have enabled RLS without policies)
-- ---------------------------------------------------------------------------
alter table public.houses enable row level security;
alter table public.house_members enable row level security;
alter table public.servers enable row level security;
alter table public.server_secrets enable row level security;
alter table public.services enable row level security;
alter table public.pve_guests enable row level security;
alter table public.speed_samples enable row level security;
alter table public.agent_jobs enable row level security;

drop policy if exists houses_select on public.houses;
drop policy if exists houses_update on public.houses;
drop policy if exists houses_insert on public.houses;
drop policy if exists houses_delete on public.houses;
create policy houses_select on public.houses for select to authenticated
  using (public.is_house_member(id));
create policy houses_update on public.houses for update to authenticated
  using (public.is_house_member(id)) with check (public.is_house_member(id));
create policy houses_insert on public.houses for insert to authenticated
  with check (true);
create policy houses_delete on public.houses for delete to authenticated
  using (public.is_house_member(id));

drop policy if exists members_select on public.house_members;
drop policy if exists members_insert on public.house_members;
drop policy if exists members_delete on public.house_members;
create policy members_select on public.house_members for select to authenticated
  using (public.is_house_member(house_id));
create policy members_insert on public.house_members for insert to authenticated
  with check (user_id = auth.uid() or public.is_house_member(house_id));
create policy members_delete on public.house_members for delete to authenticated
  using (public.is_house_member(house_id) and user_id <> auth.uid());

drop policy if exists invites_select on public.house_invites;
drop policy if exists invites_insert on public.house_invites;
drop policy if exists invites_delete on public.house_invites;
drop policy if exists invites_auth_admin_select on public.house_invites;
create policy invites_select on public.house_invites for select to authenticated
  using (
    public.is_house_member(house_id)
    or lower(email) = lower(coalesce(auth.jwt()->>'email', ''))
  );
create policy invites_insert on public.house_invites for insert to authenticated
  with check (public.is_house_member(house_id));
create policy invites_delete on public.house_invites for delete to authenticated
  using (public.is_house_member(house_id));
create policy invites_auth_admin_select on public.house_invites
  for select to supabase_auth_admin using (true);

drop policy if exists servers_all on public.servers;
create policy servers_all on public.servers for all to authenticated
  using (public.is_house_member(house_id)) with check (public.is_house_member(house_id));

drop policy if exists server_secrets_deny_all on public.server_secrets;
create policy server_secrets_deny_all on public.server_secrets for all to authenticated
  using (false) with check (false);

drop policy if exists services_all on public.services;
create policy services_all on public.services for all to authenticated
  using (public.is_house_member(house_id)) with check (public.is_house_member(house_id));

drop policy if exists guests_all on public.pve_guests;
create policy guests_all on public.pve_guests for all to authenticated
  using (public.is_house_member(house_id)) with check (public.is_house_member(house_id));

drop policy if exists speed_select on public.speed_samples;
drop policy if exists speed_insert on public.speed_samples;
create policy speed_select on public.speed_samples for select to authenticated
  using (public.is_house_member(house_id));
create policy speed_insert on public.speed_samples for insert to authenticated
  with check (public.is_house_member(house_id));

drop policy if exists jobs_select on public.agent_jobs;
drop policy if exists jobs_insert on public.agent_jobs;
create policy jobs_select on public.agent_jobs for select to authenticated
  using (public.is_house_member(house_id));
create policy jobs_insert on public.agent_jobs for insert to authenticated
  with check (public.is_house_member(house_id));

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------
create or replace function public.create_house(p_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  mail text := lower(coalesce(auth.jwt()->>'email', ''));
  hid uuid;
begin
  if uid is null then
    raise exception 'unauthorized';
  end if;
  if p_name is null or length(trim(p_name)) = 0 then
    raise exception '집 이름이 필요합니다.';
  end if;
  if exists(select 1 from public.house_members where user_id = uid) then
    select house_id into hid from public.house_members where user_id = uid limit 1;
    return hid;
  end if;
  insert into public.houses(name) values (trim(p_name)) returning id into hid;
  insert into public.house_members(house_id, user_id, email, role)
  values (hid, uid, mail, 'owner')
  on conflict do nothing;
  return hid;
end;
$$;

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
  if hid is null or not public.is_house_member(hid) then
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

create or replace function public.claim_house_invites()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  mail text := lower(coalesce(auth.jwt()->>'email', ''));
  n int := 0;
  r record;
begin
  if uid is null or mail = '' then
    return 0;
  end if;
  for r in select * from public.house_invites where lower(email) = mail
  loop
    insert into public.house_members(house_id, user_id, email, role)
    values (r.house_id, uid, mail, 'member')
    on conflict do nothing;
    delete from public.house_invites where id = r.id;
    n := n + 1;
  end loop;
  return n;
end;
$$;

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
begin
  select * into h from public.houses where agent_token_hash = token_hash;
  if not found then
    raise exception 'unauthorized';
  end if;

  update public.houses set agent_last_seen_at = now(), updated_at = now() where id = h.id;

  update public.agent_jobs
    set status = 'queued', updated_at = now()
    where house_id = h.id and status = 'running' and updated_at < now() - interval '5 minutes';

  select array_agg(id) into job_ids from (
    select id from public.agent_jobs
    where house_id = h.id and status = 'queued'
    order by created_at asc
    limit 10
    for update skip locked
  ) q;

  if job_ids is not null then
    update public.agent_jobs
      set status = 'running', updated_at = now()
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

  return jsonb_build_object(
    'house', jsonb_build_object(
      'id', h.id,
      'name', h.name,
      'speed_threshold_mbps', h.speed_threshold_mbps,
      'slack_channel', h.slack_channel
    ),
    'jobs', coalesce(jobs, '[]'::jsonb),
    'servers', coalesce(servers, '[]'::jsonb),
    'services', coalesce(services, '[]'::jsonb),
    'secrets', coalesce(secrets, '{}'::jsonb)
  );
end;
$$;

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

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated, supabase_auth_admin;

revoke all on function public.is_house_member(uuid) from public, anon;
revoke all on function public.current_house_ids() from public, anon;
revoke all on function public.handle_new_house_owner() from public, anon, authenticated;
grant execute on function public.is_house_member(uuid) to authenticated;
grant execute on function public.current_house_ids() to authenticated;

grant execute on function public.create_house(text) to authenticated;
grant execute on function public.save_server_secret(uuid, text) to authenticated;
grant execute on function public.claim_house_invites() to authenticated;
grant execute on function public.agent_poll(text) to anon, authenticated;
grant execute on function public.agent_report(text, jsonb) to anon, authenticated;

grant select, insert, update, delete on
  public.houses, public.house_members, public.house_invites,
  public.servers, public.services, public.pve_guests,
  public.speed_samples, public.agent_jobs
  to authenticated;

revoke all on table public.server_secrets from anon, authenticated;
grant all on table public.server_secrets to service_role;
grant select on table public.house_invites to supabase_auth_admin;
