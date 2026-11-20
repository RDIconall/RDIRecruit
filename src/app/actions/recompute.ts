"use server";

import { revalidatePath } from "next/cache";
import { getServiceSupabase } from "@/lib/supabase/server";
import { hasSupabase } from "@/lib/env";
import { scoreCandidate } from "@/lib/scoring/run-score";
import { bumpScoringEpoch } from "@/lib/calibration/service";
import { requireHiringTeam } from "@/lib/auth/hiring-team";
import { reserveModelSpend } from "@/lib/ai/spend-budget";

/**
 * Re-score a job's candidates with the REAL Claude evaluator against the
 * currently-active rubric + calibration. Budgeted so the page action returns;
 * the rest are picked up by the sync cron via the bumped scoring epoch.
 */
async function rescoreJobWithActiveRubric(
  jobShortcode: string,
  budgetMs = 40_000,
) {
  if (!hasSupabase()) return { ok: false as const, error: "Supabase not configured" };
  const supabase = getServiceSupabase();

  const { data: candidates } = await supabase
    .from("candidates")
    .select("workable_id, updated_at")
    .eq("job_shortcode", jobShortcode)
    .order("updated_at", { ascending: false });

  // Don't overwrite candidates a reviewer has manually corrected.
  const { data: overrideRows } = await supabase
    .from("scores")
    .select("candidate_id")
    .eq("model_version", "reviewer-override");
  const locked = new Set((overrideRows ?? []).map((r) => r.candidate_id as string));

  const ids = (candidates ?? [])
    .map((c) => c.workable_id as string)
    .filter((id) => !locked.has(id));
  const started = Date.now();
  let rescored = 0;
  const concurrency = 6;

  for (let i = 0; i < ids.length; i += concurrency) {
    if (Date.now() - started > budgetMs) break;
    const batch = ids.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map((id) =>
        scoreCandidate(id, {
          replace: true,
          transport: "enqueue",
          trigger: "rubric_changed",
        }),
      ),
    );
    rescored += results.filter((r) => r.status === "fulfilled").length;
  }
  const { processCanonicalAnalysisBatches } = await import("@/lib/analysis/batch");
  await processCanonicalAnalysisBatches();

  return { ok: true as const, rescored, remaining: Math.max(0, ids.length - rescored) };
}

export async function saveRubricAndRecompute(input: {
  jobShortcode: string;
  markdown: string;
}) {
  const member = await requireHiringTeam();

  // Saving bumps the seat's scoring epoch, which re-scores its whole pool.
  const reservation = await reserveModelSpend("rescore", {
    userId: member.userId,
    subject: `job:${input.jobShortcode}`,
  });
  if (!reservation.ok) return { ok: false, error: reservation.message };

  const { saveRubric } = await import("./rubrics");
  const saved = await saveRubric({ jobShortcode: input.jobShortcode, markdown: input.markdown });
  if (!saved.ok) {
    await reservation.hold.release();
    return saved;
  }

  // Mark every candidate on this seat stale so the cron re-scores them with the new rubric.
  await bumpScoringEpoch(input.jobShortcode);

  // Re-score a first batch now with the real evaluator for instant feedback.
  const rescore = await rescoreJobWithActiveRubric(input.jobShortcode);

  revalidatePath("/board");
  revalidatePath("/rubrics");
  return {
    ...saved,
    recomputed: rescore.ok ? rescore.rescored : 0,
    remaining: rescore.ok ? rescore.remaining : 0,
  };
}
