import { hasSupabase } from "../env";
import { getServiceSupabase } from "../supabase/server";
import { listCandidateActivities, type WorkableActivity } from "../workable/client";
import { COMMENT_EVIDENCE_TYPE } from "./candidate-hash";

function activityBody(activity: WorkableActivity): string {
  const body = activity.body ?? activity.comment?.body ?? activity.action ?? "";
  return typeof body === "string" ? body : JSON.stringify(body);
}

export async function syncWorkableComments(candidateId: string): Promise<number> {
  if (!hasSupabase()) return 0;

  let activities: WorkableActivity[];
  try {
    activities = await listCandidateActivities(candidateId, {
      limit: 50,
      actions: "comment,note,rating",
    });
  } catch (error) {
    console.error(`Comment sync failed for ${candidateId}`, error);
    return 0;
  }

  const supabase = getServiceSupabase();
  let inserted = 0;

  for (const activity of activities) {
    const rawRef = activity.id;
    if (!rawRef) continue;

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
