import { hasAnthropic, hasSupabase } from "../env";
import { getServiceSupabase } from "../supabase/server";
import type { WorkableCandidate, WorkableJob } from "../workable/client";
import { getCandidate, listAllCandidates, listJobs } from "../workable/client";
import { computeApplicationFingerprint } from "./candidate-hash";
import { syncWorkableComments } from "./sync-comments";

// Only one bulk-scoring pass may run at a time. The 10-minute reconcile cron, a
// manual sync, and webhook scoring can otherwise overlap, each re-scoring the same
// stale candidates and racing on the replace-delete → duplicate scores. The lock is
// claimed atomically in Postgres (try_acquire_scoring_lock); TTL (minutes) exceeds
// the function maxDuration so a timed-out pass never wedges the lock.
const SCORING_LOCK_TTL_MINUTES = 6;

function parseExperience(candidate: WorkableCandidate) {
  return (candidate.experience_entries ?? []).map((entry) => ({
    title: entry.title,
    company: entry.company,
    start: entry.start_date,
    end: entry.end_date,
    current: Boolean(entry.current),
    summary: entry.summary,
  }));
}

function parseEducation(candidate: WorkableCandidate) {
  return (candidate.education_entries ?? []).map((entry) => ({
    school: entry.school,
    degree: entry.degree,
    field: entry.field_of_study,
    start: entry.start_date,
    end: entry.end_date,
  }));
}

function answersToRecord(candidate: WorkableCandidate): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const item of candidate.answers ?? []) {
    answers[item.question.body] = item.answer.body;
  }
  return answers;
}

export interface UpsertCandidateResult {
  candidateId: string;
  isNew: boolean;
  /** True when first-time résumé ingest runs — does not imply rescore on later Workable updates. */
  applicationIngested: boolean;
  metadataUpdated: boolean;
  commentsSynced: number;
  skipped: boolean;
}

export async function upsertJob(job: WorkableJob) {
  if (!hasSupabase()) return;
  const supabase = getServiceSupabase();
  await supabase.from("jobs").upsert({
    shortcode: job.shortcode,
    workable_job_id: job.id,
    title: job.title,
    status: job.state,
    department: job.department ?? null,
    location: job.location?.location_str ?? null,
    raw: job as unknown as Record<string, unknown>,
    workable_updated_at: job.updated_at ?? null,
    synced_at: new Date().toISOString(),
  });
}

export async function syncJobsFromWorkable() {
  const jobs = await listJobs({ state: "published", limit: 100 });
  for (const job of jobs) {
    await upsertJob(job);
  }
  return jobs.length;
}

