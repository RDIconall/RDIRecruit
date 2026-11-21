import assert from "node:assert/strict";
import test from "node:test";
import { decisionReadFromEvaluation } from "../analysis/decision";
import { buildSeatContext } from "../jobs/seat-context";
import { parseEvaluatorMessage, type EvaluatorInput, type EvaluatorOutput } from "../scoring/evaluator";
import type { CandidateRow, CategoryKey, ScoreRow } from "../types";
import { poolGroupOf } from "./app-theme";
import { deriveDecision, deriveDecisionDetail, mapCandidate, type MapInput } from "./from-supabase";
import { parseFitRead, fitReadFromEvaluation, type FitRead } from "./fit-read";
import { sortBestNew } from "./ranking";

/**
 * Spec for the board decision after a public applicant is graded.
 *
 * The grader is instructed to keep the integrity gate out of the seat verdict.
 * These tests run that grader JSON through the same functions the batch scorer
 * and the triage loader use, then require the Good / interview list to exclude
 * a failed integrity gate or a dig-in integrity value that starts with "material".
 * A positive fit sentiment must not win over either stored signal.
 */

const WEIGHTS: Record<CategoryKey, number> = {
  principal: 25,
  environment: 20,
  scope: 20,
  writing: 15,
  tenure: 10,
  local: 10,
};

const APPLICANT: EvaluatorInput = {
  name: "Alex Applicant",
  resumeText:
    "Clinical research associate, Northwind Labs, 2016-present. Claims a California CLS license and lead monitoring on a Phase III oncology study.",
  roles: [
    {
      title: "Clinical Research Associate",
      company: "Northwind Labs",
      start: "2016-01",
      current: true,
      summary: "Monitored phase III studies.",
    },
  ],
  answers: {
    "Describe a monitoring issue you owned.":
      "I closed a protocol deviation at a site I say I monitored in 2022.",
  },
  coverLetter: "I am applying to the posted clinical research associate seat.",
  seat: buildSeatContext({
    shortcode: "CRA1",
    title: "Clinical Research Associate",
    location: "Van Nuys, CA",
  }),
  weights: WEIGHTS,
};

function graderMessage(grade: Record<string, unknown>) {
  return {
    stop_reason: "end_turn" as const,
    content: [{ type: "text" as const, text: JSON.stringify(grade) }],
  };
}

function fullMarks() {
  return { principal: 25, environment: 20, scope: 20, writing: 15, tenure: 10, local: 10 };
}

/** Grader JSON in the shape the seat brief asks for: seat verdict and integrity gate are separate fields. */
function gradePayload(over: Record<string, unknown> = {}) {
  return {
    personQuality: "high",
    seatFit: {
      appliedSeat: "Clinical Research Associate",
      verdict: "strong_seat",
      score: 92,
      summary: "Monitoring record matches this posting.",
    },
    categoryScores: fullMarks(),
    integrityGate: { status: "clear", note: "" },
    otherGateResults: [],
    summary: "Seat fit is strong on the monitoring record.",
    salaryAsk: "$140k",
    salaryValue: "justified",
    confidence: "high",
    verification: { read: "Clean", claims: [] },
    answerGrades: [
      {
        question: "Describe a monitoring issue you owned.",
        verdict: "OWNED",
        present: ["deviation closeout"],
        note: "Names a closeout.",
        kind: "screen",
      },
    ],
    digIn: {
      quality: "Good",
      mix: "1 owned",
      integrity: "Clear",
      integrityNote: "",
      careerRead: "Monitoring lead since 2016.",
      resolve: [],
    },
    triage: { why: "Owned monitoring delivery on the materials for this seat." },
    ...over,
  };
}

function evaluate(over: Record<string, unknown> = {}): EvaluatorOutput {
  const evaluation = parseEvaluatorMessage(graderMessage(gradePayload(over)), APPLICANT);
  assert.ok(evaluation, "grader JSON must normalize into a canonical evaluation");
  assert.equal(evaluation.heuristic, undefined);
  return evaluation;
}

/**
 * The rows scoreCandidate writes and loadTriagePool reads back:
 * scores.gate_results, evaluations.dig_in, evaluations.fit_read, working-file read.
 * Fit sentiment is the list read the scorer stores (run-score.ts), unless a test
 * passes a stored sentiment the board must still refuse.
 */
