import assert from "node:assert/strict";
import { createRequire, register } from "node:module";
import path from "node:path";
import { beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

register(new URL("./helpers/redirect-hooks.mjs", import.meta.url));

/**
 * A reviewer's manual hiring decision is stored on the working file and is
 * supposed to win over a model read until someone deliberately re-runs analysis.
 * These tests drive the automatic paths that finish a score (direct projection,
 * the batch cron, the scoring-epoch pass, and the re-grade cron's trailing
 * projector) and require the pin to still decide what the pool shows.
 *
 * The Supabase client is replaced with an in-memory stand-in. The merge that
 * drops the pin happens in upsertWorkingFile before that client is called.
 */

const require = createRequire(import.meta.url);
const nodeModule = require("node:module") as {
  _resolveFilename: (
    request: string,
    parent: NodeJS.Module,
    isMain: boolean,
    options?: unknown,
  ) => string;
};
const originalResolve = nodeModule._resolveFilename;
const helperDir = path.dirname(fileURLToPath(import.meta.url));
const emptyServerOnly = path.join(helperDir, "../node_modules/server-only/empty.js");
const supabaseDouble = path.join(helperDir, "helpers/supabase-double.cjs");
nodeModule._resolveFilename = function (request, parent, isMain, options) {
  if (request === "server-only") return emptyServerOnly;
  const resolved = originalResolve.call(this, request, parent, isMain, options);
  if (resolved.includes(`${path.sep}supabase${path.sep}server`)) return supabaseDouble;
  return resolved;
};

process.env.SUPABASE_URL = "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_KEY = "test-service-key-placeholder";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key-placeholder";
delete process.env.WORKABLE_TOKEN;
delete process.env.WORKABLE_API_KEY;
delete process.env.CRON_SECRET;
delete process.env.CLAUDE_MODEL_JUDGMENT;

const { memorySupabase } = require("./helpers/memory-supabase.cjs") as {
  memorySupabase: {
    reset(): void;
    rows(table: string): Array<Record<string, unknown>>;
    upserts: Array<{ table: string; row: Record<string, unknown> }>;
  };
};

const JOB = "CDM01";
const RESUME =
  "Clinical data manager who reconciled EDC queries, locked study databases, and wrote deviation narratives for the study lead before each monitoring visit.";

type AppModules = {
  upsertWorkingFile: (
    candidateId: string,
    patch: { content?: string; workspace?: Record<string, unknown> },
    updatedBy?: string,
  ) => Promise<{ workspace: { decisionOverride?: string | null } } | null>;
  getWorkingFile: (candidateId: string) => Promise<{
    workspace: { decisionOverride?: string | null };
    read: { decision?: string } | null;
  } | null>;
  loadOneCandidate: (candidateId: string) => Promise<{ candidate: { decision: string } } | null>;
  scoreCandidate: (candidateId: string, options?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  processCanonicalAnalysisBatches: () => Promise<unknown>;
  scoreUnscoredAcrossJobs: (options?: { budgetMs?: number; concurrency?: number }) => Promise<unknown>;
  analysisFingerprint: (value: unknown) => string;
  CLAUDE_JUDGMENT_MODEL: string;
  getActiveMethodDoc: () => Promise<{ markdown: string; version: number | null }>;
  getActiveRubric: (job: string) => Promise<{
    weights: unknown;
    dimensions: unknown;
    schemaVersion: unknown;
    rawMd: string;
  }>;
  getCalibrationForJob: (job: string) => Promise<{ global: string; role: string }>;
  getJobRubric: (job: string) => Promise<{ specMd: string; rubricMd: string }>;
  buildSeatContext: (input: Record<string, unknown>) => unknown;
  loadInterviewEvidenceText: (candidateId: string) => Promise<string>;
  loadRecruiterCommentsText: (candidateId: string) => Promise<string>;
  computeReadiness: (inputs: Record<string, unknown>) => { ready: boolean; missing: string[] };
};

let app: AppModules;

function interviewEvaluation(): Record<string, unknown> {
  return {
    heuristic: false,
    complement: "technician",
    complementRemoves: "monitoring load",
    salaryVector: "priced about right",
    investHead: "Takes query reconciliation off the desk",
    summary: "Owned database lock and deviation write-ups.",
    categoryScores: { principal: 0, environment: 0, scope: 0, writing: 0, tenure: 0, local: 0 },
    rubricSchemaVersion: "legacy-v1",
    methodologyVersion: null,
    seatDimensionScores: {},
    personQuality: "solid",
    seatFit: {
      appliedSeat: "Clinical Data Manager",
      verdict: "strong_seat",
      score: null,
      summary: "Fits this posting.",
    },
    evidenceConfidence: "high",
    integrityGate: { status: "clear", note: "" },
    otherGateResults: [],
    roDiagnostic: { currentCapability: "IIIb", trajectory: "steady", note: "" },
    evidenceProvenance: [],
    alternateSeatSignals: [],
    liveValidationQuestions: [],
    capReasons: [],
    decisionBand: "INTERVIEW",
    total: 80,
    confidence: "high",
    salaryValue: "justified",
    salaryAsk: "$90k",
    seatStratum: "IIIb–IIIa",
    currentCapability: "IIIb",
    trajectory: "grows-the-role",
    textConfidence: "confirmed",
    basis: "Application materials.",
    aiLikelihood: 0,
    digIn: { integrity: "clear", integrityNote: "", resolve: [] },
    verification: { read: "Materials agree.", claims: [] },
    answerGrades: [],
    composeQuestions: [],
    triage: {
      why: "The model would interview this candidate.",
      risk: "Nothing the model treats as disqualifying.",
    },
    claims: [],
    roReads: [],
  };
}

function yearOf(value: string | null | undefined): number | null {
  const match = value?.match(/\b(19|20)\d{2}\b/);
  const year = match ? Number(match[0]) : null;
  return year && year >= 1950 && year <= new Date().getFullYear() ? year : null;
}

function isUndergrad(degree: string | null | undefined): boolean {
  if (!degree) return false;
  return /\b(bachelor|undergrad|b\.?\s?a\.?|b\.?\s?s\.?|b\.?\s?sc\.?|b\.?eng|bba|ab)\b/i.test(degree);
}

/** Same career-span input the scorer fingerprints. Empty dates produce null. */
function deriveCareerContext(
  roles: Array<{ start?: string }>,
  education: Array<{ degree?: string; start?: string; end?: string }>,
) {
  const undergradYears = education
    .filter((entry) => isUndergrad(entry.degree))
    .map((entry) => yearOf(entry.end) ?? yearOf(entry.start))
    .filter((year): year is number => year != null);
  const anyGradYears = education
    .map((entry) => yearOf(entry.end) ?? yearOf(entry.start))
    .filter((year): year is number => year != null);
  const roleYears = roles.map((role) => yearOf(role.start)).filter((year): year is number => year != null);
  const graduationYear = undergradYears.length
    ? Math.min(...undergradYears)
    : anyGradYears.length
      ? Math.min(...anyGradYears)
      : null;
  const firstRoleYear = roleYears.length ? Math.min(...roleYears) : null;
  const anchor = [graduationYear, firstRoleYear].filter((year): year is number => year != null).sort()[0];
  if (!anchor) return null;
  const now = new Date().getFullYear();
  return {
    graduationYear,
    firstRoleYear,
    yearsOfCareer: Math.max(0, now - anchor),
    assumedGradAge: 22,
    approxCurrentAge: graduationYear ? 22 + (now - graduationYear) : null,
  };
}

async function loadApp(): Promise<AppModules> {
  if (app) return app;
  const store = await import("../src/lib/triage/store.ts");
  const load = await import("../src/lib/triage/load.ts");
  const score = await import("../src/lib/scoring/run-score.ts");
  const batch = await import("../src/lib/analysis/batch.ts");
  const sync = await import("../src/lib/sync/workable-sync.ts");
  const fingerprint = await import("../src/lib/analysis/fingerprint.ts");
  const models = await import("../src/lib/ai/models.ts");
  const method = await import("../src/lib/evaluation/method.ts");
  const rubric = await import("../src/lib/rubric/service.ts");
  const jobs = await import("../src/lib/rubric/store.ts");
  const calibration = await import("../src/lib/calibration/service.ts");
  const seat = await import("../src/lib/jobs/seat-context.ts");
  const rescore = await import("../src/lib/sync/rescore.ts");
  const readiness = await import("../src/lib/triage/readiness.ts");
  app = {
    upsertWorkingFile: store.upsertWorkingFile,
    getWorkingFile: store.getWorkingFile,
    loadOneCandidate: load.loadOneCandidate,
    scoreCandidate: score.scoreCandidate as AppModules["scoreCandidate"],
    processCanonicalAnalysisBatches: batch.processCanonicalAnalysisBatches,
    scoreUnscoredAcrossJobs: sync.scoreUnscoredAcrossJobs,
    analysisFingerprint: fingerprint.analysisFingerprint,
    CLAUDE_JUDGMENT_MODEL: models.CLAUDE_JUDGMENT_MODEL,
    getActiveMethodDoc: method.getActiveMethodDoc,
    getActiveRubric: rubric.getActiveRubric,
    getCalibrationForJob: calibration.getCalibrationForJob,
    getJobRubric: jobs.getJobRubric,
    buildSeatContext: seat.buildSeatContext as AppModules["buildSeatContext"],
    loadInterviewEvidenceText: rescore.loadInterviewEvidenceText,
    loadRecruiterCommentsText: rescore.loadRecruiterCommentsText,
    computeReadiness: readiness.computeReadiness as AppModules["computeReadiness"],
  };
  return app;
}

function seedJob(): void {
  memorySupabase.rows("jobs").push({
    shortcode: JOB,
    title: "Clinical Data Manager",
    department: "Clinical Operations",
    location: "Van Nuys, CA",
    raw: {
      full_description:
        "Own database lock, query reconciliation, and deviation narratives for diagnostic studies. The seat takes execution off the founders.",
    },
  });
}

async function pinReject(candidateId: string): Promise<void> {
  const modules = await loadApp();
  // Same two writes as setDecision: store the pin, then re-save the case file
  // without a model read. That second write must not be what clears the pin.
  await modules.upsertWorkingFile(
    candidateId,
    {
      workspace: { decisionOverride: "reject" },
      read: {
        decision: "reject",
        why: "Reviewer marked do-not-interview.",
        risk: "Reviewer pin.",
        next: "Reject",
        value: { headline: "—", level: "none", detail: "" },
        recalculatedAt: "2026-02-01T00:00:00.000Z",
        model: "human",
      },
    },
    "Reviewer",
  );
  await modules.upsertWorkingFile(candidateId, { content: `# Candidate: ${candidateId}\n` }, "Reviewer");
  const stored = await modules.getWorkingFile(candidateId);
  assert.equal(stored?.workspace.decisionOverride, "reject");
}

async function seedCandidate(candidateId: string, createdAt: string): Promise<void> {
  memorySupabase.rows("candidates").push({
    workable_id: candidateId,
    job_shortcode: JOB,
    name: "Casey Morgan",
    email: null,
    phone: null,
    location: "Los Angeles, CA",
    stage: "Applied",
    stage_kind: null,
    disqualified: false,
    source: null,
    assignee_id: null,
    raw: null,
    photo_url: null,
    created_at: createdAt,
    synced_at: createdAt,
  });
  memorySupabase.rows("applications").push({
    candidate_id: candidateId,
    answers: {
      "Tell us about a database you locked":
        "I reconciled the open queries, wrote the deviation narrative, and locked the database before the next monitoring visit.",
    },
    cover_letter: null,
    parsed_experience: [],
    parsed_education: [],
    resume_text: RESUME,
    resume_url: null,
    resume_storage_path: null,
    resume_parsed: null,
  });
}

/** Fingerprint of the evaluator input scoreCandidate builds for this fixture. */
async function inputHash(candidateId: string): Promise<string> {
  const modules = await loadApp();
  const candidate = memorySupabase.rows("candidates").find((row) => row.workable_id === candidateId);
  const application = memorySupabase.rows("applications").find((row) => row.candidate_id === candidateId);
  if (!candidate || !application) throw new Error(`missing fixture rows for ${candidateId}`);

  const experience: Array<{ start?: string }> = [];
  const education: Array<{ degree?: string; start?: string; end?: string }> = [];
  const interviewEvidence = await modules.loadInterviewEvidenceText(candidateId);
  const recruiterComments = await modules.loadRecruiterCommentsText(candidateId);
  const workingFile = await modules.getWorkingFile(candidateId);
  const workspaceTranscript = "";
  const correctionContext = "";
  const replyContext = "";
  const [method, rubric, calibration, jobRubric] = await Promise.all([
    modules.getActiveMethodDoc(),
    modules.getActiveRubric(JOB),
    modules.getCalibrationForJob(JOB),
    modules.getJobRubric(JOB),
  ]);
  const readiness = modules.computeReadiness({
    candidateId,
    jobShortcode: JOB,
    answers: application.answers,
    resumeText: application.resume_text,
    resumeStoragePath: null,
    resumeUrl: null,
    coverLetter: application.cover_letter,
    parsedExperienceCount: 0,
    jobSpec: jobRubric.specMd,
    rubric: jobRubric.rubricMd,
    methodology: method.markdown,
  });
  assert.equal(readiness.ready, true, `fixture is not gradeable: ${readiness.missing.join(",")}`);

  const job = memorySupabase.rows("jobs").find((row) => row.shortcode === JOB);
  const seat = modules.buildSeatContext({
    shortcode: JOB,
    title: (job?.title as string) ?? "the open seat",
    department: job?.department,
    location: job?.location,
    raw: job?.raw,
  });
  return modules.analysisFingerprint({
    candidateId,
    model: modules.CLAUDE_JUDGMENT_MODEL,
    input: {
      name: candidate.name ?? "Candidate",
      resumeText: application.resume_text,
      roles: experience,
      answers: application.answers,
      coverLetter: application.cover_letter,
      interviewEvidence: [interviewEvidence, workspaceTranscript].filter(Boolean).join("\n\n"),
      recruiterComments: [recruiterComments, correctionContext, replyContext].filter(Boolean).join("\n"),
      publicProfile: null,
      seat,
      weights: rubric.weights,
      dimensions: rubric.dimensions,
      rubricSchemaVersion: rubric.schemaVersion,
      method: method.markdown,
      methodologyVersion: method.version,
      rubricGuidance: rubric.rawMd,
      globalCalibration: calibration.global,
      roleCalibration: calibration.role,
      careerContext: deriveCareerContext(experience, education),
    },
  });
}

async function queueCompletedAnalysis(candidateId: string): Promise<void> {
  const modules = await loadApp();
  memorySupabase.rows("candidate_analyses").push({
    id: `analysis_${candidateId}`,
    candidate_id: candidateId,
    input_hash: await inputHash(candidateId),
    status: "completed",
    trigger: "new_candidate",
    model: modules.CLAUDE_JUDGMENT_MODEL,
    input_snapshot: {},
    result: interviewEvaluation(),
    error: null,
    batch_id: `batch_${candidateId}`,
    attempt_count: 1,
    requested_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T01:00:00.000Z",
    projected_at: null,
    projection_started_at: null,
  });
}

async function expectRejectStillWins(candidateId: string, label: string): Promise<void> {
  const modules = await loadApp();
  const stored = await modules.getWorkingFile(candidateId);
  const one = await modules.loadOneCandidate(candidateId);
  const override = stored?.workspace.decisionOverride ?? null;
  const decision = one?.candidate.decision ?? null;
  const detail = `${label}: stored pin=${JSON.stringify(override)} pool=${decision}`;
  const clearedPin = memorySupabase.upserts.filter((entry) => {
    if (entry.table !== "candidate_working_files" || entry.row.candidate_id !== candidateId) return false;
    const workspace = entry.row.workspace as { decisionOverride?: unknown } | undefined;
    return workspace != null && "decisionOverride" in workspace && workspace.decisionOverride == null;
  });
  assert.equal(
    clearedPin.length,
    0,
    `${detail}; an automatic score wrote an empty manual decision`,
  );
  assert.equal(override, "reject", detail);
  assert.equal(decision, "reject", detail);
}

describe("manual hiring decision survives an automatic score", { concurrency: 1 }, () => {
  beforeEach(() => {
    memorySupabase.reset();
    seedJob();
  });

  test("projecting an already queued model read keeps a reject pin", async () => {
    const modules = await loadApp();
    const candidateId = "cand_batch_projection";
    await seedCandidate(candidateId, "2026-01-15T00:00:00.000Z");
    await pinReject(candidateId);
    const hash = await inputHash(candidateId);
    const result = await modules.scoreCandidate(candidateId, {
      force: true,
      replace: true,
      evaluation: interviewEvaluation(),
      expectedInputHash: hash,
      trigger: "batch_projection",
    });
    assert.equal(
      "obsolete" in result && result.obsolete,
      false,
      `queued score did not match the candidate, so the pin was never at risk: ${JSON.stringify(result)}`,
    );
    await expectRejectStillWins(candidateId, "batch_projection scoreCandidate");
  });

  test("the analysis-batch cron keeps a reject pin when it projects a finished score", async () => {
    const modules = await loadApp();
    const candidateId = "cand_batch_cron";
    await seedCandidate(candidateId, "2026-01-15T00:00:00.000Z");
    await pinReject(candidateId);
    await queueCompletedAnalysis(candidateId);
    await modules.processCanonicalAnalysisBatches();
    const projected = memorySupabase
      .rows("candidate_analyses")
      .find((row) => row.candidate_id === candidateId);
    assert.notEqual(
      projected?.status,
      "obsolete",
      "queued score did not match the candidate, so the batch cron never applied it",
    );
    await expectRejectStillWins(candidateId, "processCanonicalAnalysisBatches");
  });

  test("a scoring-epoch pass keeps a reject pin", async () => {
    const modules = await loadApp();
    const candidateId = "cand_scoring_epoch";
    await seedCandidate(candidateId, "2025-12-01T00:00:00.000Z");
    await pinReject(candidateId);
    await queueCompletedAnalysis(candidateId);
    memorySupabase.rows("evaluations").push({
      id: "fit_old",
      candidate_id: candidateId,
      kind: "fit_read",
      ref: JOB,
      payload: {
        reply: "Reviewer already cut this file.",
        sentiment: "negative",
        appliedFit: "",
        rdiFit: "",
        suggestedSeat: "",
      },
      model_version: "claude-sonnet-5",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    memorySupabase.rows("sync_state").push({
      key: "scoring_epoch:global",
      value: { at: "2026-11-01T00:00:00.000Z" },
    });
    await modules.scoreUnscoredAcrossJobs({ budgetMs: 20_000, concurrency: 1 });
    const analysis = memorySupabase
      .rows("candidate_analyses")
      .find((row) => row.candidate_id === candidateId);
    assert.notEqual(
      analysis?.status,
      "obsolete",
      "queued score did not match the candidate, so the scoring-epoch pass never applied it",
    );
    await expectRejectStillWins(candidateId, "scoreUnscoredAcrossJobs");
  });

  test("the re-grade cron's skip does not save a pin from the trailing projector", async () => {
    const modules = await loadApp();
    const candidateId = "cand_reanalyze_cron";
    await seedCandidate(candidateId, "2026-01-15T00:00:00.000Z");
    await pinReject(candidateId);
    await queueCompletedAnalysis(candidateId);
    const route = await import("../src/app/api/cron/reanalyze/route.ts");
    const { NextRequest } = await import("next/server");
    const response = await route.GET(
      new NextRequest(`http://localhost/api/cron/reanalyze?job=${JOB}&budgetMs=5000`),
    );
    const body = (await response.json()) as { skippedOverride?: number; error?: string };
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.skippedOverride, 1, JSON.stringify(body));
    await expectRejectStillWins(candidateId, "reanalyze cron");
  });
});