export async function upsertCandidateFromWorkable(
  candidate: WorkableCandidate,
  jobShortcode?: string,
  options?: {
    analyze?: boolean;
    forceAnalyze?: boolean;
    syncComments?: boolean;
    /** Force the candidate + application write even if metadata is unchanged, without résumé ingest. */
    hydrate?: boolean;
  },
): Promise<UpsertCandidateResult> {
  const shortcode = jobShortcode ?? candidate.job?.shortcode;
  if (!shortcode) {
    throw new Error(`Candidate ${candidate.id} has no job shortcode`);
  }
  const applicationFingerprint = computeApplicationFingerprint(candidate);
  const result: UpsertCandidateResult = {
    candidateId: candidate.id,
    isNew: false,
    applicationIngested: false,
    metadataUpdated: false,
    commentsSynced: 0,
    skipped: false,
  };

  if (!hasSupabase()) return result;

  const supabase = getServiceSupabase();
  const { data: existing } = await supabase
    .from("candidates")
    .select("analysis_hash, workable_updated_at")
    .eq("workable_id", candidate.id)
    .maybeSingle();

  result.isNew = !existing;

  const metadataUnchanged = existing?.workable_updated_at === candidate.updated_at;

  if (
    metadataUnchanged &&
    !options?.forceAnalyze &&
    !options?.syncComments &&
    !options?.hydrate
  ) {
    result.skipped = true;
    return result;
  }

  const { error: candidateError } = await supabase.from("candidates").upsert(
    {
      workable_id: candidate.id,
      job_shortcode: shortcode,
      name: candidate.name,
      email: candidate.email,
      phone: candidate.phone,
      location: candidate.address,
      stage: candidate.stage,
      disqualified: candidate.disqualified,
      source: candidate.sourced ? "sourced" : "applied",
      raw: candidate as unknown as Record<string, unknown>,
      created_at: candidate.created_at,
      workable_updated_at: candidate.updated_at,
      analysis_hash: applicationFingerprint,
      synced_at: new Date().toISOString(),
    },
    { onConflict: "workable_id" },
  );

  if (candidateError) {
    throw new Error(`candidate upsert failed (${candidate.id}): ${candidateError.message}`);
  }

  result.metadataUpdated = true;

  const { data: existingApp } = await supabase
    .from("applications")
    .select("id")
    .eq("candidate_id", candidate.id)
    .maybeSingle();

  const applicationPayload = {
    candidate_id: candidate.id,
    answers: answersToRecord(candidate),
    cover_letter: candidate.cover_letter ?? null,
    resume_url: candidate.resume_url ?? null,
    parsed_experience: parseExperience(candidate),
    parsed_education: parseEducation(candidate),
  };

  if (existingApp?.id) {
    const { error } = await supabase
      .from("applications")
      .update(applicationPayload)
      .eq("id", existingApp.id);
    if (error) console.error(`application update failed (${candidate.id})`, error.message);
  } else {
    const { error } = await supabase.from("applications").insert(applicationPayload);
    if (error) console.error(`application insert failed (${candidate.id})`, error.message);
  }

  const needsFirstIngest =
    options?.forceAnalyze ||
    result.isNew ||
    !existing?.analysis_hash;

  const shouldIngestResume =
    options?.analyze !== false && needsFirstIngest;

  if (shouldIngestResume) {
    try {
      const { ingestResumeForCandidate } = await import("../resume/ingest");
      await ingestResumeForCandidate({
        candidateId: candidate.id,
        candidateName: candidate.name,
        resumeUrl: candidate.resume_url,
        workableUpdatedAt: candidate.updated_at,
        parsedExperience: applicationPayload.parsed_experience,
        parsedEducation: applicationPayload.parsed_education,
        force: options?.forceAnalyze,
      });
      result.applicationIngested = true;
    } catch (error) {
      console.error(`Resume ingest failed for ${candidate.id}`, error);
    }
  }

  if (options?.syncComments !== false && (result.isNew || !metadataUnchanged)) {
    result.commentsSynced = await syncWorkableComments(candidate.id);
  }

  return result;
}

/** Initial score only — rescoring happens via rescoreCandidateOnNewEvidence. */
export async function scoreCandidateIfNew(candidateId: string) {
  if (!hasSupabase() || !hasAnthropic()) return { scored: false };

  const supabase = getServiceSupabase();
  const { data: existingScore } = await supabase
    .from("scores")
    .select("id")
    .eq("candidate_id", candidateId)
    .limit(1)
    .maybeSingle();

  if (existingScore) return { scored: false, reason: "already_scored" as const };

  const { scoreCandidate } = await import("../scoring/run-score");
  await scoreCandidate(candidateId);
  return { scored: true };
}

export async function scoreUnscoredBatch(candidateIds: string[], concurrency = 3) {
  if (!hasSupabase() || !hasAnthropic() || !candidateIds.length) {
    return { scored: 0, skipped: 0 };
  }

  const supabase = getServiceSupabase();
  const { data: scoredRows } = await supabase
    .from("scores")
    .select("candidate_id")
    .in("candidate_id", candidateIds);

  const scoredSet = new Set((scoredRows ?? []).map((r) => r.candidate_id as string));
  const toScore = candidateIds.filter((id) => !scoredSet.has(id));
  let scored = 0;

  const { scoreCandidate } = await import("../scoring/run-score");
  for (let i = 0; i < toScore.length; i += concurrency) {
    const batch = toScore.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (candidateId) => {
        try {
          await scoreCandidate(candidateId);
          scored += 1;
        } catch (error) {
          console.error(`Score failed for ${candidateId}`, error);
        }
      }),
    );
  }

  return { scored, skipped: candidateIds.length - toScore.length };
}

export async function syncCandidateById(
  jobShortcode: string,
  candidateId: string,
  options?: { analyze?: boolean; initialScore?: boolean; syncComments?: boolean },
) {
  const candidate = await getCandidate(jobShortcode, candidateId);
  const upsert = await upsertCandidateFromWorkable(candidate, jobShortcode, {
    analyze: options?.analyze ?? true,
    syncComments: options?.syncComments ?? true,
  });

  if (options?.initialScore !== false && upsert.isNew) {
    await scoreCandidateIfNew(candidateId);
  }

  return { candidate, upsert };
}

