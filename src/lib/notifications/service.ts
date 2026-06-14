import { hasSupabase } from "../env";
import { getServiceSupabase } from "../supabase/server";
import { tierKeyFromTotal } from "../board/format";

export async function notifyStrongFit(input: {
  candidateId: string;
  candidateName: string;
  total: number;
  jobShortcode: string;
}) {
  if (!hasSupabase() || tierKeyFromTotal(input.total) !== "strong") return;

  const supabase = getServiceSupabase();
  const { data: existing } = await supabase
    .from("notifications")
    .select("id")
    .eq("candidate_id", input.candidateId)
    .eq("type", "strong_fit")
    .gte("created_at", new Date(Date.now() - 7 * 86400000).toISOString())
    .limit(1);

  if (existing?.length) return;

  await supabase.from("notifications").insert({
    user_id: null,
    type: "strong_fit",
    candidate_id: input.candidateId,
    channel: "in_app",
    payload: {
      text: `${input.candidateName} crossed Strong threshold (${input.total}) · ${input.jobShortcode}`,
      total: input.total,
      jobShortcode: input.jobShortcode,
    },
    read: false,
  });
}

export async function getUnreadNotificationCount(): Promise<number> {
  if (!hasSupabase()) return 0;
  const supabase = getServiceSupabase();
  const { count } = await supabase
    .from("notifications")
    .select("*", { count: "exact", head: true })
    .eq("read", false);
  return count ?? 0;
}

export async function listNotifications(limit = 50) {
  if (!hasSupabase()) return [];
  const supabase = getServiceSupabase();
  const { data } = await supabase
    .from("notifications")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  return data ?? [];
}

export async function markNotificationsRead(ids?: string[]) {
  if (!hasSupabase()) return;
  const supabase = getServiceSupabase();
  if (ids?.length) {
    await supabase.from("notifications").update({ read: true }).in("id", ids);
  } else {
    await supabase.from("notifications").update({ read: true }).eq("read", false);
  }
}
