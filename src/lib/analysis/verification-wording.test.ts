/**
 * Spec for the verification-wording gate.
 *
 * These tests fail while a verification sentence is treated as a contradiction
 * whenever it contains "discrepancy" or "material". They pass once that prose
 * no longer sets the hold, the "Hold as backup" next step, the
 * confirm-the-discrepancy caveat, or the Contradiction label. A claim whose
 * verdict is DISCREPANCY still does.
 *
 * The grader is stood in at the model-message boundary. Every step after that
 * — parse, normalize, decision, fit projection, dossier mapping — is the
 * product code the scorer runs.
 */
import { createRequire } from "node:module";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { buildSeatContext } from "../jobs/seat-context.ts";
import { decisionLabelForPhase } from "../triage/pipeline-phase.ts";
import { mapCandidate, type MapInput } from "../triage/from-supabase.ts";
import { fitReadFromEvaluation } from "../triage/fit-read.ts";
import type { CandidateRow, ScoreRow, VerificationPayload } from "../types.ts";
import { decisionReadFromEvaluation } from "./decision.ts";
import type { EvaluatorInput, EvaluatorOutput } from "../scoring/evaluator.ts";

// evaluator.ts logs through grade-log, which imports the server-only marker.
// Next maps that marker to an empty module; node:test does not, so point the
// marker at the package's empty build before loading the grader.
const require = createRequire(import.meta.url);
const Module = require("module") as {
  _resolveFilename: (request: string, parent: unknown, isMain: boolean, options: unknown) => string;
};
const serverOnlyEmpty = path.join(path.dirname(require.resolve("server-only")), "empty.js");
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "server-only") return serverOnlyEmpty;
  return resolveFilename.call(this, request, parent, isMain, options);
};

type EvaluatorModule = typeof import("../scoring/evaluator.ts");
let evaluatorModule: EvaluatorModule | undefined;
async function evaluator(): Promise<EvaluatorModule> {
  if (!evaluatorModule) evaluatorModule = await import("../scoring/evaluator.ts");
  return evaluatorModule;
}

const CONFIRM = "Confirm the flagged discrepancy before booking an interview.";
const HOLD_NEXT = "Hold as backup";

const CLEAN_SENTENCES = [
  "No material discrepancy",
  "no material discrepancy",
  "NO MATERIAL DISCREPANCY",
  "Clean — no material discrepancy between the résumé and the profile.",
  "The materials are consistent; there is no discrepancy.",
  "immaterial differences only",
  "Nothing material to reconcile.",
  "Material discrepancies were not found.",
  "Clean|Minor flags|Material discrepancy|Unverified (no profile)",
];

const ALLOWED_CLEAN_LABELS = ["Clean", "Minor flags", "Unverified (no profile)", "clean", "MINOR FLAGS"];

function evaluatorInput(): EvaluatorInput {
  return {
    name: "Avery Applicant",
    resumeText:
      "Clinical data manager. Owned query resolution and source-data checks. No material discrepancy between sites.",
    roles: [
      {
        title: "Clinical Data Manager",
        company: "North Lab",
        start: "2018-01",
        end: null,
        current: true,
        summary: "Owned query resolution for two device studies.",
      },
    ],
    answers: {
      "Walk through a query you closed.":
        "I locked the listing, wrote the query, and confirmed the source before the next visit.",
    },
    coverLetter: "I have run source-data verification on device studies.",
    publicProfile: "Profile matches the résumé. No material discrepancy.",
    seat: buildSeatContext({ shortcode: "JOB1", title: "Clinical Data Manager", location: "Van Nuys, CA" }),
    weights: { principal: 20, environment: 20, scope: 20, writing: 15, tenure: 15, local: 10 },
  };
}

function modelMessage(
  verificationRead: string,
  claims: VerificationPayload["claims"],
): { content: Array<{ type: "text"; text: string }>; stop_reason: "end_turn" } {
  const body = {
    categoryScores: { principal: 20, environment: 20, scope: 20, writing: 15, tenure: 15, local: 10 },
    personQuality: "high",
    seatFit: {
      appliedSeat: "Clinical Data Manager",
      verdict: "strong_seat",
      score: 90,
      summary: "Owns monitoring on this posting.",
    },
    integrityGate: { status: "clear", note: "" },
    otherGateResults: [],
    salaryValue: "justified",
    salaryAsk: "$140k",
    summary: "Owns the monitoring plan end to end.",
    complement: "technician",
    confidence: "high",
    answerGrades: [
      {
        question: "Walk through a query you closed.",
        verdict: "OWNED",
        note: "Named the lock, the query, and the source check.",
        kind: "screen",
      },
    ],
    verification: { read: verificationRead, claims, questions: [], actions: [] },
    triage: {
      why: "Owns the monitoring plan end to end.",
      risk: "Confirm the commute.",
      caveat: "",
    },
    digIn: {
      quality: "Good",
      mix: "1 owned",
      integrity: "Clear",
      integrityNote: "",
      careerRead: "Steady progression in clinical data.",
      resolve: [],
    },
  };
  return {
    stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify(body) }],
  };
}

