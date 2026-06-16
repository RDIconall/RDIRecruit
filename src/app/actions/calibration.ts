"use server";

import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { getServiceSupabase } from "@/lib/supabase/server";
import { hasSupabase } from "@/lib/env";
import { learnFromFeedback } from "@/lib/calibration/service";
import { getActiveRubric } from "@/lib/rubric/service";
import { scoreCandidate } from "@/lib/scoring/run-score";
import type { CategoryKey, CategoryScores } from "@/lib/types";

const OVERRIDE_MODEL = "reviewer-override";

export type AdjustDirection = "lower" | "higher" | "right";

/**
 * Reviewer corrects (and/or annotates) a candidate's read.
 * - Always: distil the reasoning into a durable rule, classify it as role vs
 *   global, merge into calibration, and bump the scoring epoch so future reads
 *   score the way the reviewer would.
 * - If a corrected fit is given: pin it on THIS candidate now (a locked
 *   reviewer-override that auto-scoring will not overwrite).
 * - If only a direction is given: re-score this candidate with the freshly
 *   learned calibration so the read moves now too.
 */
export async function submitReadAdjustment(input: {
  candidateId: string;
  jobShortcode: string;
  candidateName: string;
  direction: AdjustDirection;
  correctedTotal?: number | null;
  note: string;
}) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");
  if (!hasSupabase()) return { ok: false as const, error: "Supabase not configured" };
  if (!input.note.trim()) return { ok: false as const, error: "Add your reasoning so Claude can learn from it." };

  const supabase = getServiceSupabase();

  const { data: jobRow } = await supabase
    .from("jobs")
    .select("title")
    .eq("shortcode", input.jobShortcode)
    .maybeSingle();

  const { data: latestScore } = await supabase
    .from("scores")
    .select("total, category_scores, rubric_version, model_version")
    .eq("candidate_id", input.candidateId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const aiTotal = (latestScore?.total as number | undefined) ?? null;
  const alreadyLocked = latestScore?.model_version === OVERRIDE_MODEL;

  // 1) Learn — distil + classify (role vs global) + merge + bump epoch.
  const learned = await learnFromFeedback({
    jobShortcode: input.jobShortcode,
    jobTitle: (jobRow?.title as string | undefined) ?? input.jobShortcode,
    candidateName: input.candidateName,
    aiTotal,
    correctedTotal: input.correctedTotal ?? null,
    direction: input.direction,
    note: input.note,
  });

  // 2) Persist the raw feedback event.
  await supabase.from("calibration_feedback").insert({
    candidate_id: input.candidateId,
    job_shortcode: input.jobShortcode,
    reviewer: userId,
    direction: input.direction,
    corrected_total: input.correctedTotal ?? null,
    note: input.note.trim(),
    lesson: learned?.lesson ?? null,
    lesson_scope: learned?.scope ?? null,
  });

  // 3) Apply to this candidate.
  let overridden = false;
  let reanalyzed = false;
  if (typeof input.correctedTotal === "number" && Number.isFinite(input.correctedTotal)) {
    const rubric = await getActiveRubric(input.jobShortcode);
    const priorCategories = (latestScore?.category_scores as CategoryScores | undefined) ?? null;
    const categoryScores = scaleCategories(priorCategories, input.correctedTotal, rubric.weights);
    const total = Object.values(categoryScores).reduce((sum, v) => sum + v, 0);

    await supabase.from("scores").insert({
      candidate_id: input.candidateId,
      rubric_version: (latestScore?.rubric_version as number | undefined) ?? rubric.version,
      category_scores: categoryScores,
      total,
      salary_value: null,
      model_version: OVERRIDE_MODEL,
      confidence: "high",
    });
    overridden = true;
  } else if (!alreadyLocked) {
    // Directional only: let the candidate move with the new calibration.
    try {
      await scoreCandidate(input.candidateId, { replace: true });
      reanalyzed = true;
    } catch (error) {
      console.error("Re-score after adjustment failed", error);
    }
  }

  revalidatePath(`/candidates/${input.candidateId}`);
  revalidatePath("/board");
  return {
    ok: true as const,
    overridden,
    reanalyzed,
    scope: learned?.scope ?? null,
    lesson: learned?.lesson ?? null,
  };
}

/** Scale category scores proportionally to hit a reviewer's corrected total, clamped to weights. */
function scaleCategories(
  prior: CategoryScores | null,
  target: number,
  weights: Record<CategoryKey, number>,
): CategoryScores {
  const keys = Object.keys(weights) as CategoryKey[];
  const out = {} as CategoryScores;
  const clampedTarget = Math.max(0, Math.min(100, Math.round(target)));

  const priorTotal = prior ? keys.reduce((sum, k) => sum + (prior[k] ?? 0), 0) : 0;
  if (prior && priorTotal > 0) {
    const factor = clampedTarget / priorTotal;
    let running = 0;
    keys.forEach((k, i) => {
      if (i === keys.length - 1) {
        out[k] = Math.max(0, Math.min(weights[k], clampedTarget - running));
      } else {
        const v = Math.max(0, Math.min(weights[k], Math.round((prior[k] ?? 0) * factor)));
        out[k] = v;
        running += v;
      }
    });
    return out;
  }

  // No prior shape: distribute proportional to weights.
  const weightTotal = keys.reduce((sum, k) => sum + weights[k], 0) || 1;
  let running = 0;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) {
      out[k] = Math.max(0, Math.min(weights[k], clampedTarget - running));
    } else {
      const v = Math.max(0, Math.min(weights[k], Math.round((weights[k] / weightTotal) * clampedTarget)));
      out[k] = v;
      running += v;
    }
  });
  return out;
}
