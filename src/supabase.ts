import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "./env";

export function userClient(env: Env, accessToken: string): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function anonClient(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Service-role client for agent RPCs (bypasses RLS; never expose to browser). */
export function serviceClient(env: Env): SupabaseClient | null {
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key) return null;
  return createClient(env.SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