function boardInput(
  evaluation: EvaluatorOutput,
  options: { sentiment?: FitRead["sentiment"]; appliedAt?: string; id?: string } = {},
): { input: MapInput; fit: FitRead; canonicalDecision: string } {
  const canonical = decisionReadFromEvaluation(evaluation, false, "test-model");
  const projected = fitReadFromEvaluation({
    ...evaluation,
    triage: {
      why: canonical.why || evaluation.triage.why || evaluation.summary,
    },
  });
  assert.ok(projected, "a graded file with a why-line stores a fit read");
  const fit = parseFitRead({
    ...projected,
    sentiment: options.sentiment ?? projected.sentiment,
  });
  assert.ok(fit, "stored fit_read payload must parse");

  const candidate: CandidateRow = {
    workable_id: options.id ?? "cand_integrity",
    job_shortcode: "CRA1",
    name: "Alex Applicant",
    email: null,
    phone: null,
    location: "Los Angeles, CA",
    stage: "Applied",
    stage_kind: null,
    disqualified: false,
    source: "careers page",
    assignee_id: null,
    raw: null,
    photo_url: null,
    created_at: options.appliedAt ?? "2026-11-20T00:00:00.000Z",
    synced_at: "2026-11-20T00:00:00.000Z",
  };

  const score: ScoreRow = {
    id: "score_integrity",
    candidate_id: candidate.workable_id,
    rubric_version: 1,
    category_scores: evaluation.categoryScores,
    gate_results: {
      integrity: evaluation.integrityGate,
      other: evaluation.otherGateResults,
      capReasons: evaluation.capReasons,
    },
    total: evaluation.total,
    salary_value: evaluation.salaryValue,
    confidence: evaluation.confidence,
    model_version: "test-model",
    created_at: "2026-11-20T00:00:00.000Z",
  };

  const input: MapInput = {
    candidate,
    score,
    ro: null,
    overlay: null,
    application: {
      answers: APPLICANT.answers,
      cover_letter: APPLICANT.coverLetter ?? null,
      parsed_experience: APPLICANT.roles,
      resume_text: APPLICANT.resumeText,
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
      fitRead: fit,
    },
    interviewEvidence: [],
    read: canonical,
    rank: 1,
    jobLocation: "Van Nuys, CA",
    jobShortcode: "CRA1",
    jobTitle: "Clinical Research Associate",
  };

  return { input, fit, canonicalDecision: canonical.decision };
}

function listed(evaluation: EvaluatorOutput, options?: { sentiment?: FitRead["sentiment"]; appliedAt?: string; id?: string }) {
  const { input, fit, canonicalDecision } = boardInput(evaluation, options);
  const detail = deriveDecisionDetail(input);
  const decision = deriveDecision(input);
  const view = mapCandidate(input);
  assert.equal(decision, detail.decision);
  assert.equal(view.decision, detail.decision);
  return { input, fit, canonicalDecision, detail, view };
}

