import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { env, hasSupabase } from "../env";

let serviceClient: SupabaseClient | null = null;

export function getServiceSupabase(): SupabaseClient {
  if (!hasSupabase()) {
    throw new Error("Supabase is not configured");
  }
  if (!serviceClient) {
    serviceClient = createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return serviceClient;
}

export function getAnonSupabase(): SupabaseClient {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    throw new Error("Supabase anon client is not configured");
  }
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
}