function confirmedClaim(): VerificationPayload["claims"][number] {
  return {
    category: "scope",
    application: "Owned query resolution",
    profile: "Profile lists query resolution",
    verdict: "CONFIRMED",
    note: "The words material and discrepancy appear only as a denial that any gap exists.",
  };
}

function discrepancyClaim(): VerificationPayload["claims"][number] {
  return {
    category: "tenure",
    application: "2018–present at North Lab",
    profile: "Profile shows a gap in 2019",
    verdict: "DISCREPANCY",
    note: "Dates do not match.",
  };
}

const candidateRow: CandidateRow = {
  workable_id: "cand_wording",
  job_shortcode: "JOB1",
  name: "Avery Applicant",
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
  created_at: "2026-06-01T00:00:00.000Z",
  synced_at: "2026-06-01T00:00:00.000Z",
};

async function project(verificationRead: string, claims: VerificationPayload["claims"], postInterview = false) {
  const { parseEvaluatorMessage } = await evaluator();
  const input = evaluatorInput();
  const evaluation = parseEvaluatorMessage(modelMessage(verificationRead, claims), input);
  assert.ok(evaluation, "grader JSON must parse into an evaluation");
  const decisionRead = decisionReadFromEvaluation(evaluation, postInterview, "test-model");
  // Same projection run-score writes onto the fit_read row after the decision read.
  const fitRead = fitReadFromEvaluation({
    ...evaluation,
    triage: {
      why: decisionRead.why || evaluation.triage.why || evaluation.summary,
    },
  });
  assert.ok(fitRead, "a strong seat read must project a fit row");
  const view = mapCandidate(dossierInput(evaluation, decisionRead, fitRead));
  return { evaluation, decisionRead, fitRead, view };
}

function dossierInput(
  evaluation: EvaluatorOutput,
  decisionRead: ReturnType<typeof decisionReadFromEvaluation>,
  fitRead: NonNullable<ReturnType<typeof fitReadFromEvaluation>>,
): MapInput {
  const score: ScoreRow = {
    id: "score_wording",
    candidate_id: "cand_wording",
    rubric_version: 1,
    category_scores: evaluation.categoryScores,
    total: evaluation.total,
    salary_value: evaluation.salaryValue,
    confidence: evaluation.confidence,
    model_version: "test-model",
    created_at: "2026-06-01T00:00:00.000Z",
  };
  return {
    candidate: candidateRow,
    score,
    ro: null,
    overlay: null,
    application: {
      answers: evaluatorInput().answers,
      cover_letter: "I have run source-data verification on device studies.",
      parsed_experience: [],
      resume_text: evaluatorInput().resumeText,
    },
    narrative: [],
    evals: {
      invest: {
        complement: evaluation.complement,
        head: evaluation.investHead,
        removes: evaluation.complementRemoves,
        vector: evaluation.salaryVector,
        summary: evaluation.summary,
        ask: evaluation.salaryAsk,
      },
      dig: evaluation.digIn,
      verification: evaluation.verification,
      roleReads: [],
      answerGrades: evaluation.answerGrades,
      fitRead,
    },
    interviewEvidence: [],
    read: decisionRead,
    rank: 1,
    jobLocation: "Van Nuys, CA",
    jobShortcode: "JOB1",
  };
}

test("applicant materials reach the grader prompt that asks for a verification label", async () => {
  const { buildEvaluatorRequest } = await evaluator();
  const input = evaluatorInput();
  const request = buildEvaluatorRequest(input);
  const user = request.messages[0]?.content;
  assert.equal(typeof user, "string");
  assert.match(user as string, /No material discrepancy between sites/);
  const system = request.system.map((block) => ("text" in block ? block.text : "")).join("\n");
  assert.match(system, /Clean\|Minor flags\|Material discrepancy\|Unverified \(no profile\)/);
});

