"use server";

import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { hasSupabase } from "@/lib/env";
import { bumpScoringEpoch } from "@/lib/calibration/service";
import { enqueueScoreBacklog } from "@/lib/sync/enqueue-score";

/**
 * Mark a job's candidates stale and enqueue the durable scoring workflow.
 * Returns immediately — Claude evaluations run as Workflow steps, so the page
 * action never sits inside a multi-minute function.
 */
export async function rescoreJobWithActiveRubric(jobShortcode: string) {
  if (!hasSupabase()) return { ok: false as const, error: "Supabase not configured" };

  await bumpScoringEpoch(jobShortcode);
  const enqueued = await enqueueScoreBacklog({ limit: 40, force: true });

  return {
    ok: true as const,
    rescored: enqueued.enqueued,
    remaining: enqueued.remaining,
    scoreRunId: enqueued.runId,
  };
}

export async function saveRubricAndRecompute(input: {
  jobShortcode: string;
  markdown: string;
}) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const { saveRubric } = await import("./rubrics");
  const saved = await saveRubric({ jobShortcode: input.jobShortcode, markdown: input.markdown });
  if (!saved.ok) return saved;

  // Mark every candidate on this seat stale so the workflow re-scores them with the new rubric.
  const rescore = await rescoreJobWithActiveRubric(input.jobShortcode);

  revalidatePath("/board");
  revalidatePath("/rubrics");
  return {
    ...saved,
    recomputed: rescore.ok ? rescore.rescored : 0,
    remaining: rescore.ok ? rescore.remaining : 0,
  };
}
