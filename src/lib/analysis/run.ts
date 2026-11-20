import "server-only";
import { CLAUDE_JUDGMENT_MODEL, estimateCostUsd } from "../ai/models";
import type { SpendHold, SpendReservation } from "../ai/spend-budget";
import {
  evaluateCandidateWithUsage,
  type EvaluatorInput,
  type EvaluatorOutput,
} from "../scoring/evaluator";
import {
  claimCandidateAnalysis,
  completeCandidateAnalysis,
  failCandidateAnalysis,
  findCandidateAnalysis,
  getCandidateAnalysis,
  getOrCreateCandidateAnalysis,
  markAnalysisUncertain,
  type AnalysisStatus,
  type CandidateAnalysisRow,
} from "./store";

export type CanonicalAnalysisResult =
  | { state: "completed"; analysisId: string; evaluation: EvaluatorOutput; reused: boolean }
  | { state: "pending"; analysisId: string }
  | { state: "limited"; retryAt: string; message: string };

/**
 * Budget for a person-initiated analysis. `reserve` runs only when this call is
 * about to purchase a fingerprint nobody has bought or is buying.
 */
export interface AnalysisSpendGate {
  reserve(): Promise<SpendReservation>;
}

const CLAIMABLE: ReadonlySet<AnalysisStatus> = new Set(["pending", "failed"]);

function needsPurchase(row: CandidateAnalysisRow | null): boolean {
  if (!row) return true;
  if (row.status === "obsolete") return !row.result;
  return CLAIMABLE.has(row.status);
}

/**
 * Synchronous path for an explicit recruiter action. It shares the same durable
 * fingerprint and row as batch work, so retrying a button or receiving a duplicate
 * webhook never purchases the same read twice.
 */
export async function runCanonicalAnalysis(
  candidateId: string,
  input: EvaluatorInput,
  trigger: string,
  options?: { spend?: AnalysisSpendGate },
): Promise<CanonicalAnalysisResult> {
  const spend = options?.spend;
  const budget: { hold: SpendHold | null; purchased: boolean } = { hold: null, purchased: false };
  const reserve = async (): Promise<CanonicalAnalysisResult | null> => {
    if (!spend || budget.hold) return null;
    const reservation = await spend.reserve();
    if (!reservation.ok) {
      return { state: "limited", retryAt: reservation.retryAt, message: reservation.message };
    }
    budget.hold = reservation.hold;
    return null;
  };

  try {
    if (spend) {
      // Reserve before the fingerprint row exists: a refused call must not leave a
      // pending row behind for the batch cron to buy instead.
      const existing = await findCandidateAnalysis(candidateId, input);
      if (existing?.status === "completed" && existing.result) {
        return { state: "completed", analysisId: existing.id, evaluation: existing.result, reused: true };
      }
      if (needsPurchase(existing)) {
        const limited = await reserve();
        if (limited) return limited;
      }
    }

    const row = await getOrCreateCandidateAnalysis(candidateId, input, trigger);
    if (row.status === "completed" && row.result) {
      return { state: "completed", analysisId: row.id, evaluation: row.result, reused: true };
    }
    if (CLAIMABLE.has(row.status)) {
      const limited = await reserve();
      if (limited) return limited;
    }
    let claimed = CLAIMABLE.has(row.status) ? await claimCandidateAnalysis(row.id) : false;
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
          const limited = await reserve();
          if (limited) return limited;
          claimed = await claimCandidateAnalysis(current.id);
          break;
        }
        if (current?.status === "obsolete" || current?.status === "uncertain") break;
      }
      if (!claimed) return { state: "pending", analysisId: row.id };
    }

    budget.purchased = true;
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
  } finally {
    if (budget.hold && !budget.purchased) await budget.hold.release();
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
