-- Invite-only signup via before-user-created Auth Hook.
-- Enable in Dashboard: Authentication → Hooks → Before User Created
-- → Postgres → public.hook_invite_only_signup

create or replace function public.signup_status()
returns jsonb
language sql
stable
security definer
set search_path = public, auth
as $$
  select jsonb_build_object(
    'inviteOnly', true,
    'bootstrapAllowed', not exists (select 1 from auth.users limit 1)
  );
$$;

revoke all on function public.signup_status() from public;
grant execute on function public.signup_status() to anon, authenticated;

create or replace function public.hook_invite_only_signup(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  signup_email text := lower(trim(coalesce(event->'user'->>'email', '')));
  user_count int;
  invited boolean;
begin
  if signup_email = '' then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'message', '이메일 가입만 허용됩니다.',
        'http_code', 400
      )
    );
  end if;

  select count(*)::int into user_count from auth.users;
  if user_count = 0 then
    return '{}'::jsonb;
  end if;

  select exists (
    select 1 from public.house_invites i where lower(i.email) = signup_email
  ) into invited;

  if invited then
    return '{}'::jsonb;
  end if;

  return jsonb_build_object(
    'error', jsonb_build_object(
      'message', '초대받은 이메일만 가입할 수 있습니다. 집 관리자에게 초대를 요청하세요.',
      'http_code', 403
    )
  );
end;
$$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.hook_invite_only_signup(jsonb) to supabase_auth_admin;
grant select on table public.house_invites to supabase_auth_admin;
revoke execute on function public.hook_invite_only_signup(jsonb) from authenticated, anon, public;

drop policy if exists invites_auth_admin_select on public.house_invites;
create policy invites_auth_admin_select on public.house_invites
  for select to supabase_auth_admin
  using (true);
