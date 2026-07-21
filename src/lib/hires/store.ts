import "server-only";
import { hasSupabase } from "@/lib/env";
import { getServiceSupabase } from "@/lib/supabase/server";

export interface HireInboxRow {
  candidate_id: string;
  job_shortcode: string;
  hired_at: string;
  read: boolean;
  read_at: string | null;
  read_by: string | null;
  updated_at: string;
}

/**
 * Upsert a hire into the inbox. Re-hiring the same candidate refreshes
 * hired_at and resets to unread (they need another look).
 */
export async function upsertHireInbox(input: {
  candidateId: string;
  jobShortcode: string;
  hiredAt?: string;
}): Promise<void> {
  if (!hasSupabase()) return;
  const supabase = getServiceSupabase();
  const hiredAt = input.hiredAt ?? new Date().toISOString();
  const { error } = await supabase.from("hire_inbox").upsert(
    {
      candidate_id: input.candidateId,
      job_shortcode: input.jobShortcode,
      hired_at: hiredAt,
      read: false,
      read_at: null,
      read_by: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "candidate_id" },
  );
  if (error) console.error("upsertHireInbox", error.message);
}

/** Remove from inbox when process status leaves Hired. */
export async function removeHireInbox(candidateId: string): Promise<void> {
  if (!hasSupabase()) return;
  const supabase = getServiceSupabase();
  const { error } = await supabase.from("hire_inbox").delete().eq("candidate_id", candidateId);
  if (error) console.error("removeHireInbox", error.message);
}

export async function markHireRead(input: {
  candidateIds: string[];
  read: boolean;
  readBy?: string | null;
}): Promise<void> {
  if (!hasSupabase() || input.candidateIds.length === 0) return;
  const supabase = getServiceSupabase();
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("hire_inbox")
    .update({
      read: input.read,
      read_at: input.read ? now : null,
      read_by: input.read ? (input.readBy ?? null) : null,
      updated_at: now,
    })
    .in("candidate_id", input.candidateIds);
  if (error) console.error("markHireRead", error.message);
}

export async function markAllHiresRead(readBy?: string | null): Promise<number> {
  if (!hasSupabase()) return 0;
  const supabase = getServiceSupabase();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("hire_inbox")
    .update({
      read: true,
      read_at: now,
      read_by: readBy ?? null,
      updated_at: now,
    })
    .eq("read", false)
    .select("candidate_id");
  if (error) {
    console.error("markAllHiresRead", error.message);
    return 0;
  }
  return data?.length ?? 0;
}

export async function listHireInboxRows(): Promise<HireInboxRow[]> {
  if (!hasSupabase()) return [];
  const supabase = getServiceSupabase();
  const { data, error } = await supabase
    .from("hire_inbox")
    .select("candidate_id, job_shortcode, hired_at, read, read_at, read_by, updated_at")
    .order("hired_at", { ascending: false });
  if (error) {
    // Table may not exist yet in an environment that hasn't migrated.
    console.error("listHireInboxRows", error.message);
    return [];
  }
  return (data ?? []) as HireInboxRow[];
}

/**
 * Ensure every candidate whose working-file workspace says Hired has an inbox
 * row, and drop stale rows whose process status is no longer Hired.
 * Preserves existing read state for known rows.
 */
export async function reconcileHireInbox(): Promise<void> {
  if (!hasSupabase()) return;
  const supabase = getServiceSupabase();

  const { data: hiredFiles, error: wfErr } = await supabase
    .from("candidate_working_files")
    .select("candidate_id, workspace, updated_at")
    .filter("workspace->>processStatus", "eq", "hired");

  if (wfErr) {
    console.error("reconcileHireInbox working_files", wfErr.message);
    return;
  }

  const hiredIds = new Set((hiredFiles ?? []).map((r) => r.candidate_id as string));

  if (hiredIds.size > 0) {
    const ids = [...hiredIds];
    const { data: candidates } = await supabase
      .from("candidates")
      .select("workable_id, job_shortcode")
      .in("workable_id", ids);

    const jobById = new Map(
      (candidates ?? []).map((c) => [c.workable_id as string, c.job_shortcode as string]),
    );

    const { data: existing } = await supabase
      .from("hire_inbox")
      .select("candidate_id")
      .in("candidate_id", ids);
    const already = new Set((existing ?? []).map((r) => r.candidate_id as string));

    const toInsert = ids
      .filter((id) => !already.has(id) && jobById.get(id))
      .map((id) => {
        const wf = (hiredFiles ?? []).find((r) => r.candidate_id === id);
        return {
          candidate_id: id,
          job_shortcode: jobById.get(id)!,
          hired_at: (wf?.updated_at as string | undefined) ?? new Date().toISOString(),
          read: false,
          read_at: null,
          read_by: null,
          updated_at: new Date().toISOString(),
        };
      });

    if (toInsert.length > 0) {
      const { error } = await supabase.from("hire_inbox").upsert(toInsert, {
        onConflict: "candidate_id",
        ignoreDuplicates: true,
      });
      if (error) console.error("reconcileHireInbox insert", error.message);
    }
  }

  // Drop inbox rows that are no longer Hired.
  const { data: inboxRows } = await supabase.from("hire_inbox").select("candidate_id");
  const stale = (inboxRows ?? [])
    .map((r) => r.candidate_id as string)
    .filter((id) => !hiredIds.has(id));
  if (stale.length > 0) {
    const { error } = await supabase.from("hire_inbox").delete().in("candidate_id", stale);
    if (error) console.error("reconcileHireInbox delete", error.message);
  }
}
