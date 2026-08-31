import { hasSupabase, hasWorkable } from "../env";
import { getServiceSupabase } from "../supabase/server";
import {
  isPermanentWorkableNotFound,
  tombstoneMissingWorkableCandidate,
} from "../sync/failures";

export interface ResumeBackfillResult {
  attempted: number;
  ingested: number;
  retired: number;
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
    retired: 0,
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
      const message = err instanceof Error ? err.message : String(err);
      if (isPermanentWorkableNotFound(err)) {
        await tombstoneMissingWorkableCandidate(candidateId, "resume backfill (Workable 404)");
        result.retired += 1;
      } else {
        result.failed += 1;
        if (result.errors.length < 10) result.errors.push(`${candidateId}: ${message}`);
        console.error(`Resume backfill failed for ${candidateId}`, err);
      }
    }
  }

  result.remaining = Math.max(0, candidateIds.length - processed);
  return result;
}

export interface AnswersRecaptureResult {
  attempted: number;
  rehydrated: number;
  rescored: number;
  stillEmpty: number;
  failed: number;
  remaining: number;
  errors: string[];
}

/**
 * Recapture screening answers the bulk mirror wiped. The LIST endpoint omits
 * `answers`, and until the clobber guard the mirror overwrote stored answers
 * with `{}` on every metadata change. For each ACTIVE candidate whose stored
 * answers are empty: pull the authoritative single candidate (carries answers),
 * re-upsert, and — when answers actually came back — re-score with replace so
 * the answer grades regenerate. Sequential per candidate (Workable rate limit +
 * no concurrent-eval races); time-budgeted; returns `remaining` for looping.
 */
export async function recaptureMissingAnswers(options?: {
  budgetMs?: number;
  limit?: number;
}): Promise<AnswersRecaptureResult> {
  const result: AnswersRecaptureResult = {
    attempted: 0,
    rehydrated: 0,
    rescored: 0,
    stillEmpty: 0,
    failed: 0,
    remaining: 0,
    errors: [],
  };
  if (!hasSupabase() || !hasWorkable()) return result;

  const supabase = getServiceSupabase();

  // Active candidates (not Workable- or overlay-disqualified) whose stored answers are empty.
  const [{ data: candidates }, { data: apps }, { data: overlays }] = await Promise.all([
    supabase.from("candidates").select("workable_id, job_shortcode, disqualified"),
    supabase.from("applications").select("candidate_id, answers"),
    supabase.from("candidate_overlay").select("candidate_id, status"),
  ]);
  const disqualified = new Set(
    (overlays ?? []).filter((o) => o.status === "disqualified").map((o) => o.candidate_id as string),
  );
  const emptyAnswers = new Set(
    (apps ?? [])
      .filter((a) => {
        const v = a.answers as Record<string, unknown> | null;
        return !v || Object.keys(v).length === 0;
      })
      .map((a) => a.candidate_id as string),
  );
  const queue = (candidates ?? [])
    .filter(
      (c) =>
        !(c.disqualified as boolean | null) &&
        !disqualified.has(c.workable_id as string) &&
        emptyAnswers.has(c.workable_id as string) &&
        c.job_shortcode,
    )
    .map((c) => ({ id: c.workable_id as string, shortcode: c.job_shortcode as string }))
    .slice(0, options?.limit ?? Infinity);

  if (!queue.length) return result;

  const { getCandidate } = await import("../workable/client");
  const { upsertCandidateFromWorkable } = await import("../sync/workable-sync");
  const { scoreCandidate } = await import("../scoring/run-score");

  const budgetMs = options?.budgetMs ?? 240_000;
  const start = Date.now();
  let processed = 0;

  for (const entry of queue) {
    if (Date.now() - start > budgetMs) break;
    processed += 1;
    result.attempted += 1;
    try {
      const candidate = await getCandidate(entry.shortcode, entry.id);
      const hasAnswers = (candidate.answers ?? []).length > 0;
      if (!hasAnswers) {
        // Workable genuinely has no screening answers for this candidate.
        result.stillEmpty += 1;
        continue;
      }
      await upsertCandidateFromWorkable(candidate, entry.shortcode, {
        analyze: false,
        syncComments: false,
        hydrate: true,
      });
      result.rehydrated += 1;
      await scoreCandidate(entry.id, {
        replace: true,
        transport: "enqueue",
        trigger: "answers_backfill",
      });
      result.rescored += 1;
    } catch (err) {
      result.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      if (result.errors.length < 10) result.errors.push(`${entry.id}: ${message}`);
      console.error(`Answers recapture failed for ${entry.id}`, err);
    }
    // Respect Workable's ~10 req/s ceiling with margin.
    await new Promise((r) => setTimeout(r, 1100));
  }

  result.remaining = Math.max(0, queue.length - processed);
  if (result.rescored > 0) {
    const { processCanonicalAnalysisBatches } = await import("../analysis/batch");
    await processCanonicalAnalysisBatches();
  }
  return result;
}

