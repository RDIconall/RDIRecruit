/**
 * Spec for fail-open hiring gates.
 *
 * These tests fail while person quality and integrity/other-gate tokens are
 * kept only on an exact lowercase match and everything else is stored as
 * solid / clear / unknown. They pass once a missing or unrecognized person
 * quality is stored as weak, a missing or unrecognized integrity status is
 * stored as fail, recognized tokens compare case-insensitively (and ignore
 * surrounding whitespace), and those stored values are what the score cap,
 * fit read, and board decision use.
 *
 * The model reply is parsed by parseEvaluatorMessage, the same function the
 * batch collector uses before the evaluation is projected onto the board.
 * The preload import must stay first: it maps `server-only` to the empty
 * module Next loads for that package on the server (server-only@0.0.1 empty.js).
 */
import "./fail-open-gates.preload.cjs";
import assert from "node:assert/strict";
import test from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { decisionReadFromEvaluation } from "../analysis/decision.ts";
import { tierKeyFromTotal } from "../board/format.ts";
import { getBuiltinSeatRubric, MULTI_ROLE_POOL } from "../rubric/seat-rubrics.ts";
import { parseEvaluatorMessage, type EvaluatorInput, type EvaluatorOutput } from "./evaluator.ts";
import { deriveDecisionDetail, type MapInput } from "../triage/from-supabase.ts";
import { decisionFromSentiment, fitReadFromEvaluation, type FitRead } from "../triage/fit-read.ts";
import type { CandidateRow } from "../types.ts";

const routingSeat = getBuiltinSeatRubric({ shortcode: MULTI_ROLE_POOL });
if (!routingSeat) throw new Error("multi-role routing rubric missing");

const weights = {
  principal: 25,
  environment: 20,
  scope: 20,
  writing: 15,
  tenure: 10,
  local: 10,
} as const;

const input: EvaluatorInput = {
  name: "Applicant",
  resumeText: "Ran sample logistics for a multi-site study.",
  roles: [],
  answers: {
    "Tell us about a study you owned.": "I tracked shipments and updated the tracker.",
  },
  seat: {
    jobShortcode: MULTI_ROLE_POOL,
    jobTitle: routingSeat.title,
    seatStratum: "routing",
    jdSummary: routingSeat.mission,
    categoryLabels: {
      principal: "Principal",
      environment: "Environment",
      scope: "Scope",
      writing: "Writing",
      tenure: "Tenure",
      local: "Local",
    },
  },
  weights: { ...weights },
  dimensions: routingSeat.dimensions,
  rubricSchemaVersion: "seat-dimensions-v2",
};

function modelMessage(payload: Record<string, unknown>): Pick<Anthropic.Message, "content" | "stop_reason"> {
  const text = `Hiring read:\n${JSON.stringify(payload)}`;
  return {
    stop_reason: "end_turn",
    content: [{ type: "text", text, citations: null }],
  };
}

function fullScores(): Record<string, unknown> {
  return {
    rubricSchemaVersion: "seat-dimensions-v2",
    seatDimensionScores: Object.fromEntries(routingSeat!.dimensions.map((d) => [d.key, d.weight])),
    categoryScores: { ...weights },
    seatFit: {
      appliedSeat: routingSeat!.title,
      verdict: "routing",
      score: 96,
      summary: "Generic multi-role posting; route on person quality.",
    },
    summary: "High dimension scores with a hold-back on the person.",
    salaryValue: "justified",
    salaryAsk: "$180k",
    triage: { why: "The write-up is polished, but the person read is the hold-back." },
    answerGrades: [
      {
        question: "Tell us about a study you owned.",
        verdict: "SURFACE",
        note: "Names a tracker, not a decision.",
      },
    ],
  };
}

function grade(over: Record<string, unknown>): EvaluatorOutput {
  const payload = { ...fullScores(), ...over };
  const evaluation = parseEvaluatorMessage(modelMessage(payload), input);
  assert.ok(evaluation, "model reply with scores must be persisted");
  assert.notEqual(evaluation.heuristic, true);
  return evaluation;
}