/**
 * Fast mirror of every candidate for a job into Supabase — no Claude, no résumé
 * download, no comment fetch. Pure DB upserts so the board fills instantly.
 * Pass `updatedAfter` to only pull candidates changed since the last mirror.
 * One bad candidate never aborts the batch.
 */
export async function syncChangedCandidatesForJob(
  jobShortcode: string,
  updatedAfter?: string | null,
) {
  const candidates = await listAllCandidates(jobShortcode, { updatedAfter });
  let changed = 0;
  let skipped = 0;
  let failed = 0;
  const toScore: string[] = [];
  const errors: string[] = [];

  for (const candidate of candidates) {
    try {
      const upsert = await upsertCandidateFromWorkable(candidate, jobShortcode, {
        analyze: false,
        syncComments: false,
      });
      if (upsert.skipped) {
        skipped += 1;
        continue;
      }
      changed += 1;
      if (upsert.isNew) toScore.push(candidate.id);
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      if (errors.length < 3) errors.push(`${candidate.id}: ${message}`);
      console.error(`Mirror failed for candidate ${candidate.id}`, error);
    }
  }

  return { candidates: candidates.length, changed, skipped, failed, toScore, errors };
}

/**
 * Analyze (score + evaluate) every candidate that has no score yet, oldest first,
 * stopping when the time budget is exhausted so the request never times out.
 * Returns how many were scored this pass and how many still remain.
 */
export async function scoreUnscoredAcrossJobs(options?: {
  budgetMs?: number;
  concurrency?: number;
}): Promise<{ scored: number; failed: number; remaining: number }> {
  if (!hasSupabase() || !hasAnthropic()) {
    return { scored: 0, failed: 0, remaining: 0 };
  }

  // Atomically claim the lock. If another bulk pass already holds a fresh lock, bail
  // out — this is what prevents the duplicate scores overlapping runs would create.
  const supabaseLock = getServiceSupabase();
  const { data: claimed, error: lockError } = await supabaseLock.rpc("try_acquire_scoring_lock", {
    ttl_minutes: SCORING_LOCK_TTL_MINUTES,
  });
  if (lockError) {
    console.error("Failed to acquire scoring lock", lockError);
    return { scored: 0, failed: 0, remaining: 0 };
  }
  if (!claimed) {
    return { scored: 0, failed: 0, remaining: 0 };
  }

  try {
    return await runScoreUnscoredPass(options);
  } finally {
    await supabaseLock.rpc("release_scoring_lock");
  }
}