export interface ResumeRecaptureDetail {
  candidateId: string;
  name: string;
  jobShortcode: string | null;
  /** Whether the AUTHORITATIVE Workable fetch (getCandidate) carried a résumé URL. */
  hasWorkableResume: boolean;
  ingested: boolean;
  /** True when the candidate 404'd in Workable and was retired out of the pool. */
  retired?: boolean;
  error?: string;
}

export interface ResumeRecaptureResult {
  attempted: number;
  withWorkableResume: number;
  withoutResume: number;
  ingested: number;
  /** Candidates retired because they no longer exist in Workable (404). */
  retired: number;
  failed: number;
  remaining: number;
  dryRun: boolean;
  details: ResumeRecaptureDetail[];
}

/**
 * Recapture résumés the bulk mirror dropped. Our mirror writes from the LIST
 * endpoint, which omits `resume_url`, so candidates ended up "Review blocked"
 * with a null URL in `applications` even when Workable HAS a résumé. This pulls
 * the AUTHORITATIVE single candidate (getCandidate → includes resume_url) and,
 * when one is present, force-re-ingests it (which also OCRs scanned PDFs).
 *
 * Two modes:
 *  - discovery (default): every candidate with a blocked working-file read and no
 *    stored résumé copy (resume_storage_path is null).
 *  - explicit `ids`: force-re-ingest the given candidates regardless of state
 *    (used to re-OCR a candidate whose résumé ingested to empty text, e.g. a scan).
 *
 * `dryRun` only inspects whether Workable returns a résumé URL (the sample
 * verification) without writing anything. Rate-limited (~1 req/1.1s) under the
 * Workable ceiling; time-budgeted; never throws.
 */
