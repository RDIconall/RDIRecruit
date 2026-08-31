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
  | "obsolete"
  | "uncertain";

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
  projected_at?: string | null;
}

export async function getCandidateAnalysis(id: string): Promise<CandidateAnalysisRow | null> {
  const { data, error } = await getServiceSupabase()
    .from("candidate_analyses")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Failed to load candidate analysis: ${error.message}`);
  return (data as CandidateAnalysisRow | null) ?? null;
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
  const row = existing as CandidateAnalysisRow;
  if (row.status === "obsolete") {
    const status = row.result ? "completed" : "pending";
    const { data: revived, error: reviveError } = await supabase
      .from("candidate_analyses")
      .update({ status, projected_at: null, projection_started_at: null, updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .select("*")
      .single();
    if (reviveError) throw new Error(`Failed to revive candidate analysis: ${reviveError.message}`);
    return revived as CandidateAnalysisRow;
  }
  return row;
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
  expectedBatchId?: string | null,
): Promise<void> {
  let query = getServiceSupabase()
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
    .eq("id", id)
    .in("status", ["processing", "submitted"]);
  query = expectedBatchId ? query.eq("batch_id", expectedBatchId) : query.is("batch_id", null);
  const { data, error } = await query.select("id").maybeSingle();
  if (error) throw new Error(`Failed to complete candidate analysis: ${error.message}`);
  if (!data) return;
}

export async function failCandidateAnalysis(
  id: string,
  errorMessage: string,
  expectedBatchId?: string | null,
): Promise<void> {
  let query = getServiceSupabase()
    .from("candidate_analyses")
    .update({
      status: "failed",
      error: errorMessage.slice(0, 2000),
      batch_id: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .in("status", ["processing", "submitted"]);
  query = expectedBatchId ? query.eq("batch_id", expectedBatchId) : query.is("batch_id", null);
  const { error } = await query;
  if (error) throw new Error(`Failed to fail candidate analysis: ${error.message}`);
}

export async function markAnalysisObsolete(id: string): Promise<void> {
  await getServiceSupabase()
    .from("candidate_analyses")
    .update({ status: "obsolete", updated_at: new Date().toISOString() })
    .eq("id", id);
}

export async function markAnalysisUncertain(id: string, errorMessage: string): Promise<void> {
  const { error } = await getServiceSupabase()
    .from("candidate_analyses")
    .update({
      status: "uncertain",
      error: errorMessage.slice(0, 2000),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "processing")
    .is("batch_id", null);
  if (error) throw new Error(`Failed to quarantine candidate analysis: ${error.message}`);
}

export async function markAnalysisProjected(id: string): Promise<void> {
  const { error } = await getServiceSupabase()
    .from("candidate_analyses")
    .update({
      projected_at: new Date().toISOString(),
      projection_started_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "completed");
  if (error) throw new Error(`Failed to mark candidate analysis projected: ${error.message}`);
}

export async function claimAnalysisProjection(id: string): Promise<boolean> {
  const { data, error } = await getServiceSupabase().rpc("claim_candidate_analysis_projection", {
    p_analysis_id: id,
    p_stale_minutes: 15,
  });
  if (error) throw new Error(`Failed to claim analysis projection: ${error.message}`);
  return Boolean(data);
}

export async function releaseAnalysisProjection(id: string): Promise<void> {
  await getServiceSupabase()
    .from("candidate_analyses")
    .update({ projection_started_at: null, updated_at: new Date().toISOString() })
    .eq("id", id)
    .is("projected_at", null);
}