async function runScoreUnscoredPass(options?: {
  budgetMs?: number;
  concurrency?: number;
}): Promise<{ scored: number; failed: number; remaining: number }> {
  const budgetMs = options?.budgetMs ?? 45_000;
  const concurrency = options?.concurrency ?? 8;
  const supabase = getServiceSupabase();

  const [{ data: candidateRows }, { data: scoredRows }, { data: epochRows }] = await Promise.all([
    supabase.from("candidates").select("workable_id, job_shortcode, created_at"),
    supabase.from("scores").select("candidate_id, created_at, model_version"),
    supabase.from("sync_state").select("key, value").like("key", "scoring_epoch:%"),
  ]);

  // Latest score (timestamp + model) per candidate.
  const latestScoreAt = new Map<string, string>();
  const latestModel = new Map<string, string>();
  for (const r of scoredRows ?? []) {
    const id = r.candidate_id as string;
    const at = (r.created_at as string) ?? "";
    const prev = latestScoreAt.get(id);
    if (!prev || at > prev) {
      latestScoreAt.set(id, at);
      latestModel.set(id, (r.model_version as string | null) ?? "");
    }
  }
  // Reviewer overrides are locked — never auto-overwrite a human's corrected read.
  const locked = new Set(
    [...latestModel.entries()].filter(([, m]) => m === "reviewer-override").map(([id]) => id),
  );

  // Scoring epoch per scope (job shortcode or 'global'). A candidate is stale
  // when its latest score predates the effective epoch for its seat.
  const epochByScope = new Map<string, string>();
  for (const row of epochRows ?? []) {
    const scope = (row.key as string).replace("scoring_epoch:", "");
    const at = (row.value as { at?: string } | null)?.at;
    if (at) epochByScope.set(scope, at);
  }
  const globalEpoch = epochByScope.get("global") ?? "";
  const effectiveEpoch = (jobShortcode: string | null) => {
    const role = jobShortcode ? epochByScope.get(jobShortcode) ?? "" : "";
    return role > globalEpoch ? role : globalEpoch;
  };

  const toScore = (candidateRows ?? [])
    .map((r) => ({
      id: r.workable_id as string,
      jobShortcode: (r.job_shortcode as string | null) ?? null,
      created_at: (r.created_at as string) ?? "",
    }))
    .map((c) => {
      const scoredAt = latestScoreAt.get(c.id);
      const epoch = effectiveEpoch(c.jobShortcode);
      const stale = Boolean(scoredAt && epoch && scoredAt < epoch);
      return { ...c, scored: Boolean(scoredAt), stale };
    })
    .filter((c) => !locked.has(c.id))
    .filter((c) => !c.scored || c.stale)
    // Unscored first, then stale; oldest applicants first within each.
    .sort((a, b) => Number(a.scored) - Number(b.scored) || a.created_at.localeCompare(b.created_at));

  const { scoreCandidate } = await import("../scoring/run-score");
  const start = Date.now();
  let scored = 0;
  let failed = 0;
  let processed = 0;

  for (let i = 0; i < toScore.length; i += concurrency) {
    if (Date.now() - start > budgetMs) break;
    const batch = toScore.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (entry) => {
        try {
          // Hydrate full candidate (answers, experience, résumé URL) — the list
          // endpoint only returns summaries — then evaluate. Stale re-scores are
          // already fully mirrored, so skip the Workable round-trip for them
          // (keeps the bulk re-score fast enough to finish inside the budget).
          if (!entry.scored && entry.jobShortcode) {
            try {
              const full = await getCandidate(entry.jobShortcode, entry.id);
              await upsertCandidateFromWorkable(full, entry.jobShortcode, {
                analyze: false,
                syncComments: false,
                hydrate: true,
              });
            } catch (hydrateError) {
              console.error(`Hydrate failed for ${entry.id}`, hydrateError);
            }
          }
          await scoreCandidate(entry.id, entry.stale ? { replace: true } : undefined);
          scored += 1;
        } catch (error) {
          failed += 1;
          console.error(`Score failed for ${entry.id}`, error);
        }
      }),
    );
    processed += batch.length;
  }

  return { scored, failed, remaining: Math.max(0, toScore.length - processed) };
}

export async function reconcileWorkablePipeline() {
  const jobCount = await syncJobsFromWorkable();
  const jobs = await listJobs({ state: "published", limit: 100 });
  let synced = 0;
  const toScore: string[] = [];

  const { writeSyncState } = await import("./sync-state");
  for (const job of jobs) {
    const result = await syncChangedCandidatesForJob(job.shortcode);
    synced += result.candidates;
    toScore.push(...result.toScore);
    // Record the authoritative Workable candidate total per job so the board can
    // show how many are not yet pulled into Supabase.
    await writeSyncState(`workable_total:${job.shortcode}`, {
      count: result.candidates,
      failed: result.failed,
      at: new Date().toISOString(),
    });
  }

  const batch = await scoreUnscoredBatch(toScore);

  if (hasSupabase()) {
    const supabase = getServiceSupabase();
    await supabase.from("audit_log").insert({
      actor: "cron",
      action: "reconcile_full",
      entity: "pipeline",
      entity_id: "all",
      detail: { jobs: jobCount, candidates: synced, scored: batch.scored },
    });
  }

  return { jobs: jobCount, candidates: synced, scored: batch.scored, mode: "full" as const };
}

export async function recordEvent(
  source: string,
  type: string,
  payload: Record<string, unknown>,
) {
  if (!hasSupabase()) return;
  const supabase = getServiceSupabase();
  await supabase.from("events").insert({
    source,
    type,
    payload,
    processed: false,
  });
}

export async function markEventProcessed(eventId: string) {
  if (!hasSupabase()) return;
  const supabase = getServiceSupabase();
  await supabase.from("events").update({ processed: true }).eq("id", eventId);
}

export async function patchCandidateFromWorkable(candidate: WorkableCandidate, jobShortcode: string) {
  await upsertCandidateFromWorkable(candidate, jobShortcode, {
    analyze: false,
    syncComments: true,
  });
}
