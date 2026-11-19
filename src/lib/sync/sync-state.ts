import { createHmac, timingSafeEqual } from "node:crypto";
import { env, hasSupabase } from "../env";
import { getServiceSupabase } from "../supabase/server";

export type SyncStateKey =
  | "last_incremental"
  | "last_daily"
  | "last_delta_scan"
  // Dynamic keys (e.g. `scoring_epoch:<scope>`) — kept open while preserving autocomplete.
  | (string & {});

export async function readSyncState<T extends Record<string, unknown>>(
  key: SyncStateKey,
  fallback: T,
): Promise<T> {
  if (!hasSupabase()) return fallback;
  const supabase = getServiceSupabase();
  const { data } = await supabase.from("sync_state").select("value").eq("key", key).maybeSingle();
  if (!data?.value || typeof data.value !== "object") return fallback;
  return { ...fallback, ...(data.value as T) };
}

export async function writeSyncState(key: SyncStateKey, value: Record<string, unknown>) {
  if (!hasSupabase()) return;
  const supabase = getServiceSupabase();
  await supabase.from("sync_state").upsert({
    key,
    value,
    updated_at: new Date().toISOString(),
  });
}

// Timestamps that steer the reconcile (the delta-scan cursor and scoring epochs)
// are signed with a key derived from the service role key. A row this code did
// not write — or one copied from another key — fails verification and is
// treated as absent, so it can never narrow a scan or force a re-score.
const MAX_CLOCK_SKEW_MS = 60_000;

function signingKey(): Buffer | null {
  if (!env.SUPABASE_SERVICE_KEY) return null;
  return createHmac("sha256", env.SUPABASE_SERVICE_KEY).update("rdirecruit:sync_state:v1").digest();
}

function signTimestamp(key: string, at: string): string | null {
  const secret = signingKey();
  if (!secret) return null;
  return createHmac("sha256", secret).update(`${key}\n${at}`).digest("base64url");
}

/** Returns `at` only if this app signed it for `key` and it is not in the future. */
export function verifySignedTimestamp(key: string, value: unknown, now = Date.now()): string | null {
  if (!value || typeof value !== "object") return null;
  const { at, sig } = value as { at?: unknown; sig?: unknown };
  if (typeof at !== "string" || typeof sig !== "string") return null;
  const atMs = Date.parse(at);
  if (Number.isNaN(atMs) || atMs > now + MAX_CLOCK_SKEW_MS) return null;
  const expected = signTimestamp(key, at);
  if (!expected) return null;
  const given = Buffer.from(sig);
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;
  return at;
}

export async function readSignedTimestamp(key: SyncStateKey): Promise<string | null> {
  if (!hasSupabase()) return null;
  const supabase = getServiceSupabase();
  const { data } = await supabase.from("sync_state").select("value").eq("key", key).maybeSingle();
  return verifySignedTimestamp(key, data?.value);
}

export async function writeSignedTimestamp(key: SyncStateKey, at = new Date().toISOString()) {
  const sig = signTimestamp(key, at);
  if (!sig) return;
  await writeSyncState(key, { at, sig });
}