function honestInterview(): ReturnType<typeof mapCandidate> {
  const evaluation = evaluate();
  const { view } = listed(evaluation, { id: "cand_clear", appliedAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(view.decision, "interview");
  return view;
}

const FAILED_GATE = {
  status: "fail",
  concern: "POSSIBLE_MISREPRESENTATION",
  note: "Résumé claims a California CLS license that the application record does not support.",
};

test("strong seat verdict plus a failed integrity gate stays off the interview list", () => {
  const evaluation = evaluate({
    integrityGate: FAILED_GATE,
    digIn: {
      quality: "Good",
      mix: "1 owned",
      integrity: "Material",
      integrityNote: "Claims a CLS license the application record does not support.",
      careerRead: "Monitoring lead since 2016.",
      resolve: ["Confirm the license before any interview."],
    },
  });

  assert.equal(evaluation.seatFit.verdict, "strong_seat");
  assert.equal(evaluation.integrityGate.status, "fail");
  assert.ok(evaluation.total <= 54);

  const { fit, view } = listed(evaluation, { appliedAt: "2026-11-21T00:00:00.000Z" });
  assert.equal(fit.sentiment, "good");
  assert.equal(view.decision, "reject");
  assert.equal(poolGroupOf(view.decision), "reject");
  assert.equal(view.survivor, false);
  assert.ok(view.redFlags.some((flag) => flag.flag === "Integrity"));

  const ordered = sortBestNew([view, honestInterview()]);
  assert.equal(ordered[0].id, "cand_clear");
  assert.notEqual(ordered[0].id, view.id);
});

test("viable seat verdict plus a failed integrity gate stays off the interview list", () => {
  const evaluation = evaluate({
    personQuality: "solid",
    seatFit: {
      appliedSeat: "Clinical Research Associate",
      verdict: "viable_seat",
      score: 78,
      summary: "Viable on this posting.",
    },
    integrityGate: FAILED_GATE,
  });
  assert.equal(evaluation.seatFit.verdict, "viable_seat");
  assert.equal(evaluation.integrityGate.status, "fail");
  const { fit, view } = listed(evaluation);
  assert.equal(fit.sentiment, "good");
  assert.equal(view.decision, "reject");
  assert.notEqual(poolGroupOf(view.decision), "interview");
});

test("routing seat verdict plus a failed integrity gate stays off the interview list", () => {
  const evaluation = evaluate({
    personQuality: "high",
    seatFit: {
      appliedSeat: "Clinical Research Associate",
      verdict: "routing",
      score: null,
      summary: "Strong person, wrong posting.",
    },
    integrityGate: FAILED_GATE,
  });
  assert.equal(evaluation.seatFit.verdict, "routing");
  assert.equal(evaluation.integrityGate.status, "fail");
  const { fit, view } = listed(evaluation);
  assert.equal(fit.sentiment, "good");
  assert.equal(view.decision, "reject");
  assert.notEqual(poolGroupOf(view.decision), "interview");
});

test("material dig-in integrity stays off the interview list when the gate is clear and the fit is good", () => {
  const evaluation = evaluate({
    integrityGate: { status: "clear", note: "" },
    digIn: {
      quality: "Good",
      mix: "1 owned",
      integrity: "Material — résumé dates do not support the claimed license",
      integrityNote: "Employment dates and the claimed CLS license do not match.",
      careerRead: "Monitoring lead since 2016.",
      resolve: ["Resolve the license claim."],
    },
  });
  assert.equal(evaluation.seatFit.verdict, "strong_seat");
  assert.equal(evaluation.integrityGate.status, "clear");
  assert.ok(evaluation.digIn.integrity.toLowerCase().startsWith("material"));

  const { fit, canonicalDecision, view } = listed(evaluation, { appliedAt: "2026-11-21T00:00:00.000Z" });
  assert.equal(fit.sentiment, "good");
  assert.equal(canonicalDecision, "interview");
  assert.equal(view.decision, "reject");
  assert.equal(view.survivor, false);
  assert.equal(poolGroupOf(view.decision), "reject");
  assert.ok(view.redFlags.some((flag) => flag.flag === "Integrity"));

  const ordered = sortBestNew([view, honestInterview()]);
  assert.equal(ordered[0].id, "cand_clear");
});

test("a stored good fit read still loses to a failed integrity gate when dig-in integrity is clear", () => {
  const evaluation = evaluate({
    integrityGate: FAILED_GATE,
    digIn: {
      quality: "Good",
      mix: "1 owned",
      integrity: "Clear",
      integrityNote: "",
      careerRead: "Monitoring lead since 2016.",
      resolve: [],
    },
  });
  assert.equal(evaluation.digIn.integrity, "Clear");
  assert.equal(evaluation.integrityGate.status, "fail");
  assert.equal(evaluation.seatFit.verdict, "strong_seat");

  const { fit, view } = listed(evaluation, { sentiment: "good" });
  assert.equal(fit.sentiment, "good");
  assert.equal(view.decision, "reject");
  assert.notEqual(poolGroupOf(view.decision), "interview");
  assert.equal(
    view.redFlags.some((flag) => flag.flag === "Integrity"),
    false,
  );
});

test("an integrity concern without a material dig-in finding stays on the interview list", () => {
  const evaluation = evaluate({
    integrityGate: { status: "concern", concern: "INTEGRITY_CONCERN_HIGH", note: "Verify a date live." },
    digIn: {
      quality: "Good",
      mix: "1 owned",
      integrity: "Minor",
      integrityNote: "One date to confirm live.",
      careerRead: "Monitoring lead since 2016.",
      resolve: ["Confirm the date."],
    },
  });
  assert.equal(evaluation.seatFit.verdict, "strong_seat");
  const { fit, view } = listed(evaluation);
  assert.equal(fit.sentiment, "good");
  assert.equal(view.decision, "interview");
  assert.equal(poolGroupOf(view.decision), "interview");
});
