import { hasSupabase } from "../env";
import { getServiceSupabase } from "../supabase/server";
import { isSafeWorkableId } from "../workable/client";

/**
 * The job a stored candidate belongs to, read from our own `candidates` row.
 * Server actions act on this value rather than a job code sent by the client,
 * so a caller cannot point a Workable read at a job or path of their choosing.
 * Returns null for a candidate we have not stored.
 */
export async function storedJobShortcodeFor(candidateId: string): Promise<string | null> {
  if (!hasSupabase() || !isSafeWorkableId(candidateId)) return null;
  const supabase = getServiceSupabase();
  const { data } = await supabase
    .from("candidates")
    .select("job_shortcode")
    .eq("workable_id", candidateId)
    .maybeSingle();
  const shortcode = (data?.job_shortcode as string | null) ?? null;
  return isSafeWorkableId(shortcode) ? shortcode : null;
}