export async function recaptureBlockedResumes(options?: {
  budgetMs?: number;
  limit?: number;
  dryRun?: boolean;
  ids?: string[];
}): Promise<ResumeRecaptureResult> {
  const result: ResumeRecaptureResult = {
    attempted: 0,
    withWorkableResume: 0,
    withoutResume: 0,
    ingested: 0,
    retired: 0,
    failed: 0,
    remaining: 0,
    dryRun: Boolean(options?.dryRun),
    details: [],
  };

  if (!hasSupabase() || !hasWorkable()) return result;

  const supabase = getServiceSupabase();
  let candidateIds: string[];

  if (options?.ids?.length) {
    candidateIds = options.ids;
  } else {
    // Blocked working-file reads → candidates still waiting on a résumé.
    const { data: blockedRows, error: blockedErr } = await supabase
      .from("candidate_working_files")
      .select("candidate_id")
      .filter("read->>decision", "eq", "blocked");
    if (blockedErr) {
      result.details.push({ candidateId: "-", name: "-", jobShortcode: null, hasWorkableResume: false, ingested: false, error: `blocked query: ${blockedErr.message}` });
      return result;
    }
    const blockedIds = (blockedRows ?? []).map((r) => r.candidate_id as string);
    if (!blockedIds.length) return result;

    // Keep only those without a stored résumé copy yet (skips e.g. Aaron's case,
    // which has a stored file and is handled via explicit `ids`).
    const { data: apps } = await supabase
      .from("applications")
      .select("candidate_id, resume_storage_path")
      .in("candidate_id", blockedIds);
    const hasStored = new Set(
      (apps ?? []).filter((a) => (a.resume_storage_path as string | null)?.trim()).map((a) => a.candidate_id as string),
    );
    candidateIds = blockedIds.filter((id) => !hasStored.has(id));
  }

  if (!candidateIds.length) return result;

  const { data: candidates } = await supabase
    .from("candidates")
    .select("workable_id, job_shortcode, name")
    .in("workable_id", candidateIds);
  const metaById = new Map<string, { shortcode: string | null; name: string }>();
  for (const c of candidates ?? []) {
    metaById.set(c.workable_id as string, {
      shortcode: (c.job_shortcode as string | null) ?? null,
      name: (c.name as string | null) ?? "—",
    });
  }

  const budgetMs = options?.budgetMs ?? 240_000;
  const queue = candidateIds.slice(0, options?.limit ?? candidateIds.length);

  const { getCandidate } = await import("../workable/client");
  const { upsertCandidateFromWorkable } = await import("../sync/workable-sync");

  const start = Date.now();
  let processed = 0;

  for (const candidateId of queue) {
    if (Date.now() - start > budgetMs) break;
    processed += 1;
    const meta = metaById.get(candidateId) ?? { shortcode: null, name: "—" };
    const detail: ResumeRecaptureDetail = {
      candidateId,
      name: meta.name,
      jobShortcode: meta.shortcode,
      hasWorkableResume: false,
      ingested: false,
    };

    if (!meta.shortcode) {
      detail.error = "no job shortcode";
      result.failed += 1;
      result.details.push(detail);
      continue;
    }

    result.attempted += 1;
    try {
      const candidate = await getCandidate(meta.shortcode, candidateId);
      detail.hasWorkableResume = Boolean(candidate.resume_url);
      if (detail.hasWorkableResume) result.withWorkableResume += 1;
      else result.withoutResume += 1;

      if (!options?.dryRun && candidate.resume_url) {
        const upsert = await upsertCandidateFromWorkable(candidate, meta.shortcode, {
          analyze: true,
          forceAnalyze: true,
          syncComments: false,
        });
        if (upsert.applicationIngested) {
          detail.ingested = true;
          result.ingested += 1;
        } else if (upsert.resumeError) {
          detail.error = upsert.resumeError;
          result.failed += 1;
        }
      }
    } catch (err) {
      detail.error = err instanceof Error ? err.message : String(err);
      // A 404 means the candidate was deleted/merged in Workable. Re-pulling will
      // never succeed, and leaving the row stuck on "Review blocked" is the exact
      // zombie that prompted this. Retire it out of the active pool (unless dry-run).
      if (isPermanentWorkableNotFound(err)) {
        if (!options?.dryRun) {
          try {
            await tombstoneMissingWorkableCandidate(candidateId, "recapture (Workable 404)");
            detail.retired = true;
            result.retired += 1;
          } catch (retireErr) {
            console.error(`Failed to retire missing candidate ${candidateId}`, retireErr);
            result.failed += 1;
          }
        } else {
          detail.retired = true;
        }
      } else {
        result.failed += 1;
        console.error(`Resume recapture failed for ${candidateId}`, err);
      }
    }
    result.details.push(detail);
    // Respect Workable's ~10 req/s ceiling with margin.
    await new Promise((r) => setTimeout(r, 1100));
  }

  result.remaining = Math.max(0, candidateIds.length - processed);
  return result;
}
