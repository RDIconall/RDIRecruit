import "server-only";
import { evaluateCandidate, type EvaluatorInput, type EvaluatorOutput } from "../scoring/evaluator";
import {
  claimCandidateAnalysis,
  completeCandidateAnalysis,
  failCandidateAnalysis,
  getOrCreateCandidateAnalysis,
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
  if (!(await claimCandidateAnalysis(row.id))) {
    return { state: "pending", analysisId: row.id };
  }

  try {
    const evaluation = await evaluateCandidate(input);
    if (evaluation.heuristic) {
      await failCandidateAnalysis(row.id, "Claude returned no usable canonical analysis");
      return { state: "pending", analysisId: row.id };
    }
    await completeCandidateAnalysis(row.id, evaluation);
    return { state: "completed", analysisId: row.id, evaluation, reused: false };
  } catch (error) {
    await failCandidateAnalysis(row.id, error instanceof Error ? error.message : String(error));
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

