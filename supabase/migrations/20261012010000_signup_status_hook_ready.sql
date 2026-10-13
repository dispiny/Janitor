-- Keep signup_status in sync with remote (hookReady signal).
-- Idempotent with 20261012003000_invite_only_signup.sql body.

create or replace function public.signup_status()
returns jsonb
language sql
stable
security definer
set search_path = public, auth
as $$
  select jsonb_build_object(
    'inviteOnly', true,
    'bootstrapAllowed', not exists (select 1 from auth.users limit 1),
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