test("a clean verification sentence does not hold an interview-ready applicant", async () => {
  for (const sentence of CLEAN_SENTENCES) {
    const { evaluation, decisionRead, fitRead, view } = await project(sentence, [confirmedClaim()]);
    assert.equal(evaluation.verification.claims.some((claim) => claim.verdict === "DISCREPANCY"), false, sentence);
    assert.equal(fitRead!.sentiment, "good", sentence);
    assert.equal(decisionRead.decision, "interview", sentence);
    assert.equal(decisionRead.next, "Interview", sentence);
    assert.equal(decisionLabelForPhase(view.decision, "triage"), "Good", sentence);
    assert.equal(view.decision, "interview", sentence);
    assert.equal(view.next, "Interview", sentence);
    assert.notEqual(view.next, HOLD_NEXT, sentence);
    assert.notEqual(view.caveat, CONFIRM, sentence);
    assert.equal(view.mismatch, false, sentence);
    assert.equal(view.mismatchLabel, undefined, sentence);
    assert.equal(
      view.redFlags.some((flag) => /discrepancy/i.test(flag.flag)),
      false,
      sentence,
    );
  }
});

test("allowed clean labels are not discrepancies", async () => {
  for (const label of ALLOWED_CLEAN_LABELS) {
    const { decisionRead, view } = await project(label, [confirmedClaim()]);
    assert.equal(decisionRead.decision, "interview", label);
    assert.equal(decisionRead.next, "Interview", label);
    assert.equal(view.next, "Interview", label);
    assert.notEqual(view.caveat, CONFIRM, label);
    assert.equal(view.mismatchLabel, undefined, label);
  }
});

test("prose inside a confirmed claim is not a discrepancy", async () => {
  const { decisionRead, view } = await project("Clean", [
    {
      ...confirmedClaim(),
      application: "No material discrepancy in the dates I listed",
      note: "Reviewed for a material discrepancy and found none.",
    },
  ]);
  assert.equal(decisionRead.decision, "interview");
  assert.equal(decisionRead.next, "Interview");
  assert.equal(view.next, "Interview");
  assert.notEqual(view.caveat, CONFIRM);
  assert.equal(view.mismatchLabel, undefined);
});

test("post-interview next step stays an advance when the sentence is a negation", async () => {
  const { decisionRead } = await project("No material discrepancy", [confirmedClaim()], true);
  assert.equal(decisionRead.decision, "interview");
  assert.equal(decisionRead.next, "Advance to next round");
  assert.notEqual(decisionRead.next, "Hold — do not advance yet");
});

test("a stored hold is not kept once a fit read calls the file good", async () => {
  const { view } = await project("No material discrepancy", [confirmedClaim()]);
  assert.equal(view.decision, "interview");
  assert.equal(decisionLabelForPhase(view.decision, "triage"), "Good");
  assert.equal(view.next, "Interview");
  assert.ok(!view.caveat || !/discrepancy/i.test(view.caveat));
});

test("a negative fit is not filed as an evidence cut because the sentence says no discrepancy", async () => {
  const { parseEvaluatorMessage } = await evaluator();
  const input = evaluatorInput();
  const evaluation = parseEvaluatorMessage(modelMessage("No material discrepancy", [confirmedClaim()]), input);
  assert.ok(evaluation);
  const decisionRead = decisionReadFromEvaluation(evaluation, false, "test-model");
  const fitRead = fitReadFromEvaluation({
    ...evaluation,
    personQuality: "weak",
    seatFit: { ...evaluation.seatFit, verdict: "pass" },
    triage: { why: decisionRead.why || evaluation.summary },
  });
  assert.equal(fitRead?.sentiment, "negative");
  const view = mapCandidate(
    dossierInput(evaluation, decisionRead, fitRead!),
  );
  assert.equal(view.decision, "reject");
  assert.notEqual(view.cutGroup, "evidence");
  assert.notEqual(view.cite, "Verification");
});

test("a DISCREPANCY claim still holds the file and adds the booking caveat", async () => {
  const { decisionRead, view } = await project("Clean", [discrepancyClaim()]);
  assert.equal(decisionRead.decision, "backup");
  assert.equal(decisionRead.next, HOLD_NEXT);
  assert.equal(view.caveat, CONFIRM);
  assert.equal(view.mismatch, true);
  assert.equal(view.mismatchLabel, "Contradiction");
  assert.equal(view.next, HOLD_NEXT);
  assert.ok(view.redFlags.some((flag) => flag.flag === "tenure discrepancy"));
});
