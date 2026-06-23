import { hasSupabase } from "../env";
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

