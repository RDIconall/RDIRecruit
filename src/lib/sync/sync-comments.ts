import { hasSupabase } from "../env";
import { getServiceSupabase } from "../supabase/server";
import { listCandidateActivities, type WorkableActivity } from "../workable/client";
import { COMMENT_EVIDENCE_TYPE } from "./candidate-hash";

// Only true reviewer evidence — comments, notes, ratings — should become evidence
// rows. Stage moves, disqualifications, etc. are pipeline noise.
const EVIDENCE_ACTIONS = new Set(["comment", "note", "rating"]);

/**
 * The human-authored text of an activity. ONLY a real comment/note body counts —
 * we never fall back to `activity.action` (which would store junk like "moved" as
 * a transcript). Returns "" when there is no real body, so the caller skips it.
 */
function activityBody(activity: WorkableActivity): string {
  const body = activity.comment?.body ?? activity.body ?? "";
  return typeof body === "string" ? body : JSON.stringify(body);
}

export async function syncWorkableComments(candidateId: string): Promise<number> {
  if (!hasSupabase()) return 0;

  let activities: WorkableActivity[];
  try {
    // No server-side `actions` filter (the action enum isn't reliably documented);
    // we filter client-side on the `action` we actually receive instead.
    activities = await listCandidateActivities(candidateId, { limit: 50 });
  } catch (error) {
    console.error(`Comment sync failed for ${candidateId}`, error);
    return 0;
  }

  const supabase = getServiceSupabase();
  let inserted = 0;

  for (const activity of activities) {
    const rawRef = activity.id;
    if (!rawRef) continue;
    // Skip anything that isn't reviewer evidence (stage moves, disqualifies, …).
    if (!EVIDENCE_ACTIONS.has((activity.action ?? "").toLowerCase())) continue;

    const { data: existing } = await supabase
      .from("evidence")
      .select("id")
      .eq("candidate_id", candidateId)
      .eq("raw_ref", rawRef)
      .maybeSingle();

    if (existing?.id) continue;

    const body = activityBody(activity);
    if (!body.trim()) continue;

    const { error } = await supabase.from("evidence").insert({
      candidate_id: candidateId,
      source_type: COMMENT_EVIDENCE_TYPE,
      author: activity.member?.name ?? activity.actor?.name ?? "recruiter",
      raw_ref: rawRef,
      transcript: body,
      extracted: activity as unknown as Record<string, unknown>,
      captured_at: activity.created_at ?? new Date().toISOString(),
    });

    if (!error) inserted += 1;
  }

  if (inserted) {
    await supabase
      .from("candidates")
      .update({ comments_synced_at: new Date().toISOString() })
      .eq("workable_id", candidateId);
  }

  return inserted;
}
