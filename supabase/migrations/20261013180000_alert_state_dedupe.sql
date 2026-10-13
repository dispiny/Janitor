-- Persist open Slack incidents so we only notify on new failures.

alter table public.houses
  add column if not exists alert_state jsonb not null default '{}'::jsonb;

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
  status jsonb;
begin
  select * into h from public.houses where agent_token_hash = token_hash;
  if not found then
    raise exception 'unauthorized';
  end if;

  status := coalesce(p_payload->'agentStatus', '{}'::jsonb);

  update public.houses set
    agent_last_seen_at = now(),
    updated_at = now(),
    public_ip = coalesce(p_payload->>'publicIp', public_ip),
    public_ip_checked_at = case when p_payload ? 'publicIp' then now() else public_ip_checked_at end,
    agent_host_label = coalesce(
      nullif(p_payload->>'agentHostLabel', ''),
      nullif(status->>'hostname', ''),
      agent_host_label
    ),
    agent_status = case
      when p_payload ? 'agentStatus' then status
      else agent_status
    end
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

  select * into h from public.houses where id = h.id;

  return jsonb_build_object(
    'ok', true,
    'house', jsonb_build_object(
      'id', h.id,
      'name', h.name,
      'slack_channel', h.slack_channel,
      'speed_threshold_mbps', h.speed_threshold_mbps,
      'alert_state', coalesce(h.alert_state, '{}'::jsonb)
    )
  );
end;
$$;

create or replace function public.agent_set_alert_state(p_token text, p_state jsonb)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  token_hash text := encode(digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex');
  hid uuid;
begin
  select id into hid from public.houses where agent_token_hash = token_hash;
  if hid is null then
    raise exception 'unauthorized';
  end if;
  update public.houses
    set alert_state = coalesce(p_state, '{}'::jsonb),
        updated_at = now()
    where id = hid;
end;
$$;

revoke all on function public.agent_set_alert_state(text, jsonb) from public, authenticated;
grant execute on function public.agent_report(text, jsonb) to anon, authenticated;
grant execute on function public.agent_set_alert_state(text, jsonb) to anon, authenticated;
