import "server-only";
import { CLAUDE_JUDGMENT_MODEL } from "../ai/models";
import { getServiceSupabase } from "../supabase/server";
import type { EvaluatorInput, EvaluatorOutput } from "../scoring/evaluator";
import { analysisFingerprint } from "./fingerprint";

export type AnalysisStatus =
  | "pending"
  | "submitted"
  | "processing"
  | "completed"
  | "failed"
  | "obsolete";

export interface CandidateAnalysisRow {
  id: string;
  candidate_id: string;
  input_hash: string;
  status: AnalysisStatus;
  trigger: string;
  model: string;
  input_snapshot: EvaluatorInput;
  result: EvaluatorOutput | null;
  error: string | null;
  batch_id: string | null;
  attempt_count: number;
  requested_at: string;
  completed_at: string | null;
}

export async function getOrCreateCandidateAnalysis(
  candidateId: string,
  input: EvaluatorInput,
  trigger: string,
): Promise<CandidateAnalysisRow> {
  const supabase = getServiceSupabase();
  const inputHash = analysisFingerprint({ candidateId, model: CLAUDE_JUDGMENT_MODEL, input });
  const { data: inserted, error: insertError } = await supabase
    .from("candidate_analyses")
    .upsert(
      {
        candidate_id: candidateId,
        input_hash: inputHash,
        status: "pending",
        trigger,
        model: CLAUDE_JUDGMENT_MODEL,
        input_snapshot: input,
      },
      { onConflict: "candidate_id,input_hash", ignoreDuplicates: true },
    )
    .select("*")
    .maybeSingle();
  if (insertError) throw new Error(`Failed to queue candidate analysis: ${insertError.message}`);
  if (inserted) return inserted as CandidateAnalysisRow;

  const { data: existing, error } = await supabase
    .from("candidate_analyses")
    .select("*")
    .eq("candidate_id", candidateId)
    .eq("input_hash", inputHash)
    .single();
  if (error || !existing) throw new Error(`Failed to load candidate analysis: ${error?.message ?? "missing row"}`);
  return existing as CandidateAnalysisRow;
}

export async function claimCandidateAnalysis(id: string): Promise<boolean> {
  const { data, error } = await getServiceSupabase().rpc("claim_candidate_analysis", {
    p_analysis_id: id,
  });
  if (error) throw new Error(`Failed to claim candidate analysis: ${error.message}`);
  return Boolean(data);
}

export async function completeCandidateAnalysis(
  id: string,
  result: EvaluatorOutput,
  usage?: Record<string, unknown> | null,
  costUsd?: number | null,
): Promise<void> {
  const { error } = await getServiceSupabase()
    .from("candidate_analyses")
    .update({
      status: "completed",
      result,
      usage: usage ?? null,
      cost_usd: costUsd ?? null,
      error: null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw new Error(`Failed to complete candidate analysis: ${error.message}`);
}

export async function failCandidateAnalysis(id: string, errorMessage: string): Promise<void> {
  const { error } = await getServiceSupabase()
    .from("candidate_analyses")
    .update({
      status: "failed",
      error: errorMessage.slice(0, 2000),
      batch_id: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw new Error(`Failed to fail candidate analysis: ${error.message}`);
}

export async function markAnalysisObsolete(id: string): Promise<void> {
  await getServiceSupabase()
    .from("candidate_analyses")
    .update({ status: "obsolete", updated_at: new Date().toISOString() })
    .eq("id", id);
}

export async function markAnalysisProjected(id: string): Promise<void> {
  const { error } = await getServiceSupabase()
    .from("candidate_analyses")
    .update({ projected_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "completed");
  if (error) throw new Error(`Failed to mark candidate analysis projected: ${error.message}`);
}

