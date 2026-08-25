import { hasAnthropic, hasSupabase, hasWorkable } from "../env";
import {
  markEventFailure,
  markEventProcessed,
  scoreUnscoredAcrossJobs,
  syncCandidateById,
  syncChangedCandidatesForJob,
  syncJobsFromWorkable,
  upsertCandidateFromWorkable,
} from "./workable-sync";
import { readSyncState, writeSyncState } from "./sync-state";
import { getServiceSupabase } from "../supabase/server";
import { getCandidate } from "../workable/client";
import {
  eventFailureStatus,
  shouldRetryEvent,
} from "./event-queue";
import {
  isPermanentWorkableNotFound,
  tombstoneMissingWorkableCandidate,
} from "./failures";

export type SyncMode = "incremental" | "daily" | "full";

export interface SyncResult {
  mode: SyncMode;
  jobs: number;
  candidatesSynced: number;
  candidatesSkipped: number;
  scored: number;
  rescored: number;
  webhookEvents: number;
  webhookFailures: number;
  /** Candidates still awaiting analysis after this pass (run again to continue). */
  remaining: number;
  /** First few mirror errors, when something fails (debug aid). */
  sampleErrors?: string[];
}

// Only `candidate_created` is a real new-applicant event. Lifecycle changes
// (stage moves, disqualification, hire) all arrive as `candidate_moved` and are
// handled by re-fetching the full candidate (which carries stage/disqualified/
// hired_at) in syncCandidateFromWebhook.
const NEW_CANDIDATE_EVENTS = new Set(["candidate_created"]);
const HANDLED_WEBHOOK_EVENTS = new Set(["candidate_created", "candidate_moved"]);

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
 * - Score only brand-new applicants; interview evidence triggers rescore separately
 *
 * Real-time status/stage changes arrive via the `candidate_moved` webhook. The
 * previous SPI `/events` fast-path was removed: that endpoint returns only
 * SCHEDULED events (call/interview/meeting), never candidate-lifecycle events, so
 * it processed nothing while burning a rate-limited call every sync.
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
    webhookEvents: 0,
    webhookFailures: 0,
    remaining: 0,
  };

  result.jobs = await syncJobsFromWorkable();

  const webhookDrain = await processPendingWorkableEvents({
    budgetMs: mode === "incremental" ? 20_000 : 45_000,
    limit: mode === "incremental" ? 10 : 40,
  });
  result.webhookEvents = webhookDrain.processed;
  result.webhookFailures = webhookDrain.failed;

  // 1) Mirror candidates into Supabase — fast, no Claude. This is the source of truth.
  const delta = await deltaScanAllJobs();
  result.candidatesSynced += delta.changed;
  result.candidatesSkipped += delta.skipped;
  if (delta.errors.length) result.sampleErrors = delta.errors;

  // 2) Analyze candidates that have no score yet, within a time budget.
  if (hasAnthropic()) {
    // Incremental passes stay short (the Sync button loops); cron has more room.
    // Daily budget leaves headroom under the 300s function cap for the upfront
    // mirror and the trailing board-summary regen so the pass returns cleanly.
    const budgetMs = mode === "incremental" ? 40_000 : 220_000;
    const batch = await scoreUnscoredAcrossJobs({ budgetMs });
    result.scored += batch.scored;
    result.remaining = batch.remaining;

    // 3) Refresh the editorial board summary for jobs whose reads just changed.
    if (batch.scored > 0 && hasSupabase()) {
      try {
        const { regenerateBoardSummary } = await import("../board/summary");
        const supabase = getServiceSupabase();
        const { data: jobs } = await supabase
          .from("jobs")
          .select("shortcode, title")
          .eq("status", "published");
        for (const job of jobs ?? []) {
          await regenerateBoardSummary(job.shortcode as string, job.title as string | undefined);
        }
      } catch (error) {
        console.error("Board summary refresh failed", error);
      }
    }
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
 * Score-only pass: re-score stale + unscored candidates and refresh board summaries,
 * skipping the Workable mirror/events entirely. Used to drive a bulk re-score (e.g.
 * after a scoring-epoch bump) without burning the function budget on the event scan.
 * The atomic scoring lock still guards against overlap with the reconcile cron.
 */
export async function rescoreOnly(budgetMs = 240_000): Promise<{ scored: number; remaining: number }> {
  if (!hasAnthropic() || !hasSupabase()) return { scored: 0, remaining: 0 };

  // Modestly higher concurrency than the mirror path: each eval is output-bound
  // (~90s), so parallelism is the throughput lever — but too much trips Anthropic
  // rate limits. With the delete-after-eval fix a rate-limited candidate simply
  // keeps its prior score and is retried next pass, so failures are harmless.
  const batch = await scoreUnscoredAcrossJobs({ budgetMs, concurrency: 10 });

  if (batch.scored > 0) {
    try {
      const { regenerateBoardSummary } = await import("../board/summary");
      const supabase = getServiceSupabase();
      const { data: jobs } = await supabase
        .from("jobs")
        .select("shortcode, title")
        .eq("status", "published");
      for (const job of jobs ?? []) {
        await regenerateBoardSummary(job.shortcode as string, job.title as string | undefined);
      }
    } catch (error) {
      console.error("Board summary refresh failed", error);
    }
  }

  return { scored: batch.scored, remaining: batch.remaining };
}

interface PendingWorkableEventRow {
  id: string;
  type: string | null;
  payload: {
    event_type?: string;
    type?: string;
    data?: {
      id?: string;
      candidate?: { id?: string };
      job?: { shortcode?: string };
    };
  } | null;
  attempts?: number | null;
  status?: string | null;
}

export async function processPendingWorkableEvents(options?: {
  limit?: number;
  budgetMs?: number;
}): Promise<{ processed: number; failed: number; permanent: number; remaining: number }> {
  if (!hasSupabase() || !hasWorkable()) return { processed: 0, failed: 0, permanent: 0, remaining: 0 };
  const supabase = getServiceSupabase();
  const limit = options?.limit ?? 25;
  const budgetMs = options?.budgetMs ?? 30_000;
  const staleBefore = new Date(Date.now() - 10 * 60_000).toISOString();

  const { error: staleError } = await supabase
    .from("events")
    .update({ status: "stale", locked_at: null })
    .eq("source", "workable")
    .eq("processed", false)
    .eq("status", "processing")
    .lt("locked_at", staleBefore);
  if (staleError) {
    console.error("Failed to reclaim stale Workable events", staleError);
  }

  const { data: rows, error } = await supabase
    .from("events")
    .select("id, type, payload, attempts, status")
    .eq("source", "workable")
    .eq("processed", false)
    .in("status", ["pending", "retryable_failure", "stale"])
    .order("received_at", { ascending: true })
    .limit(limit);
  if (error) {
    console.error("Failed to load pending Workable events", error);
    return { processed: 0, failed: 1, permanent: 0, remaining: 0 };
  }

  const started = Date.now();
  let processed = 0;
  let failed = 0;
  let permanent = 0;

  for (const row of (rows ?? []) as PendingWorkableEventRow[]) {
    if (Date.now() - started > budgetMs) break;
    const attempts = (row.attempts ?? 0) + 1;
    if (!shouldRetryEvent(row.status, attempts - 1)) {
      await markEventFailure(row.id, "permanent_failure", "Retry budget exhausted");
      permanent += 1;
      continue;
    }

    await supabase
      .from("events")
      .update({ status: "processing", attempts, locked_at: new Date().toISOString() })
      .eq("id", row.id);

    const payload = row.payload ?? {};
    const eventType = payload.event_type ?? payload.type ?? row.type ?? "unknown";
    const candidateId = payload.data?.candidate?.id ?? payload.data?.id;
    const jobShortcode = payload.data?.job?.shortcode;

    try {
      if (!candidateId || !jobShortcode || !HANDLED_WEBHOOK_EVENTS.has(eventType)) {
        await markEventProcessed(row.id);
        processed += 1;
        continue;
      }
      await syncCandidateFromWebhook({ eventType, jobShortcode, candidateId });
      await markEventProcessed(row.id);
      processed += 1;
    } catch (error) {
      const status = eventFailureStatus(error, attempts);
      if (status === "permanent_failure") {
        permanent += 1;
        if (candidateId && isPermanentWorkableNotFound(error)) {
          await tombstoneMissingWorkableCandidate(candidateId, "workable event queue");
        }
      } else {
        failed += 1;
      }
      await markEventFailure(
        row.id,
        status,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const remaining = Math.max(0, (rows?.length ?? 0) - processed - failed - permanent);
  return { processed, failed, permanent, remaining };
}

/** Webhook: new applicant → ingest + initial score; everything else → metadata + comments only. */
export async function syncCandidateFromWebhook(input: {
  eventType: string;
  jobShortcode: string;
  candidateId: string;
}) {
  const isNew = NEW_CANDIDATE_EVENTS.has(input.eventType);

  if (isNew) {
    const { upsert } = await syncCandidateById(input.jobShortcode, input.candidateId, {
      analyze: true,
      initialScore: true,
    });
    return upsert;
  }

  const candidate = await getCandidate(input.jobShortcode, input.candidateId);
  return upsertCandidateFromWorkable(candidate, input.jobShortcode, {
    analyze: false,
    syncComments: true,
  });
}
