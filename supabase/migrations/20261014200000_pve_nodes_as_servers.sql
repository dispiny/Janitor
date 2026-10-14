-- Proxmox: nodes discovered through an API link become servers (one row per node).

alter table public.servers
  add column if not exists pve_parent_id uuid references public.servers(id) on delete cascade;

create unique index if not exists servers_pve_parent_node_key
  on public.servers(pve_parent_id, pve_node)
  where pve_parent_id is not null;

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
  server_ok boolean;
  sync_id uuid;
  merged_logs jsonb := '[]'::jsonb;
  link public.servers%rowtype;
  node_item jsonb;
begin
  select * into h from public.houses where agent_token_hash = token_hash;
  if not found then
    raise exception 'unauthorized';
  end if;

  status := coalesce(p_payload->'agentStatus', '{}'::jsonb);

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
      nullif(status->>'hostname', ''),
      agent_host_label
    ),
    agent_status = case
      when p_payload ? 'agentStatus' then status
      else agent_status
    end,
    agent_log_tail = merged_logs
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

    insert into public.pve_guests(server_id, house_id, name, node, kind, is_on, vmid, updated_at)
    values (
      (item->>'server_id')::uuid,
      h.id,
      item->>'name',
      coalesce(item->>'node', ''),
      coalesce(item->>'kind', 'VM'),
      coalesce((item->>'is_on')::boolean, false),
      nullif(item->>'vmid', '')::int,
      now()
    )
    on conflict (server_id, node, name) do update set
      kind = excluded.kind,
      is_on = excluded.is_on,
      vmid = excluded.vmid,
      updated_at = now();
  end loop;

  -- Full replace for servers included in this pve_sync (drop guests that disappeared).
  for sync_id in
    select (value)::uuid
    from jsonb_array_elements_text(coalesce(p_payload->'guestSyncServerIds', '[]'::jsonb)) value
  loop
    if not exists (select 1 from public.servers s where s.id = sync_id and s.house_id = h.id) then
      continue;
    end if;
    delete from public.pve_guests g
    where g.house_id = h.id
      and g.server_id = sync_id
      and not exists (
        select 1
        from jsonb_array_elements(coalesce(p_payload->'guests', '[]'::jsonb)) item
        where (item->>'server_id')::uuid = sync_id
          and coalesce(item->>'node', '') = g.node
          and item->>'name' = g.name
      );
  end loop;

  -- Register every discovered node as a server under its Proxmox API link.
  for item in select * from jsonb_array_elements(coalesce(p_payload->'pveNodes', '[]'::jsonb))
  loop
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
      where pve_parent_id = link.id and pve_node = node_item->>'node';
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

    delete from public.servers c
    where c.pve_parent_id = link.id
      and not exists (
        select 1 from jsonb_array_elements(item->'nodes') n
        where n->>'node' = c.pve_node
      );
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

revoke all on function public.agent_report(text, jsonb) from public, anon, authenticated;
grant execute on function public.agent_report(text, jsonb) to service_role;
