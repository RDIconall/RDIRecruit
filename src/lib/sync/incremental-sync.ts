import { hasAnthropic, hasSupabase, hasWorkable } from "../env";
import {
  syncCandidateById,
  syncChangedCandidatesForJob,
  syncJobsFromWorkable,
  upsertCandidateFromWorkable,
} from "./workable-sync";
import { enqueueScoreBacklog, enqueueScoreOne } from "./enqueue-score";
import { readSyncState, writeSyncState } from "./sync-state";
import { getServiceSupabase } from "../supabase/server";
import { getCandidate } from "../workable/client";

export type SyncMode = "incremental" | "daily" | "full";

export interface SyncResult {
  mode: SyncMode;
  jobs: number;
  candidatesSynced: number;
  candidatesSkipped: number;
  /** Candidates enqueued onto the durable scoring workflow this pass. */
  scored: number;
  rescored: number;
  /** Candidates still awaiting analysis after this pass (run again to continue). */
  remaining: number;
  /** Workflow run id when a scoring workflow was started. */
  scoreRunId?: string;
  /** Why scoring was not enqueued, when applicable. */
  scoreSkip?: string;
  /** First few mirror errors, when something fails (debug aid). */
  sampleErrors?: string[];
}

// Only `candidate_created` is a real new-applicant event. Lifecycle changes
// (stage moves, disqualification, hire) all arrive as `candidate_moved` and are
// handled by re-fetching the full candidate (which carries stage/disqualified/
// hired_at) in syncCandidateFromWebhook.
const NEW_CANDIDATE_EVENTS = new Set(["candidate_created"]);

async function deltaScanAllJobs() {
  if (!hasSupabase()) return { changed: 0, skipped: 0, errors: [] as string[] };

  const supabase = getServiceSupabase();
  const { data: jobs } = await supabase.from("jobs").select("shortcode").eq("status", "published");
  const lastScan = await readSyncState<{ at: string | null }>("last_delta_scan", { at: null });
  const scanStartedAt = new Date().toISOString();

  let changed = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const job of jobs ?? []) {
    try {
      const result = await syncChangedCandidatesForJob(job.shortcode, lastScan.at);
      changed += result.changed;
      skipped += result.skipped;
      for (const e of result.errors) if (errors.length < 5) errors.push(e);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (errors.length < 5) errors.push(`job ${job.shortcode}: ${message}`);
      console.error(`Delta scan failed for job ${job.shortcode}`, error);
    }
  }

  // Only advance the cursor when the scan was clean. If anything failed, keep the
  // old cursor so the next run re-pulls those candidates (upserts are idempotent).
  if (errors.length === 0) {
    await writeSyncState("last_delta_scan", { at: scanStartedAt });
  }

  return { changed, skipped, errors };
}

/**
 * Incremental sync:
 * - Delta scan with updated_after (skips unchanged candidates)
 * - Enqueue durable scoring for candidates that still need an evaluation
 *
 * Real-time status/stage changes arrive via the `candidate_moved` webhook. The
 * previous SPI `/events` fast-path was removed: that endpoint returns only
 * SCHEDULED events (call/interview/meeting), never candidate-lifecycle events, so
 * it processed nothing while burning a rate-limited call every sync.
 *
 * Scoring no longer runs inside this request. Each Claude evaluation is a
 * Workflow step, so the cron returns well under the function time limit even
 * when the backlog is deep.
 */
export async function incrementalSync(mode: SyncMode = "incremental"): Promise<SyncResult> {
  if (!hasWorkable()) {
    throw new Error("Workable not configured");
  }

  const result: SyncResult = {
    mode,
    jobs: 0,
    candidatesSynced: 0,
    candidatesSkipped: 0,
    scored: 0,
    rescored: 0,
    remaining: 0,
  };

  result.jobs = await syncJobsFromWorkable();

  // 1) Mirror candidates into Supabase — fast, no Claude. This is the source of truth.
  const delta = await deltaScanAllJobs();
  result.candidatesSynced += delta.changed;
  result.candidatesSkipped += delta.skipped;
  if (delta.errors.length) result.sampleErrors = delta.errors;

  // 2) Enqueue durable scoring for the backlog. Returns in milliseconds.
  if (hasAnthropic()) {
    const enqueued = await enqueueScoreBacklog({
      limit: mode === "incremental" ? 20 : 40,
      // Manual Sync should always kick work; the cron is debounced.
      force: mode === "incremental",
    });
    result.scored = enqueued.enqueued;
    result.remaining = enqueued.remaining;
    if (enqueued.runId) result.scoreRunId = enqueued.runId;
    if (enqueued.skippedReason) result.scoreSkip = enqueued.skippedReason;
  }

  await writeSyncState("last_incremental", {
    at: new Date().toISOString(),
    ...result,
  });

  if (mode === "daily") {
    await writeSyncState("last_daily", { at: new Date().toISOString(), ...result });
  }

  if (hasSupabase()) {
    const supabase = getServiceSupabase();
    await supabase.from("audit_log").insert({
      actor: mode === "daily" ? "cron" : "sync",
      action: `workable_${mode}`,
      entity: "pipeline",
      entity_id: "all",
      detail: result,
    });
  }

  return result;
}

/**
 * Score-only pass: enqueue the durable scoring workflow for stale + unscored
 * candidates without the Workable mirror. Used after a scoring-epoch bump.
 */
export async function rescoreOnly(): Promise<{
  scored: number;
  remaining: number;
  scoreRunId?: string;
  scoreSkip?: string;
}> {
  if (!hasAnthropic() || !hasSupabase()) return { scored: 0, remaining: 0 };

  const enqueued = await enqueueScoreBacklog({ limit: 50, force: true });
  return {
    scored: enqueued.enqueued,
    remaining: enqueued.remaining,
    scoreRunId: enqueued.runId,
    scoreSkip: enqueued.skippedReason,
  };
}

/** Webhook: new applicant → ingest + enqueue score; everything else → metadata + comments only. */
export async function syncCandidateFromWebhook(input: {
  eventType: string;
  jobShortcode: string;
  candidateId: string;
}) {
  const isNew = NEW_CANDIDATE_EVENTS.has(input.eventType);

  if (isNew) {
    // Mirror only in the webhook request — scoring is durable so Workable gets a
    // fast 200 instead of waiting on a multi-minute Claude eval.
    const { upsert } = await syncCandidateById(input.jobShortcode, input.candidateId, {
      analyze: false,
      initialScore: false,
      syncComments: true,
    });
    await enqueueScoreOne({
      id: input.candidateId,
      jobShortcode: input.jobShortcode,
      scored: false,
      stale: false,
    });
    return upsert;
  }

  const candidate = await getCandidate(input.jobShortcode, input.candidateId);
  return upsertCandidateFromWorkable(candidate, input.jobShortcode, {
    analyze: false,
    syncComments: true,
  });
}
