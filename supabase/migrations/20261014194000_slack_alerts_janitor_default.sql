-- Default Slack channel for ops alerts / deploy notices.

alter table public.houses
  alter column slack_channel set default '#alerts-janitor';

update public.houses
  set slack_channel = '#alerts-janitor',
      updated_at = now()
  where slack_channel = '#homelab';
