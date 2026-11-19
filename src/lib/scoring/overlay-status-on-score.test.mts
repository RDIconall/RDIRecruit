/**
 * Spec for the score-save disposition bug.
 *
 * These tests are expected to fail until a score save stops forcing
 * candidate_overlay.status back to "active" and skips people who are already
 * withdrawn or disqualified. They exercise the product functions on an
 * in-memory PostgREST stand-in (merge-duplicates upsert, the projection claim
 * in supabase/migrations/20260831005051_harden_canonical_analysis_lifecycle.sql).
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { NextRequest } from "next/server";

const stubs: Record<string, string> = {
  "@supabase/supabase-js": new URL("./test-stubs/supabase-js.mjs", import.meta.url).href,
  "@clerk/nextjs/server": new URL("./test-stubs/clerk.mjs", import.meta.url).href,
  "next/cache": new URL("./test-stubs/cache.mjs", import.meta.url).href,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = stubs[specifier];
    if (stub) return { url: stub, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

process.env.SUPABASE_URL = "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_KEY = "test-service-key-placeholder";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key-placeholder";
process.env.WORKABLE_TOKEN = "test-workable-token-placeholder";
delete process.env.WORKABLE_API_KEY;
delete process.env.WORKABLE_MEMBER_ID;
delete process.env.VIDEOASK_WEBHOOK_SECRET;
delete process.env.FIREFLIES_API_KEY;
delete process.env.CRON_SECRET;

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const host = new URL(url).host;
  if (host === "127.0.0.1" || host === "localhost") return originalFetch(input, init);
  // Stand-in for outbound HTTP. 400 is not retried by the Workable client.
  return new Response("offline", { status: 400, headers: { "content-type": "text/plain" } });
};

type Row = Record<string, unknown>;

const tables = new Map<string, Row[]>();

function table(name: string): Row[] {
  let rows = tables.get(name);
  if (!rows) {
    rows = [];
    tables.set(name, rows);
  }
  return rows;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function like(value: unknown, pattern: string): boolean {
  const expression =
    "^" +
    pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/%/g, ".*")
      .replace(/_/g, ".") +
    "$";
  return new RegExp(expression).test(String(value ?? ""));
}

function cmp(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

class Query implements PromiseLike<{ data: unknown; error: { message: string } | null; count: number | null }> {
  private preds: Array<(row: Row) => boolean> = [];
  private op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  private payload: Row | Row[] | null = null;
  private onConflict: string[] | null = null;
  private ignoreDuplicates = false;
  private returning = false;
  private head = false;
  private orderBy: { column: string; ascending: boolean } | null = null;
  private rowLimit: number | null = null;
  private rowRange: { from: number; to: number } | null = null;
  private cardinality: "none" | "single" | "maybe" = "none";

  constructor(private readonly name: string) {}

  select(_columns?: string, options?: { head?: boolean; count?: string }): this {
    if (this.op === "select") this.op = "select";
    this.returning = true;
    this.head = Boolean(options?.head);
    return this;
  }

  insert(payload: Row | Row[]): this {
    this.op = "insert";
    this.payload = payload;
    return this;
  }

  upsert(payload: Row | Row[], options?: { onConflict?: string; ignoreDuplicates?: boolean }): this {
    this.op = "upsert";
    this.payload = payload;
    this.onConflict = options?.onConflict?.split(",").map((part) => part.trim()) ?? null;
    this.ignoreDuplicates = Boolean(options?.ignoreDuplicates);
    return this;
  }

  update(payload: Row): this {
    this.op = "update";
    this.payload = payload;
    return this;
  }

  delete(): this {
    this.op = "delete";
    return this;
  }

  eq(column: string, value: unknown): this {
    this.preds.push((row) => row[column] === value);
    return this;
  }

  in(column: string, values: readonly unknown[]): this {
    const allowed = new Set(values);
    this.preds.push((row) => allowed.has(row[column]));
    return this;
  }

  is(column: string, value: unknown): this {
    this.preds.push((row) => (row[column] ?? null) === value);
    return this;
  }

  lt(column: string, value: unknown): this {
    this.preds.push((row) => row[column] != null && cmp(row[column], value) < 0);
    return this;
  }

  gte(column: string, value: unknown): this {
    this.preds.push((row) => row[column] != null && cmp(row[column], value) >= 0);
    return this;
  }

  like(column: string, pattern: string): this {
    this.preds.push((row) => like(row[column], pattern));
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.orderBy = { column, ascending: options?.ascending !== false };
    return this;
  }

  limit(count: number): this {
    this.rowLimit = count;
    return this;
  }

  range(from: number, to: number): this {
    this.rowRange = { from, to };
    return this;
  }

  maybeSingle(): this {
    this.cardinality = "maybe";
    return this;
  }

  single(): this {
    this.cardinality = "single";
    return this;
  }

  then<TResult1 = { data: unknown; error: { message: string } | null; count: number | null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: { message: string } | null; count: number | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve()
      .then(() => this.exec())
      .then(onfulfilled, onrejected);
  }

  private matched(rows = table(this.name)): Row[] {
    return rows.filter((row) => this.preds.every((pred) => pred(row)));
  }

  private exec(): { data: unknown; error: { message: string } | null; count: number | null } {
    if (this.op === "insert") return this.finish(this.insertRows());
    if (this.op === "upsert") return this.finish(this.upsertRows());
    if (this.op === "update") {
      const stamp = new Date().toISOString();
      const patch = { ...(this.payload as Row) };
      for (const row of this.matched()) Object.assign(row, patch, { updated_at: row.updated_at && patch.updated_at ? patch.updated_at : patch.updated_at ?? stamp });
      return this.finish(this.returning ? this.matched() : []);
    }
    if (this.op === "delete") {
      const rows = table(this.name);
      const doomed = new Set(this.matched(rows));
      const kept = rows.filter((row) => !doomed.has(row));
      tables.set(this.name, kept);
      return this.finish([...doomed]);
    }
    let rows = this.matched();
    if (this.orderBy) {
      const { column, ascending } = this.orderBy;
      rows = [...rows].sort((a, b) => {
        const delta = cmp(a[column], b[column]);
        return ascending ? delta : -delta;
      });
    }
    if (this.rowRange) rows = rows.slice(this.rowRange.from, this.rowRange.to + 1);
    if (this.rowLimit != null) rows = rows.slice(0, this.rowLimit);
    return this.finish(rows);
  }

  private insertRows(): Row[] {
    const stamp = new Date().toISOString();
    const incoming = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
    const stored: Row[] = [];
    for (const raw of incoming) {
      const row: Row = {
        ...raw,
        id: raw.id ?? crypto.randomUUID(),
        created_at: raw.created_at ?? stamp,
      };
      if (this.name === "candidate_analyses") {
        row.attempt_count = raw.attempt_count ?? 0;
        row.requested_at = raw.requested_at ?? stamp;
        row.projected_at = raw.projected_at ?? null;
        row.projection_started_at = raw.projection_started_at ?? null;
        row.batch_id = raw.batch_id ?? null;
      }
      table(this.name).push(row);
      stored.push(row);
    }
    return stored;
  }

  private upsertRows(): Row[] {
    const incoming = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
    const written: Row[] = [];
    for (const raw of incoming) {
      const keys = this.onConflict ?? defaultConflict(this.name, raw);
      const existing = table(this.name).find((row) => keys.every((key) => row[key] === raw[key]));
      if (existing && this.ignoreDuplicates) continue;
      if (existing) {
        for (const [key, value] of Object.entries(raw)) {
          if (value !== undefined) existing[key] = value;
        }
        written.push(existing);
        continue;
      }
      const row: Row = { ...raw };
      if (row.id == null && this.name !== "candidate_overlay" && this.name !== "sync_state") {
        row.id = crypto.randomUUID();
      }
      if (this.name === "candidate_analyses") {
        row.attempt_count = raw.attempt_count ?? 0;
        row.requested_at = raw.requested_at ?? new Date().toISOString();
        row.projected_at = raw.projected_at ?? null;
        row.projection_started_at = raw.projection_started_at ?? null;
        row.batch_id = raw.batch_id ?? null;
        row.status = raw.status ?? "pending";
      }
      table(this.name).push(row);
      written.push(row);
    }
    return written;
  }

  private finish(rows: Row[]): { data: unknown; error: { message: string } | null; count: number | null } {
    const count = rows.length;
    if (this.head) return { data: null, error: null, count };
    if (!this.returning && this.op !== "select") return { data: null, error: null, count };
    if (this.cardinality === "maybe") {
      if (rows.length > 1) return { data: null, error: { message: `multiple rows in ${this.name}` }, count };
      return { data: rows[0] ? clone(rows[0]) : null, error: null, count };
    }
    if (this.cardinality === "single") {
      if (rows.length !== 1) return { data: null, error: { message: `expected one row in ${this.name}, got ${rows.length}` }, count };
      return { data: clone(rows[0]), error: null, count };
    }
    return { data: clone(rows), error: null, count };
  }
}

function defaultConflict(name: string, row: Row): string[] {
  if (name === "candidate_overlay" || name === "candidate_working_files") return ["candidate_id"];
  if (name === "candidates") return ["workable_id"];
  if (name === "jobs") return ["shortcode"];
  if (name === "job_rubrics") return ["job_shortcode"];
  if (name === "sync_state") return ["key"];
  if (name === "claude_batches") return ["id"];
  if (row.candidate_id != null && row.input_hash != null) return ["candidate_id", "input_hash"];
  if (row.id != null) return ["id"];
  return ["candidate_id"];
}

function claimProjection(id: string, staleMinutes: number): boolean {
  const row = table("candidate_analyses").find((item) => item.id === id);
  if (!row) return false;
  if (row.status !== "completed" || row.projected_at != null) return false;
  const started = row.projection_started_at;
  const fresh =
    typeof started === "string" &&
    Date.now() - Date.parse(started) < staleMinutes * 60_000;
  if (fresh) return false;
  const now = new Date().toISOString();
  row.projection_started_at = now;
  row.updated_at = now;
  return true;
}

function claimAnalysis(id: string): boolean {
  const row = table("candidate_analyses").find((item) => item.id === id);
  if (!row || row.batch_id != null) return false;
  if (row.status !== "pending" && row.status !== "failed") return false;
  const now = new Date().toISOString();
  row.status = "processing";
  row.started_at = now;
  row.updated_at = now;
  row.attempt_count = Number(row.attempt_count ?? 0) + 1;
  row.error = null;
  return true;
}

function tryAcquireLock(): boolean {
  const rows = table("sync_state");
  const existing = rows.find((row) => row.key === "scoring_lock");
  const now = new Date().toISOString();
  if (!existing) {
    rows.push({ key: "scoring_lock", value: { at: now }, updated_at: now });
    return true;
  }
  const at = (existing.value as { at?: string | null } | null)?.at;
  const stale = at == null || Date.now() - Date.parse(at) > 6 * 60_000;
  if (!stale) return false;
  existing.value = { at: now };
  existing.updated_at = now;
  return true;
}

const client = {
  from(name: string) {
    return new Query(name);
  },
  rpc(fn: string, args?: Record<string, unknown>) {
    if (fn === "claim_candidate_analysis_projection") {
      return Promise.resolve({
        data: claimProjection(String(args?.p_analysis_id), Number(args?.p_stale_minutes ?? 15)),
        error: null,
      });
    }
    if (fn === "claim_candidate_analysis") {
      return Promise.resolve({ data: claimAnalysis(String(args?.p_analysis_id)), error: null });
    }
    if (fn === "try_acquire_scoring_lock") {
      return Promise.resolve({ data: tryAcquireLock(), error: null });
    }
    if (fn === "release_scoring_lock") {
      const row = table("sync_state").find((item) => item.key === "scoring_lock");
      if (row) row.value = { at: null };
      return Promise.resolve({ data: null, error: null });
    }
    return Promise.resolve({ data: null, error: { message: `unknown rpc ${fn}` } });
  },
};

(globalThis as { __RDI_TEST_SUPABASE__?: typeof client }).__RDI_TEST_SUPABASE__ = client;

import type { EvaluatorOutput } from "./evaluator";
import type { CandidateOverlayRow, CandidateRow, ScoreRow } from "../types";

type ScoreCandidate = typeof import("./run-score").scoreCandidate;
type DeriveDecision = typeof import("../triage/from-supabase").deriveDecisionDetail;
type SortBoard = typeof import("../data/board-queries").sortBoard;

let scoreCandidate: ScoreCandidate;
let processCanonicalAnalysisBatches: typeof import("../analysis/batch").processCanonicalAnalysisBatches;
let rescoreCandidateOnNewEvidence: typeof import("../sync/rescore").rescoreCandidateOnNewEvidence;
let scoreUnscoredAcrossJobs: typeof import("../sync/workable-sync").scoreUnscoredAcrossJobs;
let withdrawCandidate: typeof import("../../app/actions/candidates").withdrawCandidate;
let setDisqualified: typeof import("../../app/actions/triage").setDisqualified;
let disqualifyCandidate: typeof import("../workable/client").disqualifyCandidate;
let deriveDecisionDetail: DeriveDecision;
let sortBoard: SortBoard;
let firefliesPost: typeof import("../../app/api/ingest/fireflies/route").POST;
let videoAskPost: typeof import("../../app/api/hooks/videoask/route").POST;

const JOB = "JOB1";
const RESUME =
  "Clinical research associate. Owned monitoring visits, source-data review, and deviation follow-up for a diagnostics study. Wrote the visit reports and closed the queries.";

function modelEvaluation(): EvaluatorOutput {
  return {
    complement: "technician",
    complementRemoves: "monitoring load",
    salaryVector: "priced about right",
    investHead: "Takes the monitoring load off the desk",
    summary: "Has actually run monitoring visits and would take that load off the founders.",
    categoryScores: { principal: 20, environment: 16, scope: 16, writing: 12, tenure: 8, local: 8 },
    rubricSchemaVersion: "legacy-v1",
    methodologyVersion: 1,
    seatDimensionScores: {},
    personQuality: "high",
    seatFit: {
      appliedSeat: "Clinical Research Associate",
      verdict: "strong_seat",
      score: null,
      summary: "Fits this posting.",
    },
    evidenceConfidence: "high",
    integrityGate: { status: "clear", note: "" },
    otherGateResults: [],
    roDiagnostic: { currentCapability: "II-III", trajectory: "plateaued", note: "" },
    evidenceProvenance: [],
    alternateSeatSignals: [],
    liveValidationQuestions: [],
    capReasons: [],
    decisionBand: "VIABLE",
    total: 88,
    confidence: "high",
    salaryValue: "justified",
    salaryAsk: "$120,000",
    seatStratum: "IIIb–IIIa",
    currentCapability: "II-III",
    trajectory: "plateaued",
    textConfidence: "confirmed",
    basis: "reasoning",
    aiLikelihood: 0.1,
    roReads: [],
    digIn: {
      quality: "OK",
      mix: "materials on file",
      integrity: "Clear",
      integrityNote: "",
      careerRead: "Ran monitoring visits.",
      resolve: [],
    },
    verification: { read: "No discrepancy in the materials.", claims: [], questions: [], actions: [] },
    answerGrades: [],
    composeQuestions: [],
    triage: {
      why: "Owned monitoring visits and source review; worth an interview.",
      risk: "No decisive risk surfaced.",
    },
    claims: [],
    heuristic: false,
  };
}

function seed(id: string, options?: { disqualified?: boolean; email?: string }) {
  const created = "2026-08-01T00:00:00.000Z";
  table("candidates").push({
    workable_id: id,
    job_shortcode: JOB,
    name: `Applicant ${id}`,
    email: options?.email ?? `${id}@example.com`,
    phone: null,
    location: "Los Angeles, CA",
    stage: "Applied",
    stage_kind: null,
    disqualified: Boolean(options?.disqualified),
    source: "applied",
    assignee_id: null,
    raw: null,
    photo_url: null,
    created_at: created,
    synced_at: created,
  });
  table("applications").push({
    candidate_id: id,
    answers: { "Why this seat?": "I have owned monitoring visits and the deviation log." },
    cover_letter: "I want the coordinator work.",
    parsed_experience: [],
    parsed_education: [],
    resume_text: RESUME,
    resume_url: null,
    resume_storage_path: null,
    resume_parsed: null,
  });
  table("scores").push({
    id: `prior-${id}`,
    candidate_id: id,
    rubric_version: 1,
    category_scores: { principal: 1, environment: 1, scope: 1, writing: 1, tenure: 1, local: 1 },
    total: 40,
    salary_value: "unstated",
    confidence: "low",
    model_version: "prior",
    created_at: "2026-01-01T00:00:00.000Z",
  });
  if (!table("jobs").some((row) => row.shortcode === JOB)) {
    table("jobs").push({
      shortcode: JOB,
      title: "Clinical Research Associate",
      department: "Clinical",
      location: "Van Nuys, CA",
      raw: { full_description: "<p>Own monitoring visits for a diagnostics study.</p>" },
    });
    table("job_rubrics").push({
      job_shortcode: JOB,
      rubric_md: "",
      spec_md:
        "Own site monitoring, source-data review, and deviation follow-up for the diagnostics study in Van Nuys.",
    });
  }
}

function overlay(id: string): Row {
  const row = table("candidate_overlay").find((item) => item.candidate_id === id);
  if (!row) throw new Error(`missing overlay for ${id}`);
  return row;
}

function analysesFor(id: string): Row[] {
  return table("candidate_analyses").filter((row) => row.candidate_id === id);
}

function scoresFor(id: string): Row[] {
  return table("scores").filter((row) => row.candidate_id === id);
}

async function queueCompletedAnalysis(id: string): Promise<Row> {
  const queued = await scoreCandidate(id, { transport: "enqueue", trigger: "new_candidate" });
  assert.equal("queued" in queued && queued.queued, true, `analysis did not queue: ${JSON.stringify(queued)}`);
  const row = analysesFor(id)[0];
  assert.ok(row, "enqueue did not persist a candidate_analyses row");
  row.status = "completed";
  row.result = modelEvaluation();
  row.completed_at = "2026-08-02T00:00:00.000Z";
  row.projected_at = null;
  row.projection_started_at = null;
  return row;
}

function poolView(id: string) {
  const candidate = table("candidates").find((row) => row.workable_id === id) as CandidateRow;
  const stored = overlay(id) as unknown as CandidateOverlayRow;
  const score = (scoresFor(id).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] ??
    null) as ScoreRow | null;
  const decision = deriveDecisionDetail({
    candidate,
    score,
    ro: null,
    overlay: stored,
    application: {
      answers: { "Why this seat?": "I have owned monitoring visits and the deviation log." },
      cover_letter: "I want the coordinator work.",
      parsed_experience: [],
      resume_text: RESUME,
    },
    narrative: [],
    evals: {
      invest: null,
      dig: null,
      verification: null,
      roleReads: [],
      answerGrades: [],
      fitRead: null,
    },
    interviewEvidence: [],
    read: null,
    rank: 1,
    jobLocation: "Van Nuys, CA",
    jobShortcode: JOB,
  }).decision;
  const board = sortBoard([
    {
      candidate: {
        ...candidate,
        workable_id: "older-active",
        name: "Older active",
        disqualified: false,
        created_at: "2020-01-01T00:00:00.000Z",
      },
      score: null,
      ro: null,
      overlay: {
        candidate_id: "older-active",
        status: "active",
        status_reason: null,
        complement: null,
        complement_removes: null,
        salary_vector: null,
        updated_by: null,
        updated_at: "2020-01-01T00:00:00.000Z",
      },
    },
    { candidate, score, ro: null, overlay: stored },
  ]);
  return { decision, firstId: board[0]?.candidate.workable_id, candidateDisqualified: candidate.disqualified };
}

/** The batch submitter calls the provider. This stand-in is offline, so that call rejects after the projection writes. */
async function finishOffline(work: () => Promise<unknown>) {
  try {
    await work();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/400|offline/.test(message)) throw error;
  }
}

