import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { estimateCostUsd } from "../ai/models";
import { logClaudeUsage } from "../ai/usage";
import { env, hasAnthropic, hasSupabase } from "../env";
import { getServiceSupabase } from "../supabase/server";
import { parseEvaluatorMessage } from "../scoring/evaluator";
import { scoreCandidate } from "../scoring/run-score";
import { batchRequestForAnalysis } from "./batch-request";
import { isDefiniteBatchRejection } from "./batch-policy";
import {
  completeCandidateAnalysis,
  claimCandidateAnalysis,
  claimAnalysisProjection,
  failCandidateAnalysis,
  markAnalysisProjected,
  markAnalysisObsolete,
  markAnalysisUncertain,
  releaseAnalysisProjection,
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
    if (!(await claimAnalysisProjection(row.id))) continue;
    try {
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
      await markAnalysisProjected(row.id);
      projected += 1;
    } catch (error) {
      await releaseAnalysisProjection(row.id);
      throw error;
    }
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
  const seen = new Set<string>();

  for await (const entry of results) {
    seen.add(entry.custom_id);
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
      await failCandidateAnalysis(row.id, detail, batchId);
      failed += 1;
      continue;
    }

    const message = entry.result.message;
    const evaluation = parseEvaluatorMessage(message, row.input_snapshot);
    if (!evaluation) {
      await failCandidateAnalysis(row.id, "Batch returned no usable canonical analysis", batchId);
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
      batchId,
    );
    completed += 1;
  }

  // A provider batch is ended, so every attached request must have a terminal
  // result. Any row absent from the JSONL stream is safe to retry: there is no
  // still-running request left that could create a second purchase.
  const { data: missingRows } = await supabase
    .from("candidate_analyses")
    .select("id")
    .eq("batch_id", batchId)
    .eq("status", "submitted");
  for (const row of missingRows ?? []) {
    if (seen.has(row.id as string)) continue;
    await failCandidateAnalysis(row.id as string, "Ended batch omitted this request result", batchId);
    failed += 1;
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
    .select("id, status, expires_at")
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
      const expired =
        typeof local.expires_at === "string" &&
        new Date(local.expires_at).getTime() < Date.now();
      if (expired) {
        const { data: attached } = await supabase
          .from("candidate_analyses")
          .select("id")
          .eq("batch_id", local.id)
          .eq("status", "submitted");
        for (const row of attached ?? []) {
          await failCandidateAnalysis(
            row.id as string,
            "Provider batch expired before a result was available",
            local.id as string,
          );
        }
        await supabase
          .from("claude_batches")
          .update({
            status: "failed",
            error: "Provider batch expired and could not be retrieved",
            updated_at: new Date().toISOString(),
          })
          .eq("id", local.id);
      }
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
        isDefiniteBatchRejection(error)
          ? failCandidateAnalysis(row.id, error instanceof Error ? error.message : String(error))
          : markAnalysisUncertain(row.id, error instanceof Error ? error.message : String(error)),
      ),
    );
    throw error;
  }

  let persistError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const now = new Date().toISOString();
      const { error: batchError } = await supabase.from("claude_batches").upsert({
        id: batch.id,
        status: batch.processing_status,
        request_count: reserved.length,
        request_counts: batch.request_counts,
        created_at: batch.created_at,
        expires_at: batch.expires_at,
        ended_at: batch.ended_at,
        updated_at: now,
      });
      if (batchError) throw batchError;
      const { data: attached, error } = await supabase.rpc("attach_candidate_analyses_to_batch", {
        p_batch_id: batch.id,
        p_analysis_ids: reserved.map((row) => row.id),
      });
      if (error) throw error;
      if (Number(attached) !== reserved.length) {
        throw new Error(`Attached ${attached ?? 0}/${reserved.length} analyses`);
      }
      return Number(attached);
    } catch (error) {
      persistError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }

  // Anthropic accepted the purchase but its id could not be made durable. Cancel
  // best-effort and quarantine the fingerprints; never automatically resubmit an
  // ambiguous accepted batch.
  await client.messages.batches.cancel(batch.id).catch(() => undefined);
  const detail = `Provider batch ${batch.id} accepted but local persistence failed: ${
    persistError instanceof Error ? persistError.message : String(persistError)
  }`;
  await Promise.all(reserved.map((row) => markAnalysisUncertain(row.id, detail)));
  throw new Error(detail);
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
  // A crash after Anthropic accepted a batch but before its id reached Postgres is
  // indistinguishable from a crash before submission. Retrying could buy the same
  // fingerprint twice, so preserve the at-most-once guarantee: quarantine the row
  // for operator reconciliation rather than automatically resubmitting it.
  const staleBefore = new Date(Date.now() - 15 * 60_000).toISOString();
  await getServiceSupabase()
    .from("candidate_analyses")
    .update({
      status: "uncertain",
      error: "Submission outcome unknown after abandoned claim; not retried to avoid duplicate spend",
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

