import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { env, hasSupabase } from "../env";

/**
 * Per-request timeout for every Supabase HTTP call. Without one, an
 * unreachable Supabase project (Cloudflare 522s while paused/unhealthy) leaves
 * fetches hanging until Vercel kills the whole function at its 300s cap — the
 * user sees a bare 504 GATEWAY_TIMEOUT instead of a fast, explainable failure.
 */
const SUPABASE_REQUEST_TIMEOUT_MS = 30_000;

const fetchWithTimeout: typeof fetch = (input, init) => {
  const timeout = AbortSignal.timeout(SUPABASE_REQUEST_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(input, { ...init, signal });
};

let serviceClient: SupabaseClient | null = null;

export function getServiceSupabase(): SupabaseClient {
  if (!hasSupabase()) {
    throw new Error("Supabase is not configured");
  }
  if (!serviceClient) {
    serviceClient = createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: fetchWithTimeout },
    });
  }
  return serviceClient;
}

export function getAnonSupabase(): SupabaseClient {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    throw new Error("Supabase anon client is not configured");
  }
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: { fetch: fetchWithTimeout },
  });
}
