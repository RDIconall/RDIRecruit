/**
 * Durable candidate-scoring pipeline.
 *
 * Each Claude evaluation is a separate Workflow step (its own Vercel Function
 * invocation). The orchestrator suspends between steps, so a 40-candidate backlog
 * no longer has to finish inside a single 300s cron — the failure mode that was
 * driving most of the FUNCTION_INVOCATION_TIMEOUT volume.
 *
 * Triggered from:
 *   - /api/cron/reconcile (after the Workable mirror)
 *   - Workable candidate_created webhook
 *   - Manual Sync / scoreOnly
 *
 * Steps have full Node.js access; the workflow body itself stays deterministic.
 */

export type ScoreWorkItem = {
  id: string;
  jobShortcode: string | null;
  scored: boolean;
  stale: boolean;
};

export type ScoreStepResult = {
  id: string;
  ok: boolean;
  skipped?: boolean;
  jobShortcode: string | null;
};

/**
 * Score a backlog of candidates, one evaluation per durable step, then refresh
 * the board summary only for jobs that actually got a new read.
 */
export async function scoreCandidatesWorkflow(items: ScoreWorkItem[]) {
  "use workflow";

  if (!items.length) {
    return { scored: 0, failed: 0, skipped: 0, jobsRefreshed: 0 };
  }

  await markWorkflowRunningStep(items.length);

  const results: ScoreStepResult[] = [];
  for (const item of items) {
    results.push(await scoreCandidateStep(item));
  }

  const touchedJobs = [
    ...new Set(
      results
        .filter((r) => r.ok && !r.skipped && r.jobShortcode)
        .map((r) => r.jobShortcode as string),
    ),
  ];
  const jobsRefreshed = touchedJobs.length
    ? await refreshBoardSummariesStep(touchedJobs)
    : 0;

  await markWorkflowIdleStep();

  return {
    scored: results.filter((r) => r.ok && !r.skipped).length,
    failed: results.filter((r) => !r.ok).length,
    skipped: results.filter((r) => r.skipped).length,
    jobsRefreshed,
  };
}

/** Single-candidate convenience — used by the Workable created webhook. */
export async function scoreOneCandidateWorkflow(item: ScoreWorkItem) {
  "use workflow";
  return scoreCandidatesWorkflow([item]);
}

async function scoreCandidateStep(item: ScoreWorkItem): Promise<ScoreStepResult> {
  "use step";

  const { scoreOneCandidateEntry } = await import("@/lib/sync/workable-sync");
  const result = await scoreOneCandidateEntry(item);
  return {
    id: item.id,
    ok: result.ok,
    skipped: result.skipped,
    jobShortcode: result.jobShortcode,
  };
}

async function refreshBoardSummariesStep(jobShortcodes: string[]): Promise<number> {
  "use step";

  const { getServiceSupabase } = await import("@/lib/supabase/server");
  const { regenerateBoardSummary } = await import("@/lib/board/summary");
  const supabase = getServiceSupabase();
  const { data: jobs } = await supabase
    .from("jobs")
    .select("shortcode, title")
    .in("shortcode", jobShortcodes);

  let refreshed = 0;
  for (const job of jobs ?? []) {
    try {
      await regenerateBoardSummary(job.shortcode as string, job.title as string | undefined);
      refreshed += 1;
    } catch (error) {
      console.error(`Board summary refresh failed for ${job.shortcode}`, error);
    }
  }
  return refreshed;
}

async function markWorkflowRunningStep(count: number): Promise<void> {
  "use step";
  const { writeSyncState } = await import("@/lib/sync/sync-state");
  await writeSyncState("score_workflow", {
    status: "running",
    count,
    at: new Date().toISOString(),
  });
}

async function markWorkflowIdleStep(): Promise<void> {
  "use step";
  const { writeSyncState } = await import("@/lib/sync/sync-state");
  await writeSyncState("score_workflow", {
    status: "idle",
    at: new Date().toISOString(),
  });
}