const candidate: CandidateRow = {
  workable_id: "cand_public",
  job_shortcode: MULTI_ROLE_POOL,
  name: "Applicant",
  email: null,
  phone: null,
  location: null,
  stage: "Applied",
  stage_kind: null,
  disqualified: false,
  source: "careers page",
  assignee_id: null,
  raw: null,
  photo_url: null,
  created_at: "2026-06-01T00:00:00.000Z",
  synced_at: "2026-06-01T00:00:00.000Z",
};

function boardDecision(evaluation: EvaluatorOutput): string {
  const fit = fitReadFromEvaluation(evaluation);
  assert.ok(fit, "a persisted why must project a fit read");
  const decision = deriveDecisionDetail(boardInput(fit)).decision;
  assert.equal(decisionFromSentiment(fit.sentiment), decision);
  return decision;
}

function boardInput(fit: FitRead): MapInput {
  return {
    candidate,
    score: {
      id: "score_1",
      candidate_id: candidate.workable_id,
      rubric_version: 1,
      category_scores: { ...weights },
      total: 96,
      salary_value: "justified",
      confidence: "high",
      model_version: "test",
      created_at: "2026-06-01T00:00:00.000Z",
    },
    ro: null,
    overlay: null,
    application: { answers: null, cover_letter: null, parsed_experience: [] },
    narrative: [],
    evals: {
      invest: null,
      dig: null,
      verification: null,
      roleReads: [],
      answerGrades: [],
      fitRead: fit,
    },
    interviewEvidence: [],
    read: null,
    rank: 1,
    jobLocation: "Van Nuys, CA",
    jobShortcode: MULTI_ROLE_POOL,
    jobTitle: routingSeat!.title,
  };
}

function heldBack(evaluation: EvaluatorOutput) {
  assert.equal(evaluation.personQuality, "weak");
  assert.equal(evaluation.integrityGate.status, "fail");
  assert.ok(evaluation.total <= 54, `expected the integrity cap, got total ${evaluation.total}`);
  assert.ok(evaluation.capReasons.length > 0);
  assert.notEqual(tierKeyFromTotal(evaluation.total), "strong");
  assert.notEqual(evaluation.decisionBand, "STRONG");
  assert.notEqual(evaluation.decisionBand, "VIABLE");
  const fit = fitReadFromEvaluation(evaluation);
  assert.ok(fit);
  assert.notEqual(fit.sentiment, "good");
  assert.notEqual(boardDecision(evaluation), "interview");
  assert.equal(decisionReadFromEvaluation(evaluation, false, "test-model").decision, "reject");
}

test("capitalized Weak and Fail are stored as weak and fail, not interview", () => {
  heldBack(grade({ personQuality: "Weak", integrityGate: { status: "Fail", note: "Material contradiction." } }));
});

test("uppercase WEAK and FAIL are stored as weak and fail, not interview", () => {
  heldBack(grade({ personQuality: "WEAK", integrityGate: { status: "FAIL", note: "Contradiction." } }));
});

test("surrounding whitespace does not turn Weak or Fail into solid and clear", () => {
  heldBack(grade({ personQuality: " Weak ", integrityGate: { status: "Fail ", note: "Contradiction." } }));
});

test("omitted person quality and integrity status fail closed", () => {
  const evaluation = grade({});
  heldBack(evaluation);
});

test("null person quality and a non-object integrity gate fail closed", () => {
  heldBack(grade({ personQuality: null, integrityGate: null }));
});

test("unrecognized person quality and integrity status fail closed", () => {
  heldBack(grade({ personQuality: "poor", integrityGate: { status: "rejected", note: "Does not match." } }));
});

test("an integrity object with no status fails closed", () => {
  const evaluation = grade({ personQuality: "weak", integrityGate: { note: "No status token." } });
  assert.equal(evaluation.integrityGate.status, "fail");
  assert.ok(evaluation.total <= 54);
  assert.notEqual(tierKeyFromTotal(evaluation.total), "strong");
  assert.equal(decisionReadFromEvaluation(evaluation, false, "test-model").decision, "reject");
  assert.notEqual(boardDecision(evaluation), "interview");
});

