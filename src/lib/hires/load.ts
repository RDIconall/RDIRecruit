import "server-only";
import { hasSupabase } from "@/lib/env";
import { getServiceSupabase } from "@/lib/supabase/server";
import { listHireInboxRows, reconcileHireInbox } from "./store";
import type { HireInboxItem, HireInboxSummary } from "./types";

function workableCandidateUrl(id: string): string {
  return `https://rditrials.workable.com/backend/candidates/${id}`;
}

/**
 * Load the cross-job New Hires inbox. Reconciles from working-file process
 * status first so existing Hires appear even before the next status write.
 */
export async function loadHireInbox(): Promise<HireInboxSummary> {
  const empty: HireInboxSummary = {
    total: 0,
    unread: 0,
    unreadByJob: [],
    items: [],
    configured: hasSupabase(),
  };
  if (!hasSupabase()) return empty;

  try {
    await reconcileHireInbox();
  } catch (err) {
    console.error("loadHireInbox reconcile", err);
  }

  const rows = await listHireInboxRows();
  if (rows.length === 0) return empty;

  const supabase = getServiceSupabase();
  const candidateIds = rows.map((r) => r.candidate_id);
  const jobCodes = [...new Set(rows.map((r) => r.job_shortcode))];

  const [{ data: candidates }, { data: jobs }, { data: apps }] = await Promise.all([
    supabase
      .from("candidates")
      .select("workable_id, name, email, job_shortcode")
      .in("workable_id", candidateIds),
    supabase.from("jobs").select("shortcode, title").in("shortcode", jobCodes),
    supabase
      .from("applications")
      .select("candidate_id, parsed_experience")
      .in("candidate_id", candidateIds),
  ]);

  const candById = new Map(
    (candidates ?? []).map((c) => [c.workable_id as string, c]),
  );
  const jobTitle = new Map(
    (jobs ?? []).map((j) => [j.shortcode as string, (j.title as string) || j.shortcode]),
  );
  const expById = new Map(
    (apps ?? []).map((a) => [a.candidate_id as string, a.parsed_experience]),
  );

  function currentFromExp(exp: unknown): { title: string; company: string } {
    if (!Array.isArray(exp) || exp.length === 0) return { title: "", company: "" };
    const first = exp[0] as { title?: string; company?: string; role?: string };
    return {
      title: first.title || first.role || "",
      company: first.company || "",
    };
  }

  const items: HireInboxItem[] = rows.map((r) => {
    const c = candById.get(r.candidate_id);
    const { title, company } = currentFromExp(expById.get(r.candidate_id));
    const shortcode = r.job_shortcode;
    return {
      candidateId: r.candidate_id,
      name: (c?.name as string) || "Unknown",
      email: (c?.email as string | null) ?? null,
      jobTitle: jobTitle.get(shortcode) || shortcode,
      jobShortcode: shortcode,
      currentTitle: title,
      company,
      hiredAt: r.hired_at,
      read: r.read,
      readAt: r.read_at,
      readBy: r.read_by,
      workableUrl: workableCandidateUrl(r.candidate_id),
      triageUrl: `/?job=${encodeURIComponent(shortcode)}&c=${encodeURIComponent(r.candidate_id)}`,
    };
  });

  // Unread first, then newest hired.
  items.sort((a, b) => {
    if (a.read !== b.read) return a.read ? 1 : -1;
    return Date.parse(b.hiredAt) - Date.parse(a.hiredAt);
  });

  const unreadItems = items.filter((i) => !i.read);
  const byJob = new Map<string, { shortcode: string; title: string; count: number }>();
  for (const i of unreadItems) {
    const cur = byJob.get(i.jobShortcode);
    if (cur) cur.count += 1;
    else byJob.set(i.jobShortcode, { shortcode: i.jobShortcode, title: i.jobTitle, count: 1 });
  }

  return {
    total: items.length,
    unread: unreadItems.length,
    unreadByJob: [...byJob.values()].sort((a, b) => b.count - a.count),
    items,
    configured: true,
  };
}

export async function getUnreadHireCount(): Promise<number> {
  if (!hasSupabase()) return 0;
  const supabase = getServiceSupabase();
  const { count, error } = await supabase
    .from("hire_inbox")
    .select("*", { count: "exact", head: true })
    .eq("read", false);
  if (error) return 0;
  return count ?? 0;
}
