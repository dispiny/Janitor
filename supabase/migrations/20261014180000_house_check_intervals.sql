-- Per-house automatic check intervals (seconds). 0 = disabled.
-- Defaults match how often each signal typically changes / how expensive it is.

alter table public.houses
  add column if not exists health_interval_sec integer not null default 300
    check (health_interval_sec >= 0 and health_interval_sec <= 604800),
  add column if not exists pve_interval_sec integer not null default 900
    check (pve_interval_sec >= 0 and pve_interval_sec <= 604800),
  add column if not exists speed_interval_sec integer not null default 3600
    check (speed_interval_sec >= 0 and speed_interval_sec <= 604800),
  add column if not exists public_ip_interval_sec integer not null default 7200
    check (public_ip_interval_sec >= 0 and public_ip_interval_sec <= 604800);

comment on column public.houses.health_interval_sec is 'Auto health_all interval (sec). Default 5 min. 0=off';
comment on column public.houses.pve_interval_sec is 'Auto pve_sync interval (sec). Default 15 min. 0=off';
comment on column public.houses.speed_interval_sec is 'Auto speed_probe interval (sec). Default 1 h. 0=off';
comment on column public.houses.public_ip_interval_sec is 'Auto public IP lookup interval (sec). Default 2 h. 0=off';

-- agent_poll: expose schedule + last-run hints so the home agent can decide what is due.
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
