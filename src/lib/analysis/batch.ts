import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { estimateCostUsd } from "../ai/models";
import { logClaudeUsage } from "../ai/usage";
import { env, hasAnthropic, hasSupabase } from "../env";
import { getServiceSupabase } from "../supabase/server";
import { parseEvaluatorMessage } from "../scoring/evaluator";
import { scoreCandidate } from "../scoring/run-score";
import { batchRequestForAnalysis } from "./batch-request";
import {
  completeCandidateAnalysis,
  claimCandidateAnalysis,
  failCandidateAnalysis,
  markAnalysisObsolete,
  type CandidateAnalysisRow,
} from "./store";

// Projection still writes compatibility rows to several existing tables. Keep a
// provider batch small enough that streaming + replay stays under Vercel's 300s
// cap; the next ten-minute cron submits the next group.
const MAX_BATCH_REQUESTS = 25;
const MAX_ATTEMPTS = 3;

export interface BatchProcessResult {
  submitted: number;
  completed: number;
  failed: number;
  pending: number;
}

async function projectCompletedAnalyses(limit = MAX_BATCH_REQUESTS): Promise<number> {
  const supabase = getServiceSupabase();
  const { data } = await supabase
    .from("candidate_analyses")
    .select("*")
    .eq("status", "completed")
    .is("projected_at", null)
    .order("completed_at", { ascending: true })
    .limit(limit);

  let projected = 0;
  for (const row of (data ?? []) as CandidateAnalysisRow[]) {
    if (!row.result) continue;
    const result = await scoreCandidate(row.candidate_id, {
      force: true,
      replace: true,
      evaluation: row.result,
      expectedInputHash: row.input_hash,
      trigger: "batch_projection",
    });
    if ("obsolete" in result && result.obsolete) {
      await markAnalysisObsolete(row.id);
      continue;
    }
    const { error } = await supabase
      .from("candidate_analyses")
      .update({ projected_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", row.id);
    if (!error) projected += 1;
  }
  return projected;
}

async function collectEndedBatch(
  client: Anthropic,
  batchId: string,
): Promise<{ completed: number; failed: number }> {
  const supabase = getServiceSupabase();
  const results = await client.messages.batches.results(batchId);
  let completed = 0;
  let failed = 0;

  for await (const entry of results) {
    const { data } = await supabase
      .from("candidate_analyses")
      .select("*")
      .eq("id", entry.custom_id)
      .eq("batch_id", batchId)
      .maybeSingle();
    const row = data as CandidateAnalysisRow | null;
    if (!row || row.status === "completed" || row.status === "obsolete") continue;

    if (entry.result.type !== "succeeded") {
      const detail =
        entry.result.type === "errored"
          ? entry.result.error.error.message
          : `Anthropic batch result: ${entry.result.type}`;
      await failCandidateAnalysis(row.id, detail);
      failed += 1;
      continue;
    }

    const message = entry.result.message;
    const evaluation = parseEvaluatorMessage(message, row.input_snapshot);
    if (!evaluation) {
      await failCandidateAnalysis(row.id, "Batch returned no usable canonical analysis");
      failed += 1;
      continue;
    }
    const usage = message.usage as unknown as Record<string, unknown>;
    logClaudeUsage("scoring.evaluator.batch", row.model, message.usage, {
      candidateId: row.candidate_id,
      batchId,
    });
    await completeCandidateAnalysis(
      row.id,
      evaluation,
      usage,
      estimateCostUsd(row.model, message.usage),
    );
    completed += 1;
  }

  await supabase
    .from("claude_batches")
    .update({
      status: "results_processed",
      results_processed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", batchId);
  return { completed, failed };
}

async function pollBatches(client: Anthropic): Promise<{ completed: number; failed: number }> {
  const supabase = getServiceSupabase();
  const { data } = await supabase
    .from("claude_batches")
    .select("id, status")
    .in("status", ["in_progress", "canceling", "ended"])
    .order("created_at", { ascending: true })
    .limit(2);

  let completed = 0;
  let failed = 0;
  for (const local of data ?? []) {
    try {
      const remote = await client.messages.batches.retrieve(local.id as string);
      await supabase
        .from("claude_batches")
        .update({
          status: remote.processing_status,
          request_counts: remote.request_counts,
          ended_at: remote.ended_at,
          updated_at: new Date().toISOString(),
        })
        .eq("id", remote.id);
      if (remote.processing_status === "ended") {
        const collected = await collectEndedBatch(client, remote.id);
        completed += collected.completed;
        failed += collected.failed;
      }
    } catch (error) {
      console.error(`Failed to poll Claude batch ${local.id}`, error);
      failed += 1;
    }
  }
  return { completed, failed };
}

async function submitPending(client: Anthropic): Promise<number> {
  const supabase = getServiceSupabase();
  const { data } = await supabase
    .from("candidate_analyses")
    .select("*")
    .in("status", ["pending", "failed"])
    .is("batch_id", null)
    .lt("attempt_count", MAX_ATTEMPTS)
    .order("requested_at", { ascending: true })
    .limit(MAX_BATCH_REQUESTS);
  const rows = (data ?? []) as CandidateAnalysisRow[];
  if (!rows.length) return 0;

  // Reserve each row with the same atomic claim used by synchronous recruiter
  // actions. A manual click and a cron can see the same pending row, but only one
  // of them can purchase it.
  const reserved: CandidateAnalysisRow[] = [];
  for (const row of rows) {
    if (await claimCandidateAnalysis(row.id)) reserved.push(row);
  }
  if (!reserved.length) return 0;

  let batch: Awaited<ReturnType<Anthropic["messages"]["batches"]["create"]>>;
  try {
    batch = await client.messages.batches.create({
      requests: reserved.map(batchRequestForAnalysis),
    });
  } catch (error) {
    await Promise.all(
      reserved.map((row) =>
        failCandidateAnalysis(row.id, error instanceof Error ? error.message : String(error)),
      ),
    );
    throw error;
  }

  const now = new Date().toISOString();
  const { error: batchError } = await supabase.from("claude_batches").insert({
    id: batch.id,
    status: batch.processing_status,
    request_count: reserved.length,
    request_counts: batch.request_counts,
    created_at: batch.created_at,
    ended_at: batch.ended_at,
    updated_at: now,
  });
  if (batchError) throw new Error(`Failed to persist Claude batch: ${batchError.message}`);

  const { data: attached, error } = await supabase.rpc("attach_candidate_analyses_to_batch", {
    p_batch_id: batch.id,
    p_analysis_ids: reserved.map((row) => row.id),
  });
  if (error) throw new Error(`Failed to attach analyses to Claude batch: ${error.message}`);
  if (Number(attached) !== reserved.length) {
    throw new Error(`Attached ${attached ?? 0}/${reserved.length} analyses to Claude batch ${batch.id}`);
  }
  return Number(attached);
}

/**
 * One resumable tick: replay durable unprojected results, poll provider batches,
 * project newly completed results, then submit the next pending group. No sleeps
 * and no in-function polling; a later Vercel cron invocation resumes from
 * Supabase.
 */
export async function processCanonicalAnalysisBatches(): Promise<BatchProcessResult> {
  if (!hasSupabase() || !hasAnthropic()) {
    return { submitted: 0, completed: 0, failed: 0, pending: 0 };
  }
  // A Vercel function can die after the atomic claim and before provider
  // submission. No valid synchronous analysis runs for fifteen minutes, so these
  // rows are abandoned and safe to retry.
  const staleBefore = new Date(Date.now() - 15 * 60_000).toISOString();
  await getServiceSupabase()
    .from("candidate_analyses")
    .update({
      status: "failed",
      error: "Recovered abandoned analysis claim",
      updated_at: new Date().toISOString(),
    })
    .eq("status", "processing")
    .is("batch_id", null)
    .lt("started_at", staleBefore);

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  await projectCompletedAnalyses();
  const polled = await pollBatches(client);
  await projectCompletedAnalyses();
  const submitted = await submitPending(client);
  const { count } = await getServiceSupabase()
    .from("candidate_analyses")
    .select("id", { count: "exact", head: true })
    .in("status", ["pending", "failed", "submitted", "processing"]);
  return {
    submitted,
    completed: polled.completed,
    failed: polled.failed,
    pending: count ?? 0,
  };
}

