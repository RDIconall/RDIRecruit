import { hasSupabase, hasWorkable } from "../env";
import { getServiceSupabase } from "../supabase/server";

export interface ResumeBackfillResult {
  attempted: number;
  ingested: number;
  failed: number;
  remaining: number;
  errors: string[];
}

/**
 * Re-ingest résumés for every candidate that has a Workable résumé on file but no
 * stored/parsed copy yet (`applications.resume_storage_path is null`). This drains
 * the backlog left by the pdf-parse v1→v2 break that silently failed every PDF.
 *
 * Pulls a fresh candidate from Workable for each one (the stored `resume_url` is a
 * signed URL that may have expired) and forces a fresh ingest. Time-budgeted so the
 * cron never exceeds its maxDuration; returns how many still remain for the next pass.
 */
export async function backfillMissingResumes(options?: {
  budgetMs?: number;
  limit?: number;
}): Promise<ResumeBackfillResult> {
  const result: ResumeBackfillResult = {
    attempted: 0,
    ingested: 0,
    failed: 0,
    remaining: 0,
    errors: [],
  };

  if (!hasSupabase() || !hasWorkable()) return result;

  const budgetMs = options?.budgetMs ?? 240_000;
  const supabase = getServiceSupabase();

  // Candidates whose application has a résumé URL but no stored/parsed copy.
  const { data: apps, error } = await supabase
    .from("applications")
    .select("candidate_id, resume_url, resume_storage_path")
    .is("resume_storage_path", null)
    .not("resume_url", "is", null);

  if (error) {
    result.errors.push(`query failed: ${error.message}`);
    return result;
  }

  const candidateIds = (apps ?? [])
    .filter((a) => (a.resume_url as string | null)?.trim())
    .map((a) => a.candidate_id as string);

  if (!candidateIds.length) return result;

  // Resolve each candidate's job shortcode (needed for the Workable fetch).
  const { data: candidates } = await supabase
    .from("candidates")
    .select("workable_id, job_shortcode, name")
    .in("workable_id", candidateIds);

  const jobByCandidate = new Map<string, string | null>();
  for (const c of candidates ?? []) {
    jobByCandidate.set(c.workable_id as string, (c.job_shortcode as string | null) ?? null);
  }

  const queue = candidateIds.slice(0, options?.limit ?? candidateIds.length);

  const { getCandidate } = await import("../workable/client");
  const { upsertCandidateFromWorkable } = await import("../sync/workable-sync");

  const start = Date.now();
  let processed = 0;

  for (const candidateId of queue) {
    if (Date.now() - start > budgetMs) break;
    processed += 1;

    const shortcode = jobByCandidate.get(candidateId);
    if (!shortcode) {
      result.failed += 1;
      if (result.errors.length < 10) result.errors.push(`${candidateId}: no job shortcode`);
      continue;
    }

    result.attempted += 1;
    try {
      const candidate = await getCandidate(shortcode, candidateId);
      const upsert = await upsertCandidateFromWorkable(candidate, shortcode, {
        analyze: true,
        forceAnalyze: true,
        syncComments: false,
      });
      if (upsert.applicationIngested) {
        result.ingested += 1;
      } else if (upsert.resumeError) {
        result.failed += 1;
        if (result.errors.length < 10) result.errors.push(`${candidateId}: ${upsert.resumeError}`);
      }
    } catch (err) {
      result.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      if (result.errors.length < 10) result.errors.push(`${candidateId}: ${message}`);
      console.error(`Resume backfill failed for ${candidateId}`, err);
    }
  }

  result.remaining = Math.max(0, candidateIds.length - processed);
  return result;
}