test("Blocked and strong_seat cannot become an interview recommendation", () => {
  const evaluation = grade({
    personQuality: "Blocked",
    integrityGate: { status: "clear", note: "" },
    seatFit: {
      appliedSeat: routingSeat.title,
      verdict: "strong_seat",
      score: 96,
      summary: "Looks like the seat on paper.",
    },
  });
  assert.equal(evaluation.personQuality, "blocked");
  assert.equal(evaluation.integrityGate.status, "clear");
  const fit = fitReadFromEvaluation(evaluation);
  assert.ok(fit);
  assert.equal(fit.sentiment, "negative");
  assert.notEqual(boardDecision(evaluation), "interview");
});

test("Promising stays promising, so viable_seat is not treated as a strong fit", () => {
  const evaluation = grade({
    personQuality: "Promising",
    integrityGate: { status: "Clear", note: "" },
    seatFit: {
      appliedSeat: routingSeat.title,
      verdict: "viable_seat",
      score: 80,
      summary: "Viable on paper, still promising rather than solid.",
    },
  });
  assert.equal(evaluation.personQuality, "promising");
  assert.equal(evaluation.integrityGate.status, "clear");
  assert.ok(evaluation.total >= 85);
  const fit = fitReadFromEvaluation(evaluation);
  assert.ok(fit);
  assert.notEqual(fit.sentiment, "good");
  assert.notEqual(boardDecision(evaluation), "interview");
});

test("Concern stays concern and does not wipe the gate or cap a real score", () => {
  const evaluation = grade({
    personQuality: "solid",
    integrityGate: { status: "Concern", concern: "POSSIBLE_MISREPRESENTATION", note: "Dates do not line up." },
  });
  assert.equal(evaluation.personQuality, "solid");
  assert.equal(evaluation.integrityGate.status, "concern");
  assert.equal(evaluation.integrityGate.concern, "POSSIBLE_MISREPRESENTATION");
  assert.ok(evaluation.total >= 85);
  assert.equal(tierKeyFromTotal(evaluation.total), "strong");
});

test("a capitalized other-gate Fail still caps the total and rejects", () => {
  const evaluation = grade({
    personQuality: "high",
    integrityGate: { status: "clear", note: "" },
    otherGateResults: [
      { key: "work_auth", label: "Work authorization", status: "Fail", severity: "Critical", note: "Cannot start." },
    ],
  });
  assert.equal(evaluation.otherGateResults[0]?.status, "fail");
  assert.equal(evaluation.otherGateResults[0]?.severity, "critical");
  assert.ok(evaluation.total <= 54, `expected the other-gate cap, got total ${evaluation.total}`);
  assert.notEqual(tierKeyFromTotal(evaluation.total), "strong");
  assert.equal(decisionReadFromEvaluation(evaluation, false, "test-model").decision, "reject");
});

test("a critical warning with capitalized severity still caps the total", () => {
  const evaluation = grade({
    personQuality: "high",
    integrityGate: { status: "clear", note: "" },
    otherGateResults: [
      { key: "license", label: "License", status: "Warn", severity: "Critical", note: "License not held." },
    ],
  });
  assert.equal(evaluation.otherGateResults[0]?.status, "warn");
  assert.equal(evaluation.otherGateResults[0]?.severity, "critical");
  assert.ok(evaluation.total <= 54, `expected the critical-warning cap, got total ${evaluation.total}`);
  assert.notEqual(tierKeyFromTotal(evaluation.total), "strong");
});

test("exact lowercase weak and fail already stay off the interview list", () => {
  const evaluation = grade({
    personQuality: "weak",
    integrityGate: { status: "fail", note: "Material contradiction." },
  });
  heldBack(evaluation);
});

test("exact high person quality with a clear gate on the routing seat stays interview-worthy", () => {
  const evaluation = grade({
    personQuality: "high",
    integrityGate: { status: "clear", note: "" },
  });
  assert.equal(evaluation.personQuality, "high");
  assert.equal(evaluation.integrityGate.status, "clear");
  assert.ok(evaluation.total >= 85);
  assert.equal(tierKeyFromTotal(evaluation.total), "strong");
  const fit = fitReadFromEvaluation(evaluation);
  assert.ok(fit);
  assert.equal(fit.sentiment, "good");
  assert.equal(boardDecision(evaluation), "interview");
  assert.equal(decisionReadFromEvaluation(evaluation, false, "test-model").decision, "interview");
});
