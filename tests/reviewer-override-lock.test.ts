/**
 * Spec for the reviewer-override pin.
 *
 * A corrected total is stored on scores.model_version = "reviewer-override".
 * Automatic rescore must leave that row in place, must not make a model total
 * the latest score, and must not replace the fit read the board uses as the
 * hiring call. These assertions fail while the lock reads fit_read.model_version
 * and scoreCandidate(replace) deletes every score.
 *
 * Clerk's session lookup is stubbed (tests/stubs/clerk-server.cjs) so
 * submitReadAdjustment passes the userId check in src/app/actions/calibration.ts.
 * Supabase is the real @supabase/supabase-js client talking to the PostgREST
 * store in memory-postgrest.ts. Anthropic message batches are refused; the
 * calibration distill call gets a fixed JSON rule so the real epoch bump runs.
 * After a queued analysis exists, the test writes the model result the batch
 * projector would receive and calls processCanonicalAnalysisBatches.
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Module from "node:module";
import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryPostgrest, type Row } from "./memory-postgrest";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const moduleLoader = Module as unknown as {
  _resolveFilename: (request: string, parent: unknown, isMain: boolean, options: unknown) => string;
};
const resolveFilename = moduleLoader._resolveFilename;
moduleLoader._resolveFilename = function (request, parent, isMain, options) {
  if (request === "server-only") return path.join(here, "stubs/server-only.cjs");
  if (request === "@clerk/nextjs/server") return path.join(here, "stubs/clerk-server.cjs");
  return resolveFilename.call(this, request, parent, isMain, options);
};

process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SERVICE_KEY = "test-service-key-placeholder";
process.env.SUPABASE_ANON_KEY = "test-anon-key-placeholder";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key-placeholder";
process.env.WORKABLE_API_KEY = "test-workable-token-placeholder";
process.env.WORKABLE_SUBDOMAIN = "rditrials";
delete process.env.VIDEOASK_WEBHOOK_SECRET;
delete process.env.FIREFLIES_API_KEY;

const db = createMemoryPostgrest();
const originalFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith("http://supabase.test/")) {
    return db.handle(url, init);
  }
  if (url.startsWith("https://api.anthropic.com/v1/messages/batches")) {
    return new Response(
      JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "batch disabled in test" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  if (url.startsWith("https://api.anthropic.com/v1/messages")) {
    const text = JSON.stringify({
      scope: "role",
      lesson: "Weight owned outcomes over polished prose.",
      markdown: "# Calibration\n- Weight owned outcomes over polished prose.",
    });
    return new Response(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5",
        stop_reason: "end_turn",
        stop_sequence: null,
        content: [{ type: "text", text }],
        usage: { input_tokens: 12, output_tokens: 24 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (url.includes("workable.com/spi/v3/jobs/") && url.includes("/candidates/")) {
    const id = decodeURIComponent(url.split("/candidates/")[1] ?? "").split("?")[0] ?? "";
    return new Response(JSON.stringify({ candidate: workableCandidate(id) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.includes("workable.com")) {
    return new Response("not found", { status: 404 });
  }
  return originalFetch(input, init);
};

const JOB = "CTRL";
const RESUME = "Led the close and built the audit program for a diagnostics lab over six years. ".repeat(3);

function modelEvaluation() {
  return {
    complement: "technician",
    complementRemoves: "operational load",
    salaryVector: "priced about right",
    investHead: "Work off the desk",
    summary: "Model read: interview this candidate.",
    categoryScores: {
      principal: 20,
      environment: 16,
      scope: 16,
      writing: 14,
      tenure: 13,
      local: 13,
    },
    rubricSchemaVersion: "legacy-v1",
    methodologyVersion: null,
    seatDimensionScores: {},
    personQuality: "high",
    seatFit: {
      appliedSeat: "Controller",
      verdict: "strong_seat",
      score: 92,
      summary: "Model says strong seat.",
    },
    evidenceConfidence: "medium",
    integrityGate: { status: "clear", note: "" },
    otherGateResults: [],
    roDiagnostic: { currentCapability: "III", trajectory: "up", note: "" },
    evidenceProvenance: [],
    alternateSeatSignals: [],
    liveValidationQuestions: [],
    capReasons: [],
    decisionBand: "STRONG",
    total: 92,
    confidence: "high",
    salaryValue: "justified",
    salaryAsk: "120000",
    seatStratum: "IIIb–IIIa",
    currentCapability: "III",
    trajectory: "up",
    textConfidence: "confirmed",
    basis: "reasoning",
    aiLikelihood: 0.1,
    roReads: [],
    digIn: {
      quality: "OK",
      mix: "screen",
      integrity: "Clear",
      integrityNote: "",
      careerRead: "Steady.",
      resolve: ["None."],
    },
    verification: { read: "consistent", claims: [], questions: [], actions: [] },
    answerGrades: [],
    composeQuestions: [],
    triage: { why: "Model says interview this candidate.", risk: "Low." },
    claims: [],
    heuristic: false,
  };
}

function workableCandidate(id: string) {
  return {
    id,
    name: "Pat Candidate",
    firstname: "Pat",
    lastname: "Candidate",
    headline: "Controller",
    account: { subdomain: "rditrials", name: "RDI" },
    job: { shortcode: JOB, title: "Controller" },
    stage: "applied",
    disqualified: false,
    disqualification_reason: null,
    hired_at: null,
    sourced: false,
    profile_url: "https://example.test/candidate",
    address: "Los Angeles, CA",
    phone: "555-0100",
    email: "pat@example.test",
    created_at: "2024-06-01T00:00:00.000Z",
    updated_at: "2024-06-02T00:00:00.000Z",
    answers: [{ question: { body: "Tell us about a close you owned." }, answer: { body: "I built the audit program and led the monthly close." } }],
    experience_entries: [
      {
        title: "Controller",
        company: "Lab Co",
        industry: "diagnostics",
        start_date: "2019-01-01",
        end_date: "",
        summary: "Owned the close.",
        current: true,
      },
    ],
  };
}

function seedCandidate(id: string, options?: { fitRead?: boolean; answers?: Record<string, string> }) {
  db.handle("http://supabase.test/rest/v1/jobs", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      shortcode: JOB,
      title: "Controller",
      status: "published",
      raw: { full_description: "<p>Own the monthly close and the audit file.</p>" },
    }),
  });
  db.handle("http://supabase.test/rest/v1/job_rubrics", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      job_shortcode: JOB,
      rubric_md: "Score owned outcomes.",
      spec_md: "Own the monthly close and the audit file for this seat.",
    }),
  });
  db.handle("http://supabase.test/rest/v1/candidates", {
    method: "POST",
    body: JSON.stringify({
      workable_id: id,
      job_shortcode: JOB,
      name: "Pat Candidate",
      email: "pat@example.test",
      disqualified: false,
      created_at: "2024-06-01T00:00:00.000Z",
    }),
  });
  db.handle("http://supabase.test/rest/v1/applications", {
    method: "POST",
    body: JSON.stringify({
      candidate_id: id,
      answers: options?.answers ?? { close: "I built the audit program and led the monthly close." },
      resume_text: RESUME,
      cover_letter: "I want the controller seat.",
      parsed_experience: [{ title: "Controller", company: "Lab Co", start: "2019" }],
      parsed_education: [],
    }),
  });
  db.handle("http://supabase.test/rest/v1/scores", {
    method: "POST",
    body: JSON.stringify({
      candidate_id: id,
      rubric_version: 1,
      category_scores: { principal: 20, environment: 16, scope: 16, writing: 12, tenure: 8, local: 8 },
      total: 80,
      salary_value: null,
      model_version: "claude-sonnet-5",
      confidence: "medium",
      created_at: "2024-06-03T00:00:00.000Z",
    }),
  });
  if (options?.fitRead !== false) {
    db.handle("http://supabase.test/rest/v1/evaluations", {
      method: "POST",
      body: JSON.stringify({
        id: `fit-${id}`,
        candidate_id: id,
        kind: "fit_read",
        ref: JOB,
        model_version: "claude-sonnet-5",
        created_at: "2024-06-03T00:00:00.000Z",
        payload: {
          reply: "Do not spend interview time here.",
          sentiment: "negative",
          appliedFit: "Weak ownership.",
          rdiFit: "",
          suggestedSeat: "",
        },
      }),
    });
  }
}

async function pinScore(candidateId: string) {
  const { submitReadAdjustment } = await import("../src/app/actions/calibration");
  let thrown: unknown;
  try {
    await submitReadAdjustment({
      candidateId,
      jobShortcode: JOB,
      candidateName: "Pat Candidate",
      direction: "lower",
      correctedTotal: 41,
      note: "The close was assisted. Do not treat this as a strong fit.",
    });
  } catch (error) {
    thrown = error;
  }
  const pin = db
    .rows("scores")
    .filter((row) => row.candidate_id === candidateId && row.model_version === "reviewer-override")
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  assert.ok(pin, `submitReadAdjustment did not pin a score (${String(thrown)})`);
  return pin;
}

async function projectQueuedModelReads() {
  const queued = db.rows("candidate_analyses").filter((row) => row.projected_at == null);
  if (!queued.length) return undefined;
  db.updateWhere(
    "candidate_analyses",
    (row) => row.projected_at == null,
    {
      status: "completed",
      result: modelEvaluation(),
      projected_at: null,
      projection_started_at: null,
      batch_id: null,
      error: null,
    },
  );
  const { processCanonicalAnalysisBatches } = await import("../src/lib/analysis/batch");
  let thrown: unknown;
  try {
    await processCanonicalAnalysisBatches();
  } catch (error) {
    thrown = error;
  }
  return thrown;
}

function latestScore(candidateId: string): Row | undefined {
  return db
    .rows("scores")
    .filter((row) => row.candidate_id === candidateId)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
}

async function assertPinHeld(candidateId: string, pinId: string, options?: { fitRead?: boolean }) {
  const scores = db.rows("scores").filter((row) => row.candidate_id === candidateId);
  const pin = scores.find((row) => row.id === pinId);
  assert.ok(pin, "the reviewer-override score row was deleted");
  const latest = latestScore(candidateId);
  assert.equal(latest?.id, pinId, "a newer model score replaced the pinned total");
  assert.equal(latest?.model_version, "reviewer-override");
  assert.equal(latest?.total, pin?.total);
  assert.equal(
    scores.some((row) => row.model_version !== "reviewer-override" && row.total === 92),
    false,
    "the model total was written beside the pin",
  );

  const fits = db.rows("evaluations").filter((row) => row.candidate_id === candidateId && row.kind === "fit_read");
  if (options?.fitRead === false) {
    assert.equal(fits.length, 0, "automatic rescore wrote a fit read the board will use");
  } else {
    assert.equal(fits.length, 1);
    assert.equal(fits[0]?.id, `fit-${candidateId}`);
    assert.equal((fits[0]?.payload as { sentiment?: string } | undefined)?.sentiment, "negative");
  }

  const { getPipelineStatus } = await import("../src/lib/status/pipeline-status");
  const status = await getPipelineStatus(JOB);
  assert.equal(status.overrides, 1, "strong-fit counts no longer treat the row as a reviewer pin");
  assert.equal(status.strong, 0, "the model total moved the strong-fit count");
  assert.equal(status.pass, 1);
}

test.beforeEach(() => {
  db.reset();
});

test("a scoring-epoch pass keeps a reviewer's pinned score and fit read", async () => {
  const id = "cand-epoch";
  seedCandidate(id);
  const pin = await pinScore(id);
  const { scoreUnscoredAcrossJobs } = await import("../src/lib/sync/workable-sync");
  let thrown: unknown;
  try {
    await scoreUnscoredAcrossJobs({ budgetMs: 5_000, concurrency: 1 });
  } catch (error) {
    thrown = error;
  }
  const projected = await projectQueuedModelReads();
  if (!latestScore(id) || latestScore(id)?.id !== pin.id) {
    assert.fail(`pinned score was replaced (epoch pass error: ${String(thrown)}; projection error: ${String(projected)})`);
  }
  await assertPinHeld(id, String(pin.id));
});

test("new-evidence rescore keeps a reviewer's pinned score", async () => {
  const id = "cand-evidence";
  seedCandidate(id);
  const pin = await pinScore(id);
  const { rescoreCandidateOnNewEvidence } = await import("../src/lib/sync/rescore");
  let thrown: unknown;
  try {
    await rescoreCandidateOnNewEvidence(id, "async_video");
  } catch (error) {
    thrown = error;
  }
  const projected = await projectQueuedModelReads();
  if (latestScore(id)?.id !== pin.id) {
    assert.fail(`pinned score was replaced (rescore error: ${String(thrown)}; projection error: ${String(projected)})`);
  }
  await assertPinHeld(id, String(pin.id));
});

test("an immediate interview rescore keeps a reviewer's pinned score", async () => {
  const id = "cand-interview";
  seedCandidate(id);
  const pin = await pinScore(id);
  const { rescoreCandidateOnNewEvidence } = await import("../src/lib/sync/rescore");
  try {
    await rescoreCandidateOnNewEvidence(id, "interview");
  } catch {
    // The batch submit is refused in this test. The queued fingerprint is what
    // the immediate path reuses once a model result is stored.
  }
  db.updateWhere("candidate_analyses", (row) => row.candidate_id === id, {
    status: "completed",
    result: modelEvaluation(),
    projected_at: null,
    projection_started_at: null,
    batch_id: null,
    error: null,
  });
  let thrown: unknown;
  try {
    await rescoreCandidateOnNewEvidence(id, "interview", { immediate: true });
  } catch (error) {
    thrown = error;
  }
  if (latestScore(id)?.id !== pin.id) {
    assert.fail(`immediate rescore replaced the pinned score (${String(thrown)})`);
  }
  if (thrown) assert.fail(`immediate rescore threw before leaving the pin alone: ${String(thrown)}`);
  await assertPinHeld(id, String(pin.id));
});

test("a VideoAsk webhook keeps a reviewer's pinned score", async () => {
  const id = "cand-videoask";
  seedCandidate(id);
  const pin = await pinScore(id);
  const { NextRequest } = await import("next/server");
  const { POST } = await import("../src/app/api/hooks/videoask/route");
  const request = new NextRequest("http://localhost/api/hooks/videoask", {
    method: "POST",
    body: JSON.stringify({
      contact: { email: "pat@example.test" },
      transcript: "I walked through the close I actually owned last quarter.",
      id: "videoask-1",
    }),
  });
  let thrown: unknown;
  try {
    await POST(request);
  } catch (error) {
    thrown = error;
  }
  const projected = await projectQueuedModelReads();
  if (latestScore(id)?.id !== pin.id) {
    assert.fail(`VideoAsk rescore replaced the pinned score (${String(thrown)}; ${String(projected)})`);
  }
  await assertPinHeld(id, String(pin.id));
});

test("a Fireflies transcript keeps a reviewer's pinned score", async () => {
  const id = "cand-fireflies";
  seedCandidate(id);
  const pin = await pinScore(id);
  const { NextRequest } = await import("next/server");
  const { POST } = await import("../src/app/api/ingest/fireflies/route");
  const request = new NextRequest("http://localhost/api/ingest/fireflies", {
    method: "POST",
    body: JSON.stringify({
      metadata: { workable_id: id },
      transcript: "The candidate described owning the audit file end to end.",
      title: "Screen",
      transcriptId: "ff-1",
    }),
  });
  let thrown: unknown;
  try {
    await POST(request);
  } catch (error) {
    thrown = error;
  }
  const projected = await projectQueuedModelReads();
  if (latestScore(id)?.id !== pin.id) {
    assert.fail(`Fireflies rescore replaced the pinned score (${String(thrown)}; ${String(projected)})`);
  }
  await assertPinHeld(id, String(pin.id));
});

test("fit-read backfill keeps a reviewer pin that was never written on fit_read", async () => {
  const id = "cand-backfill";
  seedCandidate(id, { fitRead: false });
  const pin = await pinScore(id);
  const { backfillMissingFitReads } = await import("../src/lib/triage/backfill-fit-reads");
  let thrown: unknown;
  try {
    await backfillMissingFitReads({ budgetMs: 5_000, enqueueLimit: 5 });
  } catch (error) {
    thrown = error;
  }
  const projected = await projectQueuedModelReads();
  if (latestScore(id)?.id !== pin.id) {
    assert.fail(`backfill replaced the pinned score (${String(thrown)}; ${String(projected)})`);
  }
  await assertPinHeld(id, String(pin.id), { fitRead: false });
});

test("the reanalyze cron keeps a reviewer's pinned score", async () => {
  const id = "cand-reanalyze";
  seedCandidate(id);
  const pin = await pinScore(id);
  const { NextRequest } = await import("next/server");
  const { GET } = await import("../src/app/api/cron/reanalyze/route");
  const request = new NextRequest(`http://localhost/api/cron/reanalyze?job=${JOB}&budgetMs=5000&limit=5`);
  let thrown: unknown;
  try {
    await GET(request);
  } catch (error) {
    thrown = error;
  }
  const projected = await projectQueuedModelReads();
  if (latestScore(id)?.id !== pin.id) {
    assert.fail(`reanalyze replaced the pinned score (${String(thrown)}; ${String(projected)})`);
  }
  await assertPinHeld(id, String(pin.id));
});

test("answer recapture keeps a reviewer's pinned score", async () => {
  const id = "cand-answers";
  seedCandidate(id, { answers: {} });
  const pin = await pinScore(id);
  const { recaptureMissingAnswers } = await import("../src/lib/resume/backfill");
  let thrown: unknown;
  try {
    await recaptureMissingAnswers({ budgetMs: 20_000, limit: 1 });
  } catch (error) {
    thrown = error;
  }
  const projected = await projectQueuedModelReads();
  if (latestScore(id)?.id !== pin.id) {
    assert.fail(`answer recapture replaced the pinned score (${String(thrown)}; ${String(projected)})`);
  }
  await assertPinHeld(id, String(pin.id));
});
