-- Janitor core schema (no seed/dummy rows)
-- Applied remotely via Supabase MCP; kept here for source control.

create extension if not exists pgcrypto;

create table if not exists public.houses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  speed_threshold_mbps numeric not null default 100,
  slack_channel text not null default '#homelab',
  agent_url text,
  agent_token_hash text,
  agent_host_label text,
  agent_last_seen_at timestamptz,
  public_ip text,
  public_ip_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.house_members (
  house_id uuid not null references public.houses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  role text not null default 'owner' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (house_id, user_id)
);

create index if not exists house_members_user_id_idx on public.house_members(user_id);

create table if not exists public.servers (
  id uuid primary key default gen_random_uuid(),
  house_id uuid not null references public.houses(id) on delete cascade,
  name text not null,
  role text not null default '',
  manage_url text not null default '',
  wol_mode text not null default 'off' check (wol_mode in ('off', 'uplus', 'manual')),
  wol_uplus_device text,
  wol_mac text,
  wol_broadcast text,
  wol_port integer default 9,
  is_on boolean not null default false,
  pve_enabled boolean not null default false,
  pve_host text,
  pve_node text,
  pve_token_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists servers_house_id_idx on public.servers(house_id);

create table if not exists public.server_secrets (
  server_id uuid primary key references public.servers(id) on delete cascade,
  house_id uuid not null references public.houses(id) on delete cascade,
  pve_token_secret text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.services (
  id uuid primary key default gen_random_uuid(),
  house_id uuid not null references public.houses(id) on delete cascade,
  name text not null,
  host_label text not null default '',
  health_url text not null,
  expect_status integer not null default 200,
  manage_url text not null default '',
  slack_on_fail boolean not null default true,
  last_ok boolean,
  last_code integer,
  last_ms integer,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists services_house_id_idx on public.services(house_id);

create table if not exists public.pve_guests (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers(id) on delete cascade,
  house_id uuid not null references public.houses(id) on delete cascade,
  name text not null,
  kind text not null default 'VM',
  is_on boolean not null default false,
  vmid integer,
  updated_at timestamptz not null default now(),
  unique (server_id, name)
);

create table if not exists public.speed_samples (
  id uuid primary key default gen_random_uuid(),
  house_id uuid not null references public.houses(id) on delete cascade,
  down_mbps numeric not null,
  up_mbps numeric not null,
  recorded_at timestamptz not null default now()
);

create index if not exists speed_samples_house_recorded_idx on public.speed_samples(house_id, recorded_at desc);

create table if not exists public.agent_jobs (
  id uuid primary key default gen_random_uuid(),
  house_id uuid not null references public.houses(id) on delete cascade,
  kind text not null check (kind in ('wake', 'health_all', 'health_one', 'pve_sync', 'speed_probe')),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'error')),
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agent_jobs_house_status_idx on public.agent_jobs(house_id, status, created_at);
