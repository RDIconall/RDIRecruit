import { NextRequest, NextResponse } from "next/server";
import { env, hasAnthropic, hasSupabase } from "@/lib/env";
import { getBoardFromSupabase } from "@/lib/data/board-queries";
import { getWorkingFiles } from "@/lib/triage/store";
import { assembleGradingInputs, computeReadiness } from "@/lib/triage/readiness";
import { scoreCandidate } from "@/lib/scoring/run-score";
import { processCanonicalAnalysisBatches } from "@/lib/analysis/batch";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Bulk re-derive triage decision reads for a job's pool with the CURRENT
 * job_rubrics rubric + spec. CRON_SECRET-gated, manually triggered (not scheduled).
 *
 * Resilient + resumable:
 *  - Skips disqualified candidates and any candidate with a human decision override.
 *  - `since` lets repeated calls skip candidates already re-graded in this run
 *    (a read whose recalculatedAt >= since). Pass a FIXED timestamp across calls.
 *  - Time-budgeted: returns `remaining` so the caller keeps hitting it until 0.
 *  - Does NOT repair from Workable; it grades on the data already in Supabase, so a
 *    candidate missing a parsed résumé is recorded as "Review blocked", not re-synced.
 *  - A transient Claude failure (null read) is left untouched and retried next pass.
 *
 * Query params:
 *   job=<shortcode>     required
 *   since=<ISO>         default epoch (grade everything); pass a fixed run start to resume
 *   budgetMs=<n>        default 240000
 *   concurrency=<n>     default 4
 *   limit=<n>           optional cap on candidates processed this call
 *   dryRun=1           count eligible candidates without grading
 */
export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (env.CRON_SECRET && auth !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasSupabase()) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });
  }
  if (!hasAnthropic()) {
    return NextResponse.json({ error: "Anthropic not configured" }, { status: 500 });
  }

  const params = request.nextUrl.searchParams;
  const job = params.get("job");
  if (!job) {
    return NextResponse.json({ error: "Missing ?job=<shortcode>" }, { status: 400 });
  }
  const since = params.get("since") || "1970-01-01T00:00:00.000Z";
  const budgetMs = Number(params.get("budgetMs") ?? 240_000);
  const concurrency = Math.max(1, Number(params.get("concurrency") ?? 4));
  const limitParam = Number(params.get("limit") ?? NaN);
  const limit = Number.isFinite(limitParam) ? limitParam : Infinity;
  const dryRun = params.get("dryRun") === "1";

  const board = await getBoardFromSupabase(job);
  if (!board?.length) {
    return NextResponse.json({ ok: true, job, eligible: 0, message: "No candidates for job" });
  }

  const ids = board.map((b) => b.candidate.workable_id as string);
  const workingFiles = await getWorkingFiles(ids);

  // Build the eligible worklist: active, not human-overridden, not already fresh.
  const worklist: string[] = [];
  let skippedDisqualified = 0;
  let skippedOverride = 0;
  let alreadyFresh = 0;
  for (const item of board) {
    const id = item.candidate.workable_id as string;
    const disqualified =
      (item.overlay as { status?: string } | null)?.status === "disqualified" ||
      Boolean((item.candidate as { disqualified?: boolean }).disqualified);
    if (disqualified) {
      skippedDisqualified += 1;
      continue;
    }
    const wf = workingFiles.get(id);
    if (wf?.workspace?.decisionOverride) {
      skippedOverride += 1;
      continue;
    }
    const recalculatedAt = wf?.read?.recalculatedAt;
    if (recalculatedAt && recalculatedAt >= since) {
      alreadyFresh += 1;
      continue;
    }
    worklist.push(id);
  }

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      job,
      since,
      dryRun: true,
      total: board.length,
      eligible: worklist.length,
      skippedDisqualified,
      skippedOverride,
      alreadyFresh,
    });
  }

  const started = Date.now();
  let processed = 0;
  let graded = 0;
  let blocked = 0;
  let failed = 0;

  const targets = worklist.slice(0, Number.isFinite(limit) ? limit : worklist.length);

  async function regradeOne(id: string): Promise<void> {
    try {
      const inputs = await assembleGradingInputs(id, job!);
      const readiness = computeReadiness(inputs);
      if (!readiness.ready) {
        blocked += 1;
        return;
      }
      const result = await scoreCandidate(id, {
        force: true,
        replace: true,
        transport: "enqueue",
        trigger: "bulk_reanalyze",
      });
      if ("completed" in result && result.completed) graded += 1;
    } catch (error) {
      console.error(`reanalyze: failed for ${id}`, error);
      failed += 1;
    } finally {
      processed += 1;
    }
  }

  for (let i = 0; i < targets.length; i += concurrency) {
    if (Date.now() - started > budgetMs) break;
    const batch = targets.slice(i, i + concurrency);
    await Promise.allSettled(batch.map((id) => regradeOne(id)));
  }
  const batch = await processCanonicalAnalysisBatches();
  graded += batch.completed;

  return NextResponse.json({
    ok: true,
    job,
    since,
    eligible: worklist.length,
    processed,
    graded,
    blocked,
    failed,
    remaining: Math.max(0, worklist.length - processed),
    skippedDisqualified,
    skippedOverride,
    alreadyFresh,
    batch,
  });
}
