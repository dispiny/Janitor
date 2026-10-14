-- WOL: drop the unimplemented U+ router mode; MAC registration (magic packet) only.
-- Deploy the Worker first: older Workers still write wol_uplus_device on insert.

update public.servers
set wol_mode = case when wol_mac is not null and wol_mac <> '' then 'manual' else 'off' end,
    updated_at = now()
where wol_mode = 'uplus';

alter table public.servers drop constraint if exists servers_wol_mode_check;
alter table public.servers
  add constraint servers_wol_mode_check check (wol_mode in ('off', 'manual'));

alter table public.servers drop column if exists wol_uplus_device;

-- Empty broadcast means "agent default" (255.255.255.255); keep stored values as entered.
update public.servers set wol_broadcast = null where wol_broadcast = '';
