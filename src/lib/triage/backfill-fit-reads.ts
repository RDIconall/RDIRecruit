import type { FitReadEvaluationSource } from "./fit-read";

export interface FitReadBackfillCandidate {
  id: string;
  jobShortcode: string | null;
  disqualified: boolean;
  createdAt: string;
}

export type FitReadBackfillItem = {
  action: "project" | "enqueue";
  candidateId: string;
  jobShortcode: string | null;
  createdAt: string;
};

/**
 * Who still needs a list-facing write-up, and whether we already have the
 * canonical analysis in hand (project, no Claude) or must queue one (enqueue).
 *
 * Disqualified / human-locked / already-written people stay out of the worklist.
 */
export function planFitReadBackfill(input: {
  candidates: FitReadBackfillCandidate[];
  overlayDisqualifiedIds: Iterable<string>;
  fitReadIds: Iterable<string>;
  reviewerLockedIds: Iterable<string>;
  completedAnalysisIds: Iterable<string>;
}): FitReadBackfillItem[] {
  const overlay = new Set(input.overlayDisqualifiedIds);
  const hasRead = new Set(input.fitReadIds);
  const locked = new Set(input.reviewerLockedIds);
  const completed = new Set(input.completedAnalysisIds);

  const items: FitReadBackfillItem[] = [];
  for (const candidate of input.candidates) {
    if (candidate.disqualified || overlay.has(candidate.id)) continue;
    if (hasRead.has(candidate.id) || locked.has(candidate.id)) continue;
    items.push({
      action: completed.has(candidate.id) ? "project" : "enqueue",
      candidateId: candidate.id,
      jobShortcode: candidate.jobShortcode,
      createdAt: candidate.createdAt,
    });
  }

  return items.sort((a, b) => {
    if (a.action !== b.action) return a.action === "project" ? -1 : 1;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

export interface FitReadBackfillResult {
  projected: number;
  queued: number;
  skipped: number;
  remaining: number;
}

const PAGE = 1000;
/** Match the Message Batch submit cap so one tick does not flood the queue. */
const DEFAULT_ENQUEUE_LIMIT = 25;

async function fetchPaged<T>(
  table: string,
  columns: string,
  options?: {
    eq?: { column: string; value: string };
    order?: string;
  },
): Promise<T[]> {
  const { getServiceSupabase } = await import("../supabase/server");
  const supabase = getServiceSupabase();
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    let query = supabase.from(table).select(columns);
    if (options?.eq) query = query.eq(options.eq.column, options.eq.value);
    if (options?.order) query = query.order(options.order, { ascending: true });
    const { data, error } = await query.range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

function isUsableAnalysis(result: FitReadEvaluationSource | null | undefined): boolean {
  if (!result || result.heuristic) return false;
  return Boolean((result.triage?.why || result.summary || "").trim());
}

/**
 * Write a fit read for every active applicant who is still "waiting on analysis":
 * copy it from a completed canonical analysis when we already paid for one, and
 * enqueue the rest on the cheap Message Batch path.
 */
export async function backfillMissingFitReads(options?: {
  budgetMs?: number;
  enqueueLimit?: number;
}): Promise<FitReadBackfillResult> {
  const { hasAnthropic, hasSupabase } = await import("../env");
  if (!hasSupabase()) {
    return { projected: 0, queued: 0, skipped: 0, remaining: 0 };
  }

  const budgetMs = options?.budgetMs ?? 60_000;
  const enqueueLimit = options?.enqueueLimit ?? DEFAULT_ENQUEUE_LIMIT;
  const started = Date.now();

  const [candidateRows, overlayRows, fitReadRows, analysisRows] = await Promise.all([
    fetchPaged<{
      workable_id: string;
      job_shortcode: string | null;
      disqualified: boolean | null;
      created_at: string | null;
    }>("candidates", "workable_id, job_shortcode, disqualified, created_at", { order: "created_at" }),
    fetchPaged<{ candidate_id: string }>("candidate_overlay", "candidate_id", {
      eq: { column: "status", value: "disqualified" },
    }),
    fetchPaged<{ candidate_id: string; model_version: string | null }>(
      "evaluations",
      "candidate_id, model_version",
      { eq: { column: "kind", value: "fit_read" } },
    ),
    fetchPaged<{
      candidate_id: string;
      result: FitReadEvaluationSource | null;
      completed_at: string | null;
    }>("candidate_analyses", "candidate_id, result, completed_at", {
      eq: { column: "status", value: "completed" },
      order: "completed_at",
    }),
  ]);

  const latestAnalysis = new Map<string, FitReadEvaluationSource>();
  for (const row of analysisRows) {
    if (!isUsableAnalysis(row.result)) continue;
    latestAnalysis.set(row.candidate_id, row.result as FitReadEvaluationSource);
  }

  const plan = planFitReadBackfill({
    candidates: candidateRows.map((row) => ({
      id: row.workable_id,
      jobShortcode: row.job_shortcode,
      disqualified: Boolean(row.disqualified),
      createdAt: row.created_at ?? "",
    })),
    overlayDisqualifiedIds: overlayRows.map((row) => row.candidate_id),
    fitReadIds: fitReadRows.map((row) => row.candidate_id),
    reviewerLockedIds: fitReadRows
      .filter((row) => row.model_version === "reviewer-override")
      .map((row) => row.candidate_id),
    completedAnalysisIds: latestAnalysis.keys(),
  });

  const { fitReadFromEvaluation, storeFitRead } = await import("./fit-read");
  const { scoreCandidate } = await import("../scoring/run-score");
  let projected = 0;
  let queued = 0;
  let skipped = 0;
  let processed = 0;

  for (const item of plan) {
    if (Date.now() - started > budgetMs) break;
    if (item.action === "enqueue" && queued >= enqueueLimit) break;

    try {
      if (item.action === "project") {
        const result = latestAnalysis.get(item.candidateId);
        const read = result ? fitReadFromEvaluation(result) : null;
        if (!read) {
          skipped += 1;
        } else {
          await storeFitRead(item.candidateId, item.jobShortcode, read);
          projected += 1;
        }
      } else if (!hasAnthropic()) {
        skipped += 1;
      } else {
        const result = await scoreCandidate(item.candidateId, {
          transport: "enqueue",
          trigger: "fit_read_backfill",
        });
        if ("completed" in result && result.completed) projected += 1;
        else if ("queued" in result && result.queued) queued += 1;
        else skipped += 1;
      }
    } catch (error) {
      skipped += 1;
      console.error(`Fit-read backfill failed for ${item.candidateId}`, error);
    }
    processed += 1;
  }

  return {
    projected,
    queued,
    skipped,
    remaining: Math.max(0, plan.length - processed),
  };
}
