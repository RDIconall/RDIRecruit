import type { SupabaseClient } from "@supabase/supabase-js";

/** scores.model_version of a reviewer's corrected total (see submitReadAdjustment). */
export const REVIEWER_OVERRIDE_MODEL = "reviewer-override";

export interface ScoreMarker {
  id: string;
  model_version: string | null;
  created_at: string | null;
}

/** Every score row for one candidate, newest first. Throws so callers fail closed. */
export async function loadScoreMarkers(
  supabase: SupabaseClient,
  candidateId: string,
): Promise<ScoreMarker[]> {
  const { data, error } = await supabase
    .from("scores")
    .select("id, model_version, created_at")
    .eq("candidate_id", candidateId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Failed to read scores for ${candidateId}: ${error.message}`);
  return (data ?? []) as ScoreMarker[];
}

/** A candidate is pinned while a reviewer-override row is their latest score. */
export function isReviewerPinned(markers: ScoreMarker[]): boolean {
  return markers[0]?.model_version === REVIEWER_OVERRIDE_MODEL;
}

/**
 * Candidates holding a reviewer-override score row. Automated passes use this to
 * skip pinned files up front; scoreCandidate re-checks the latest row itself.
 */
export async function loadReviewerPinnedIds(supabase: SupabaseClient): Promise<Set<string>> {
  const PAGE = 1000;
  const ids = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("scores")
      .select("candidate_id")
      .eq("model_version", REVIEWER_OVERRIDE_MODEL)
      .order("candidate_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Failed to read reviewer pins: ${error.message}`);
    const rows = data ?? [];
    for (const row of rows) ids.add(row.candidate_id as string);
    if (rows.length < PAGE) break;
  }
  return ids;
}
