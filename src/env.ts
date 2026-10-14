export interface Env {
  ASSETS: Fetcher;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  /** Required for /api/agent/poll and /api/agent/report after SEC-10 lockdown. */
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SLACK_WEBHOOK_URL?: string;
}
