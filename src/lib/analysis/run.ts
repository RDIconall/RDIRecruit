import "server-only";
import { CLAUDE_JUDGMENT_MODEL, estimateCostUsd } from "../ai/models";
import {
  evaluateCandidateWithUsage,
  type EvaluatorInput,
  type EvaluatorOutput,
} from "../scoring/evaluator";
import {
  claimCandidateAnalysis,
  completeCandidateAnalysis,
  failCandidateAnalysis,
  getCandidateAnalysis,
  getOrCreateCandidateAnalysis,
  markAnalysisUncertain,
} from "./store";

export type CanonicalAnalysisResult =
  | { state: "completed"; analysisId: string; evaluation: EvaluatorOutput; reused: boolean }
  | { state: "pending"; analysisId: string };

/**
 * Synchronous path for an explicit recruiter action. It shares the same durable
 * fingerprint and row as batch work, so retrying a button or receiving a duplicate
 * webhook never purchases the same read twice.
 */
export async function runCanonicalAnalysis(
  candidateId: string,
  input: EvaluatorInput,
  trigger: string,
): Promise<CanonicalAnalysisResult> {
  const row = await getOrCreateCandidateAnalysis(candidateId, input, trigger);
  if (row.status === "completed" && row.result) {
    return { state: "completed", analysisId: row.id, evaluation: row.result, reused: true };
  }
  let claimed = await claimCandidateAnalysis(row.id);
  if (!claimed) {
    // A recruiter action should not immediately report "unavailable" merely
    // because the identical row finished between our read and claim. Batch work
    // may take much longer, so wait only within the server-action latency budget.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const current = await getCandidateAnalysis(row.id);
      if (current?.status === "completed" && current.result) {
        return {
          state: "completed",
          analysisId: current.id,
          evaluation: current.result,
          reused: true,
        };
      }
      if (current?.status === "failed") {
        claimed = await claimCandidateAnalysis(current.id);
        break;
      }
      if (current?.status === "obsolete" || current?.status === "uncertain") break;
    }
    if (!claimed) return { state: "pending", analysisId: row.id };
  }

  try {
    const { evaluation, usage } = await evaluateCandidateWithUsage(input);
    if (evaluation.heuristic) {
      await failCandidateAnalysis(row.id, "Claude returned no usable canonical analysis");
      return { state: "pending", analysisId: row.id };
    }
    await completeCandidateAnalysis(
      row.id,
      evaluation,
      usage as Record<string, unknown> | null,
      estimateCostUsd(CLAUDE_JUDGMENT_MODEL, usage),
    );
    return { state: "completed", analysisId: row.id, evaluation, reused: false };
  } catch (error) {
    // A transport exception can happen after Anthropic accepted and billed the
    // request but before the response reached us. Retrying would risk a duplicate
    // purchase, so quarantine this fingerprint for explicit operator review.
    await markAnalysisUncertain(row.id, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/** Queue-only path used by automated sync before Message Batch submission. */
export async function enqueueCanonicalAnalysis(
  candidateId: string,
  input: EvaluatorInput,
  trigger: string,
) {
  return getOrCreateCandidateAnalysis(candidateId, input, trigger);
}

