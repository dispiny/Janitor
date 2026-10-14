-- Admin-provisioned Auth users only: no client signUp.
-- Before User Created hook (same name as before) allows:
--   1) first user ever (empty auth.users) so Dashboard can create the owner
--   2) emails on auth_provision_allowlist (filled by house invite)
-- Everything else is rejected. Also disable "Allow new users to sign up"
-- in Dashboard → Authentication → Providers → Email.

create table if not exists public.auth_provision_allowlist (
  email text primary key,
  invited_by uuid references auth.users(id) on delete set null,
  house_id uuid references public.houses(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.auth_provision_allowlist enable row level security;

drop policy if exists provision_select on public.auth_provision_allowlist;
create policy provision_select on public.auth_provision_allowlist
  for select to authenticated
  using (
    public.is_house_member(house_id)
    or lower(email) = lower(coalesce(auth.jwt()->>'email', ''))
  );

-- No direct client writes; invite RPC only.
revoke all on table public.auth_provision_allowlist from anon, authenticated;
grant select on table public.auth_provision_allowlist to authenticated;
grant all on table public.auth_provision_allowlist to service_role;
grant select on table public.auth_provision_allowlist to supabase_auth_admin;

drop policy if exists provision_auth_admin_select on public.auth_provision_allowlist;
create policy provision_auth_admin_select on public.auth_provision_allowlist
  for select to supabase_auth_admin
  using (true);

create or replace function public.invite_house_member(p_house_id uuid, p_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  mail text := lower(trim(coalesce(p_email, '')));
begin
  if uid is null then
    raise exception 'unauthorized';
  end if;
  if p_house_id is null or mail = '' or position('@' in mail) = 0 then
    raise exception '이메일이 필요합니다.';
  end if;
  -- Prefer owner when helper exists (security lockdown); else any member.
  if to_regprocedure('public.is_house_owner(uuid)') is not null then
    if not public.is_house_owner(p_house_id) then
      raise exception 'owner만 초대할 수 있습니다.';
    end if;
  elsif not public.is_house_member(p_house_id) then
    raise exception 'forbidden';
  end if;

  insert into public.house_invites (house_id, email, invited_by)
  values (p_house_id, mail, uid)
  on conflict (house_id, email) do update
    set invited_by = excluded.invited_by;

  insert into public.auth_provision_allowlist (email, invited_by, house_id)
  values (mail, uid, p_house_id)
  on conflict (email) do update
    set invited_by = excluded.invited_by,
        house_id = excluded.house_id;
end;
$$;

revoke all on function public.invite_house_member(uuid, text) from public, anon;
grant execute on function public.invite_house_member(uuid, text) to authenticated;

-- Keep function name so existing Dashboard hook wiring still works.
create or replace function public.hook_invite_only_signup(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  signup_email text := lower(trim(coalesce(event->'user'->>'email', '')));
  user_count int;
  allowed boolean;
begin
  if signup_email = '' then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'message', '이메일 계정이 필요합니다.',
        'http_code', 400
      )
    );
  end if;

  select count(*)::int into user_count from auth.users;
  if user_count = 0 then
    -- First Auth user may be created in the Supabase Dashboard.
    return '{}'::jsonb;
  end if;

  select exists (
    select 1 from public.auth_provision_allowlist a
    where lower(a.email) = signup_email
  ) into allowed;

  if allowed then
    -- Still intended for Dashboard / Admin createUser only.
    -- Turn off "Allow new users to sign up" so clients cannot signUp().
    return '{}'::jsonb;
  end if;

  return jsonb_build_object(
    'error', jsonb_build_object(
      'message', '회원가입이 비활성입니다. Supabase Authentication에서 관리자가 사용자를 만든 뒤 로그인하세요.',
      'http_code', 403
    )
  );
end;
$$;

grant execute on function public.hook_invite_only_signup(jsonb) to supabase_auth_admin;
revoke execute on function public.hook_invite_only_signup(jsonb) from authenticated, anon, public;

create or replace function public.signup_status()
returns jsonb
language sql
stable
security definer
set search_path = public, auth
as $$
  select jsonb_build_object(
    'inviteOnly', true,
    'adminProvisionedOnly', true,
    'signupEnabled', false,
    'bootstrapAllowed', false,
    'hookReady', (
      case
        when to_regprocedure('public.hook_invite_only_signup(jsonb)') is null then false
        else has_function_privilege(
          'supabase_auth_admin',
          'public.hook_invite_only_signup(jsonb)',
          'execute'
        )
      end
    )
  );
$$;

revoke all on function public.signup_status() from public;
grant execute on function public.signup_status() to anon, authenticated;

-- Carry forward any pending house invites into the Auth allowlist.
insert into public.auth_provision_allowlist (email, invited_by, house_id)
select lower(email), invited_by, house_id
from public.house_invites
on conflict (email) do nothing;