function assertStillCut(id: string, status: "withdrawn" | "disqualified", reason: string) {
  const row = overlay(id);
  assert.equal(row.status, status);
  assert.equal(row.status_reason, reason);
  assert.deepEqual(
    scoresFor(id).map((score) => score.id),
    [`prior-${id}`],
  );
  const view = poolView(id);
  assert.equal(view.candidateDisqualified, false);
  assert.equal(view.decision, "reject");
  assert.equal(view.firstId, "older-active");
}

test("scoring must not put a cut candidate back on the active list", { concurrency: false }, async (t) => {
  ({ scoreCandidate } = await import("./run-score"));
  ({ processCanonicalAnalysisBatches } = await import("../analysis/batch"));
  ({ rescoreCandidateOnNewEvidence } = await import("../sync/rescore"));
  ({ scoreUnscoredAcrossJobs } = await import("../sync/workable-sync"));
  ({ withdrawCandidate } = await import("../../app/actions/candidates"));
  ({ setDisqualified } = await import("../../app/actions/triage"));
  ({ disqualifyCandidate } = await import("../workable/client"));
  ({ deriveDecisionDetail } = await import("../triage/from-supabase"));
  ({ sortBoard } = await import("../data/board-queries"));
  ({ POST: firefliesPost } = await import("../../app/api/ingest/fireflies/route"));
  ({ POST: videoAskPost } = await import("../../app/api/hooks/videoask/route"));

  await t.test("an active applicant is still scored", async () => {
    seed("active-1");
    table("candidate_overlay").push({
      candidate_id: "active-1",
      status: "active",
      status_reason: null,
      complement: null,
      complement_removes: null,
      salary_vector: null,
      updated_by: null,
      updated_at: "2026-08-01T00:00:00.000Z",
    });
    const result = await scoreCandidate("active-1", {
      force: true,
      replace: true,
      evaluation: modelEvaluation(),
      trigger: "batch_projection",
    });
    assert.equal("total" in result ? result.total : null, 88);
    assert.equal(overlay("active-1").status, "active");
    assert.ok(scoresFor("active-1").some((row) => row.model_version !== "prior"));
  });

  await t.test("projecting a score queued before a withdrawal keeps the withdrawal", async () => {
    seed("withdrawn-1");
    table("candidate_overlay").push({
      candidate_id: "withdrawn-1",
      status: "active",
      status_reason: null,
      complement: "owner",
      complement_removes: null,
      salary_vector: null,
      updated_by: "reviewer",
      updated_at: "2026-08-01T00:00:00.000Z",
    });
    const analysis = await queueCompletedAnalysis("withdrawn-1");
    const withdrawn = await withdrawCandidate({
      jobShortcode: JOB,
      candidateId: "withdrawn-1",
      reason: "Candidate withdrew",
    });
    assert.equal(withdrawn.ok, true);
    assert.equal(overlay("withdrawn-1").status, "withdrawn");

    const projected = await scoreCandidate("withdrawn-1", {
      force: true,
      replace: true,
      evaluation: analysis.result as EvaluatorOutput,
      expectedInputHash: analysis.input_hash as string,
      trigger: "batch_projection",
    });
    assert.equal(
      "obsolete" in projected && projected.obsolete,
      false,
      "projection never reached the save; input hash did not match the queued analysis",
    );
    assertStillCut("withdrawn-1", "withdrawn", "Candidate withdrew");
    assert.equal(overlay("withdrawn-1").complement, "owner");
  });

  await t.test("projecting a score after a local cut keeps the cut when Workable was not updated", async () => {
    const skipped = await disqualifyCandidate("local-cut-1", "Cut via triage");
    assert.equal(skipped?.skipped, true);

    seed("local-cut-1");
    table("candidate_overlay").push({
      candidate_id: "local-cut-1",
      status: "active",
      status_reason: null,
      complement: "owner",
      complement_removes: null,
      salary_vector: null,
      updated_by: null,
      updated_at: "2026-08-01T00:00:00.000Z",
    });
    const analysis = await queueCompletedAnalysis("local-cut-1");
    const cut = await setDisqualified({
      candidateId: "local-cut-1",
      disqualified: true,
      reason: "Cut via triage",
    });
    assert.equal(cut.ok, true);
    assert.equal(cut.workable, "skipped");
    assert.equal(table("candidates").find((row) => row.workable_id === "local-cut-1")?.disqualified, false);

    const projected = await scoreCandidate("local-cut-1", {
      force: true,
      replace: true,
      evaluation: analysis.result as EvaluatorOutput,
      expectedInputHash: analysis.input_hash as string,
      trigger: "batch_projection",
    });
    assert.equal("obsolete" in projected && projected.obsolete, false);
    assertStillCut("local-cut-1", "disqualified", "Cut via triage");
  });

  await t.test("the analysis-batch cron projects a pre-cut score without reviving the person", async () => {
    seed("batch-withdrawn");
    table("candidate_overlay").push({
      candidate_id: "batch-withdrawn",
      status: "active",
      status_reason: null,
      complement: null,
      complement_removes: null,
      salary_vector: null,
      updated_by: null,
      updated_at: "2026-08-01T00:00:00.000Z",
    });
    await queueCompletedAnalysis("batch-withdrawn");
    await withdrawCandidate({ jobShortcode: JOB, candidateId: "batch-withdrawn", reason: "Candidate withdrew" });
    // Only this completed analysis is waiting, so the cron cannot project a different row.
    const mine = analysesFor("batch-withdrawn").map((row) => row.id);
    tables.set(
      "candidate_analyses",
      table("candidate_analyses").filter((row) => mine.includes(row.id)),
    );

    await processCanonicalAnalysisBatches();
    assertStillCut("batch-withdrawn", "withdrawn", "Candidate withdrew");
  });

  await t.test("rescore on new evidence does not revive a withdrawn applicant", async () => {
    seed("rescore-withdrawn");
    table("candidate_overlay").push({
      candidate_id: "rescore-withdrawn",
      status: "active",
      status_reason: null,
      complement: null,
      complement_removes: null,
      salary_vector: null,
      updated_by: null,
      updated_at: "2026-08-01T00:00:00.000Z",
    });
    await queueCompletedAnalysis("rescore-withdrawn");
    await withdrawCandidate({
      jobShortcode: JOB,
      candidateId: "rescore-withdrawn",
      reason: "Candidate withdrew",
    });
    const mine = analysesFor("rescore-withdrawn").map((row) => row.id);
    tables.set(
      "candidate_analyses",
      table("candidate_analyses").filter((row) => mine.includes(row.id)),
    );

    await rescoreCandidateOnNewEvidence("rescore-withdrawn", "fireflies");
    assertStillCut("rescore-withdrawn", "withdrawn", "Candidate withdrew");
  });

  await t.test("an immediate rescore does not revive a local cut", async () => {
    seed("rescore-cut");
    table("candidate_overlay").push({
      candidate_id: "rescore-cut",
      status: "active",
      status_reason: null,
      complement: null,
      complement_removes: null,
      salary_vector: null,
      updated_by: null,
      updated_at: "2026-08-01T00:00:00.000Z",
    });
    await queueCompletedAnalysis("rescore-cut");
    await setDisqualified({ candidateId: "rescore-cut", disqualified: true, reason: "Cut via triage" });
    const mine = analysesFor("rescore-cut").map((row) => row.id);
    tables.set(
      "candidate_analyses",
      table("candidate_analyses").filter((row) => mine.includes(row.id)),
    );

    await rescoreCandidateOnNewEvidence("rescore-cut", "async_video", { immediate: true });
    assertStillCut("rescore-cut", "disqualified", "Cut via triage");
  });

  await t.test("the bulk scoring pass does not queue a withdrawn applicant", async () => {
    seed("bulk-withdrawn");
    table("candidate_overlay").push({
      candidate_id: "bulk-withdrawn",
      status: "withdrawn",
      status_reason: "Candidate withdrew",
      complement: null,
      complement_removes: null,
      salary_vector: null,
      updated_by: "reviewer",
      updated_at: "2026-08-01T00:00:00.000Z",
    });
    tables.set("candidate_analyses", []);
    await finishOffline(() => scoreUnscoredAcrossJobs({ budgetMs: 20_000, concurrency: 1 }));
    assert.equal(analysesFor("bulk-withdrawn").length, 0);
    assertStillCut("bulk-withdrawn", "withdrawn", "Candidate withdrew");
  });

  await t.test("the bulk scoring pass does not project a score queued before a local cut", async () => {
    seed("bulk-cut");
    table("candidate_overlay").push({
      candidate_id: "bulk-cut",
      status: "active",
      status_reason: null,
      complement: null,
      complement_removes: null,
      salary_vector: null,
      updated_by: null,
      updated_at: "2026-08-01T00:00:00.000Z",
    });
    await queueCompletedAnalysis("bulk-cut");
    await setDisqualified({ candidateId: "bulk-cut", disqualified: true, reason: "Cut via triage" });
    const mine = analysesFor("bulk-cut").map((row) => row.id);
    tables.set(
      "candidate_analyses",
      table("candidate_analyses").filter((row) => mine.includes(row.id)),
    );

    await finishOffline(() => scoreUnscoredAcrossJobs({ budgetMs: 20_000, concurrency: 1 }));
    assertStillCut("bulk-cut", "disqualified", "Cut via triage");
  });

  await t.test("a public Fireflies transcript does not revive a withdrawn applicant once its analysis is projected", async () => {
    seed("hook-fireflies", { email: "hook-fireflies@example.com" });
    table("candidate_overlay").push({
      candidate_id: "hook-fireflies",
      status: "active",
      status_reason: null,
      complement: null,
      complement_removes: null,
      salary_vector: null,
      updated_by: null,
      updated_at: "2026-08-01T00:00:00.000Z",
    });
    await withdrawCandidate({
      jobShortcode: JOB,
      candidateId: "hook-fireflies",
      reason: "Candidate withdrew",
    });
    tables.set("candidate_analyses", []);

    try {
      const response = await firefliesPost(
        new NextRequest("http://localhost/api/ingest/fireflies", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            meetingId: "meeting-hook",
            transcript: "Walked the monitoring plan and the deviation log.",
            workable_id: "hook-fireflies",
          }),
        }),
      );
      assert.equal(response.status, 200);
    } catch {
      // The offline provider rejects batch submit. The queued fingerprint is
      // what a later cron projects.
    }

    assert.ok(
      table("evidence").some(
        (row) => row.candidate_id === "hook-fireflies" && row.source_type === "fireflies",
      ),
      "Fireflies route did not store the transcript",
    );
    const queued = analysesFor("hook-fireflies");
    for (const row of queued) {
      row.status = "completed";
      row.result = modelEvaluation();
      row.completed_at = "2026-08-04T00:00:00.000Z";
      row.projected_at = null;
      row.projection_started_at = null;
      row.batch_id = null;
    }
    const mine = queued.map((row) => row.id);
    tables.set(
      "candidate_analyses",
      table("candidate_analyses").filter((row) => mine.includes(row.id)),
    );
    await finishOffline(() => processCanonicalAnalysisBatches());
    assertStillCut("hook-fireflies", "withdrawn", "Candidate withdrew");
  });

  await t.test("a public VideoAsk response does not revive a local cut once its analysis is projected", async () => {
    seed("hook-video", { email: "hook-video@example.com" });
    table("candidate_overlay").push({
      candidate_id: "hook-video",
      status: "active",
      status_reason: null,
      complement: null,
      complement_removes: null,
      salary_vector: null,
      updated_by: null,
      updated_at: "2026-08-01T00:00:00.000Z",
    });
    await setDisqualified({ candidateId: "hook-video", disqualified: true, reason: "Cut via triage" });
    tables.set("candidate_analyses", []);

    try {
      const response = await videoAskPost(
        new NextRequest("http://localhost/api/hooks/videoask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contact: { email: "hook-video@example.com" },
            id: "video-new",
            transcript: "Described the last monitoring visit.",
          }),
        }),
      );
      assert.equal(response.status, 200);
    } catch {
      // The offline provider rejects batch submit. The queued fingerprint is
      // what a later cron projects.
    }

    assert.ok(
      table("evidence").some((row) => row.candidate_id === "hook-video" && row.source_type === "async_video"),
      "VideoAsk route did not store the response",
    );
    const queued = analysesFor("hook-video");
    for (const row of queued) {
      row.status = "completed";
      row.result = modelEvaluation();
      row.completed_at = "2026-08-04T00:00:00.000Z";
      row.projected_at = null;
      row.projection_started_at = null;
      row.batch_id = null;
    }
    const mine = queued.map((row) => row.id);
    tables.set(
      "candidate_analyses",
      table("candidate_analyses").filter((row) => mine.includes(row.id)),
    );
    await finishOffline(() => processCanonicalAnalysisBatches());
    assertStillCut("hook-video", "disqualified", "Cut via triage");
  });

  await t.test("a Workable disqualification on the candidate row still hides them", async () => {
    seed("workable-dq", { disqualified: true });
    table("candidate_overlay").push({
      candidate_id: "workable-dq",
      status: "active",
      status_reason: null,
      complement: null,
      complement_removes: null,
      salary_vector: null,
      updated_by: null,
      updated_at: "2026-08-01T00:00:00.000Z",
    });
    const view = poolView("workable-dq");
    assert.equal(view.candidateDisqualified, true);
    assert.equal(view.decision, "reject");
    assert.equal(view.firstId, "older-active");
  });
});
