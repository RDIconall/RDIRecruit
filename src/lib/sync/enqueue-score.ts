import "server-only";
import { start } from "workflow/api";
import { hasAnthropic, hasSupabase } from "../env";
import { listCandidatesNeedingScore } from "./workable-sync";
import { readSyncState, writeSyncState } from "./sync-state";
import {
  scoreCandidatesWorkflow,
  scoreOneCandidateWorkflow,
  type ScoreWorkItem,
} from "@/workflows/score-candidates";

/** How long a "running" marker keeps the cron from stacking another run. */
const WORKFLOW_DEBOUNCE_MS = 45 * 60 * 1000;

export type EnqueueResult = {
  enqueued: number;
  remaining: number;
  skippedReason?: "no_anthropic" | "no_supabase" | "already_running" | "empty";
  runId?: string;
};

/**
 * List candidates that still need an evaluation and start a durable Workflow to
 * score them one-per-step. Returns immediately after enqueue — the Claude work
 * runs outside this request's execution budget.
 *
 * Debounced: if a scoring workflow was marked running within the last 45 minutes,
 * we do not start another (the prior run is still draining the backlog; each step
 * is idempotent via scoreCandidate's already-scored check).
 */
export async function enqueueScoreBacklog(options?: {
  limit?: number;
  /** Force a new run even if one is marked running (manual Sync / scoreOnly). */
  force?: boolean;
}): Promise<EnqueueResult> {
  if (!hasSupabase()) return { enqueued: 0, remaining: 0, skippedReason: "no_supabase" };
  if (!hasAnthropic()) return { enqueued: 0, remaining: 0, skippedReason: "no_anthropic" };

  if (!options?.force) {
    const active = await readSyncState<{ status?: string; at?: string }>("score_workflow", {});
    if (active.status === "running" && active.at) {
      const age = Date.now() - Date.parse(active.at);
      if (Number.isFinite(age) && age >= 0 && age < WORKFLOW_DEBOUNCE_MS) {
        const remaining = (await listCandidatesNeedingScore()).length;
        return { enqueued: 0, remaining, skippedReason: "already_running" };
      }
    }
  }

  const items = await listCandidatesNeedingScore({ limit: options?.limit ?? 40 });
  if (!items.length) return { enqueued: 0, remaining: 0, skippedReason: "empty" };

  const run = await start(scoreCandidatesWorkflow, [items as ScoreWorkItem[]]);
  const remaining = Math.max(0, (await listCandidatesNeedingScore()).length - items.length);

  await writeSyncState("score_workflow", {
    status: "running",
    count: items.length,
    runId: run.runId,
    at: new Date().toISOString(),
  });

  return { enqueued: items.length, remaining, runId: run.runId };
}

/** Enqueue a single candidate (new-applicant webhook). Always starts — no debounce. */
export async function enqueueScoreOne(item: ScoreWorkItem): Promise<EnqueueResult> {
  if (!hasSupabase()) return { enqueued: 0, remaining: 0, skippedReason: "no_supabase" };
  if (!hasAnthropic()) return { enqueued: 0, remaining: 0, skippedReason: "no_anthropic" };

  const run = await start(scoreOneCandidateWorkflow, [item]);
  return { enqueued: 1, remaining: 0, runId: run.runId };
}
