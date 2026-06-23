import { hasAnthropic, hasSupabase, hasWorkable } from "../env";
import { listEvents, type WorkableEvent } from "../workable/client";
import {
  scoreUnscoredAcrossJobs,
  syncCandidateById,
  syncChangedCandidatesForJob,
  syncJobsFromWorkable,
  upsertCandidateFromWorkable,
} from "./workable-sync";
import { getEventsCursor, setEventsCursor, readSyncState, writeSyncState } from "./sync-state";
import { getServiceSupabase } from "../supabase/server";
import { getCandidate } from "../workable/client";

export type SyncMode = "incremental" | "daily" | "full";

export interface SyncResult {
  mode: SyncMode;
  jobs: number;
  eventsProcessed: number;
  candidatesSynced: number;
  candidatesSkipped: number;
  scored: number;
  rescored: number;
  /** Candidates still awaiting analysis after this pass (run again to continue). */
  remaining: number;
  cursor?: string | null;
  /** First few mirror errors, when something fails (debug aid). */
  sampleErrors?: string[];
}

const NEW_CANDIDATE_EVENTS = new Set(["candidate_created"]);

const METADATA_EVENTS = new Set([
  "candidate_moved",
  "candidate_disqualified",
  "candidate_requalified",
  "candidate_hired",
  "candidate_updated",
]);

function extractEventRef(event: WorkableEvent): {
  candidateId?: string;
  jobShortcode?: string;
} {
  const payload = event.payload as Record<string, unknown>;
  const data = (payload.data ?? payload) as Record<string, unknown>;
  const candidate = (data.candidate ?? data) as {
    id?: string;
    job?: { shortcode?: string };
  };
  const job = (data.job ?? candidate.job) as { shortcode?: string } | undefined;

  return {
    candidateId: candidate.id ?? (data.id as string | undefined),
    jobShortcode: job?.shortcode ?? (data.job_shortcode as string | undefined),
  };
}

async function processWorkableEvents(since: string | null) {
  const events = await listEvents({
    since: since ?? undefined,
    limit: 100,
  });

  if (!events.length) {
    return { processed: 0, synced: 0, scored: 0, latestCursor: since };
  }

  let synced = 0;
  let scored = 0;
  const seen = new Set<string>();
  let latestCursor = since;

  for (const event of events) {
    if (event.created_at && (!latestCursor || event.created_at > latestCursor)) {
      latestCursor = event.created_at;
    }

    const { candidateId, jobShortcode } = extractEventRef(event);
    if (!candidateId || !jobShortcode) continue;

    const dedupeKey = `${event.type}:${candidateId}:${event.created_at}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    try {
      if (NEW_CANDIDATE_EVENTS.has(event.type)) {
        // Backstop for a missed `candidate_created` webhook (and the résumé-attach
        // race where the résumé lands after creation): pull the résumé + initial
        // score here too, mirroring the real-time webhook path exactly. The isNew /
        // existing-score guards in syncCandidateById keep this from double-scoring a
        // candidate the webhook already handled, and résumé re-ingest is no-op'd by
        // needsFirstIngest once the first ingest succeeded.
        const { upsert } = await syncCandidateById(jobShortcode, candidateId, {
          analyze: true,
          initialScore: true,
        });
        if (!upsert.skipped) {
          synced += 1;
          if (upsert.applicationIngested) scored += 1;
        }
      } else if (METADATA_EVENTS.has(event.type)) {
        // Status/stage/comment changes only mirror metadata (fast, no Claude).
        const candidate = await getCandidate(jobShortcode, candidateId);
        const upsert = await upsertCandidateFromWorkable(candidate, jobShortcode, {
          analyze: false,
          syncComments: true,
        });
        if (!upsert.skipped) synced += 1;
      }
    } catch (error) {
      console.error(`Event sync failed (${event.type}, ${candidateId})`, error);
    }
  }

  if (latestCursor && latestCursor !== since) {
    await setEventsCursor(latestCursor);
  }

  return { processed: events.length, synced, scored, latestCursor };
}

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
 * - Workable events since cursor (status/comment changes)
 * - Delta scan with updated_after (skips unchanged candidates)
 * - Score only brand-new applicants; interview evidence triggers rescore separately
 */
export async function incrementalSync(mode: SyncMode = "incremental"): Promise<SyncResult> {
  if (!hasWorkable()) {
    throw new Error("Workable not configured");
  }

  const result: SyncResult = {
    mode,
    jobs: 0,
    eventsProcessed: 0,
    candidatesSynced: 0,
    candidatesSkipped: 0,
    scored: 0,
    rescored: 0,
    remaining: 0,
    cursor: await getEventsCursor(),
  };

  result.jobs = await syncJobsFromWorkable();

  // 1) Events are a best-effort fast path for status/comment changes. A failure
  //    here (e.g. /events unavailable) must never block the candidate mirror.
  try {
    const since = await getEventsCursor();
    const eventBatch = await processWorkableEvents(since);
    result.eventsProcessed = eventBatch.processed;
    result.candidatesSynced += eventBatch.synced;
    result.scored += eventBatch.scored;
    result.cursor = eventBatch.latestCursor ?? since;
  } catch (error) {
    console.error("Workable events step failed (continuing with delta scan)", error);
  }

  // 2) Mirror candidates into Supabase — fast, no Claude. This is the source of truth.
  const delta = await deltaScanAllJobs();
  result.candidatesSynced += delta.changed;
  result.candidatesSkipped += delta.skipped;
  if (delta.errors.length) result.sampleErrors = delta.errors;

  // 3) Analyze candidates that have no score yet, within a time budget.
  if (hasAnthropic()) {
    // Incremental passes stay short (the Sync button loops); cron has more room.
    // Daily budget leaves headroom under the 300s function cap for the upfront
    // mirror and the trailing board-summary regen so the pass returns cleanly.
    const budgetMs = mode === "incremental" ? 40_000 : 220_000;
    const batch = await scoreUnscoredAcrossJobs({ budgetMs });
    result.scored += batch.scored;
    result.remaining = batch.remaining;

    // 4) Refresh the editorial board summary for jobs whose reads just changed.
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
