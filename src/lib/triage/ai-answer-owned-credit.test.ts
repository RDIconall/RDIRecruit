/**
 * Spec for the hiring-signal bypass where a model verdict of AI is tallied as
 * owned substance when provenance looks backed and credit is partial or high,
 * and where a missing credit field is filled in as high for experience-backed
 * grades even when the verdict is AI or authorship is likely synthetic.
 *
 * These assertions describe the repaired behavior. They fail on the current
 * tally and normalizer.
 */
import "./test-server-only-stub";
import assert from "node:assert/strict";
import test from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { AnswerGradePayload, CandidateRow, ScoreRow } from "../types";
import type { SeatContext } from "../jobs/seat-context";
import {
  buildEvaluatorRequest,
  parseEvaluatorMessage,
  type EvaluatorInput,
} from "../scoring/evaluator";
import { fitWeight } from "./app-theme";
import { countAnswerVerdicts, summarizeAnswerGrades } from "./answer-grades";
import { deriveDecisionDetail, mapCandidate, type MapInput } from "./from-supabase";
import type { FitRead } from "./fit-read";

const STUDY = "Describe a study you owned";
const AUDIT = "How did you close the last audit";
const DEVIATION = "What did you do with a protocol deviation";

/** Applicant-controlled screening text. Fluent, and it restates the résumé. */
const APPLICANT_ANSWERS: Record<string, string> = {
  [STUDY]:
    "At Northlab I built the CAP inspection binder and led the 2022 audit close, the same program listed on my résumé.",
  [AUDIT]:
    "I closed the Northlab CAP audit by tracking every citation to a signed corrective action, which is the audit I list under Northlab.",
  [DEVIATION]:
    "On the Northlab oncology study I logged the deviation, told the sponsor, and filed the CAPA before the next visit, as my résumé describes.",
};

const WEIGHTS = {
  principal: 25,
  environment: 15,
  scope: 20,
  writing: 15,
  tenure: 15,
  local: 10,
} as const;

const SEAT: SeatContext = {
  jobShortcode: "JOB1",
  jobTitle: "Clinical Research Associate",
  seatStratum: "IIb–IIa",
  jdSummary: "Runs monitoring visits and owns the audit file.",
  categoryLabels: {
    principal: "Principal",
    environment: "Environment",
    scope: "Scope",
    writing: "Writing",
    tenure: "Tenure",
    local: "Local",
  },
};

const candidateRow: CandidateRow = {
  workable_id: "cand_ai",
  job_shortcode: "JOB1",
  name: "Applicant",
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

function score(total: number): ScoreRow {
  return {
    id: "score_ai",
    candidate_id: "cand_ai",
    rubric_version: 1,
    category_scores: { principal: 20, environment: 12, scope: 16, writing: 10, tenure: 10, local: 8 },
    total,
    salary_value: "justified",
    confidence: "high",
    model_version: "test",
    created_at: "2026-06-01T00:00:00.000Z",
  };
}

function evaluatorInput(): EvaluatorInput {
  return {
    name: "Applicant",
    resumeText:
      "Northlab, Clinical Research Associate, 2018-2024. Built the CAP inspection binder and led the 2022 audit close on the oncology study.",
    roles: [
      {
        title: "Clinical Research Associate",
        company: "Northlab",
        start: "2018-01",
        end: "2024-06",
        summary: "Led the 2022 CAP audit close.",
      },
    ],
    answers: APPLICANT_ANSWERS,
    coverLetter: "I am applying for the CRA seat.",
    seat: SEAT,
    weights: { ...WEIGHTS },
  };
}

type GradeSpec = {
  question: string;
  verdict: "AI" | "OWNED" | "SURFACE" | "EVASIVE";
  answerProvenance?: string;
  authorshipConfidence?: string;
  candidateEvidenceCredit?: string | null;
  present?: string[];
};

/**
 * The scorer's per-answer object, in the shape the evaluator asks the model
 * to return. `candidateEvidenceCredit: null` omits the field so the normalizer
 * has to fill it in.
 */
function modelMessage(grades: GradeSpec[], totalHint = 76): Pick<Anthropic.Message, "content" | "stop_reason"> {
  const answerGrades = grades.map((grade) => {
    const row: Record<string, unknown> = {
      question: grade.question,
      verdict: grade.verdict,
      answerProvenance: grade.answerProvenance ?? "experience_backed",
      authorshipConfidence: grade.authorshipConfidence ?? "likely_synthetic",
      present: grade.present ?? ["CAP inspection binder", "audit close"],
      note: "Fluent restatement of the Northlab résumé. Marked AI.",
      kind: "screen",
    };
    if (grade.candidateEvidenceCredit !== null) {
      row.candidateEvidenceCredit = grade.candidateEvidenceCredit ?? "high";
    }
    return row;
  });
  const body = JSON.stringify({
    categoryScores: { principal: 20, environment: 12, scope: 16, writing: 10, tenure: 10, local: 8 },
    summary: "Consider-band file. Answers restate the résumé.",
    total: totalHint,
    answerGrades,
    integrityGate: { status: "clear", note: "" },
  });
  return {
    stop_reason: "end_turn",
    content: [{ type: "text", text: body }],
  };
}

function graded(grades: GradeSpec[]) {
  const input = evaluatorInput();
  const request = buildEvaluatorRequest(input);
  const user = request.messages[0]?.content;
  assert.equal(typeof user, "string");
  for (const answer of Object.values(APPLICANT_ANSWERS)) {
    assert.ok((user as string).includes(answer), "applicant answer text must be what the scorer sends");
  }
  const evaluation = parseEvaluatorMessage(modelMessage(grades), input);
  assert.ok(evaluation, "model message must normalize into an evaluation");
  assert.ok(evaluation.total >= 70 && evaluation.total < 85, `seat read ${evaluation.total} must stay in the consider band`);
  return { input, evaluation };
}

function board(grades: AnswerGradePayload[], total: number | null): MapInput {
  return {
    candidate: candidateRow,
    score: total == null ? null : score(total),
    ro: null,
    overlay: null,
    application: {
      answers: APPLICANT_ANSWERS,
      cover_letter: "I am applying for the CRA seat.",
      parsed_experience: [{ title: "Clinical Research Associate", company: "Northlab", start: "2018-01", end: "2024-06" }],
      resume_text: evaluatorInput().resumeText,
    },
    narrative: [],
    evals: {
      invest: {
        complement: "technician",
        head: "Work off the desk",
        removes: "monitoring load",
        vector: "priced about right",
        summary: "Restates the Northlab audit.",
        ask: "$120k",
      },
      dig: null,
      verification: null,
      roleReads: [],
      answerGrades: grades,
      fitRead: {
        reply: "Answers restate the Northlab audit.",
        sentiment: "good",
        appliedFit: "Fits this posting.",
        rdiFit: "Would still need a live check.",
        suggestedSeat: "",
      } satisfies FitRead,
    },
    interviewEvidence: [],
    read: {
      decision: "interview",
      why: "Looks fluent on the page.",
      risk: "",
      next: "Interview",
      value: {
        headline: "Strength supports the ask",
        level: "strong",
        detail: "Model called the file strong before the answer tally.",
      },
    },
    rank: 1,
    jobLocation: "Van Nuys, CA",
    jobShortcode: "JOB1",
    jobTitle: "Clinical Research Associate",
  };
}

const AI_BACKED: GradeSpec[] = [
  { question: STUDY, verdict: "AI", answerProvenance: "experience_backed", candidateEvidenceCredit: "high", authorshipConfidence: "likely_synthetic" },
  { question: AUDIT, verdict: "AI", answerProvenance: "experience_backed", candidateEvidenceCredit: "high", authorshipConfidence: "likely_ai_assisted" },
  { question: DEVIATION, verdict: "AI", answerProvenance: "adjacent_plausible", candidateEvidenceCredit: "partial", authorshipConfidence: "likely_synthetic" },
];

function assertAiHeavy(label: string) {
  assert.doesNotMatch(label, /Strong/i);
  assert.match(label, /AI-heavy/i);
}

test("an AI verdict stays in the AI bucket when provenance is backed and credit is high or partial", () => {
  const grades = [
    { verdict: "AI", answerProvenance: "experience_backed", candidateEvidenceCredit: "high", present: ["CAP binder", "audit close"], authorshipConfidence: "likely_synthetic" },
    { verdict: "AI", answerProvenance: "experience_backed", candidateEvidenceCredit: "partial", present: ["CAPA"], authorshipConfidence: "likely_ai_assisted" },
    { verdict: "AI", answerProvenance: "adjacent_plausible", candidateEvidenceCredit: "high", present: ["deviation log"], authorshipConfidence: "likely_synthetic" },
    { verdict: "AI", answerProvenance: "adjacent_plausible", candidateEvidenceCredit: "partial", present: ["sponsor notice"], authorshipConfidence: "likely_synthetic" },
  ];
  const tally = countAnswerVerdicts(grades);
  assert.equal(tally.ai, grades.length);
  assert.equal(tally.owned, 0);
  assert.equal(tally.ownedConcepts, 0);
  const summary = summarizeAnswerGrades(grades);
  assert.equal(summary.level, "weak");
  assertAiHeavy(summary.label);
  assert.doesNotMatch(summary.label, /owned/i);
});

test("a majority of AI-marked answers does not become the Strong answers label the pool sorts on", () => {
  const { evaluation } = graded(AI_BACKED);
  for (const grade of evaluation.answerGrades) {
    assert.equal(grade.verdict, "AI");
    assert.equal(grade.candidateEvidenceCredit === "high" || grade.candidateEvidenceCredit === "partial", true);
  }
  const tally = countAnswerVerdicts(evaluation.answerGrades);
  assert.equal(tally.ai, 3);
  assert.equal(tally.owned, 0);
  assert.equal(tally.ownedConcepts, 0);

  const view = mapCandidate(board(evaluation.answerGrades, evaluation.total));
  assert.equal(view.answersRead.level, "weak");
  assertAiHeavy(view.answersRead.label);
  assert.doesNotMatch(view.answersRead.label, /owned/i);
  assert.equal(fitWeight(view.answersRead.level), 0);

  assert.equal(view.answers.length, 3);
  for (const row of view.answers) {
    assert.equal(row.verdict, "AI");
    assert.equal(row.kind, "ai");
    assert.match(row.a, /Northlab/);
    assert.equal(row.present, undefined);
  }

  // Same spec, genuinely owned answers. The mobile group sort is answers + spec.
  const ownedGrades: GradeSpec[] = [
    { question: STUDY, verdict: "OWNED", candidateEvidenceCredit: "high", authorshipConfidence: "high", present: ["CAP binder"] },
    { question: AUDIT, verdict: "OWNED", candidateEvidenceCredit: "high", authorshipConfidence: "high", present: ["audit close"] },
    { question: DEVIATION, verdict: "OWNED", candidateEvidenceCredit: "high", authorshipConfidence: "high", present: ["CAPA"] },
  ];
  const owned = graded(ownedGrades);
  const ownedView = mapCandidate(board(owned.evaluation.answerGrades, owned.evaluation.total));
  const aiFit = fitWeight(view.answersRead.level) + fitWeight(view.specRead.level);
  const ownedFit = fitWeight(ownedView.answersRead.level) + fitWeight(ownedView.specRead.level);
  assert.ok(aiFit < ownedFit);

  // A stored "strong" value headline has to be grounded on the answer tally.
  assert.equal(view.value.level, "fair");
  assert.match(view.value.headline, /limited evidence/i);
});

test("two AI answers plus one owned answer stay AI-heavy, and two owned answers can still read strong", () => {
  const majorityAi = summarizeAnswerGrades([
    { verdict: "AI", answerProvenance: "experience_backed", candidateEvidenceCredit: "high", present: ["a"] },
    { verdict: "AI", answerProvenance: "adjacent_plausible", candidateEvidenceCredit: "partial", present: ["b"] },
    { verdict: "OWNED", answerProvenance: "experience_backed", candidateEvidenceCredit: "high", present: ["c"] },
  ]);
  assert.equal(majorityAi.level, "weak");
  assertAiHeavy(majorityAi.label);
  assert.match(majorityAi.label, /2 AI/);
  assert.match(majorityAi.label, /1 owned/);

  const majorityOwned = summarizeAnswerGrades([
    { verdict: "AI", answerProvenance: "experience_backed", candidateEvidenceCredit: "high", present: ["a"] },
    { verdict: "OWNED", answerProvenance: "experience_backed", candidateEvidenceCredit: "high", present: ["b"] },
    { verdict: "OWNED", answerProvenance: "experience_backed", candidateEvidenceCredit: "high", present: ["c"] },
  ]);
  assert.equal(majorityOwned.level, "strong");
  assert.match(majorityOwned.label, /Strong answers/i);
  assert.match(majorityOwned.label, /2 owned/);
  assert.doesNotMatch(majorityOwned.label, /owned concepts from the AI|3 owned/);
});

test("a missing credit field is not filled in as high when the verdict is AI or authorship is likely synthetic", () => {
  const omitted = graded([
    { question: STUDY, verdict: "AI", answerProvenance: "experience_backed", candidateEvidenceCredit: null, authorshipConfidence: "likely_ai_assisted" },
    { question: AUDIT, verdict: "AI", answerProvenance: "adjacent_plausible", candidateEvidenceCredit: null, authorshipConfidence: "uncertain" },
    { question: DEVIATION, verdict: "OWNED", answerProvenance: "experience_backed", candidateEvidenceCredit: null, authorshipConfidence: "likely_synthetic", present: [] },
  ]);
  const [aiBacked, aiAdjacent, syntheticOwned] = omitted.evaluation.answerGrades;
  assert.notEqual(aiBacked?.candidateEvidenceCredit, "high");
  assert.notEqual(aiAdjacent?.candidateEvidenceCredit, "high");
  assert.notEqual(syntheticOwned?.candidateEvidenceCredit, "high");

  const tally = countAnswerVerdicts(omitted.evaluation.answerGrades);
  assert.equal(tally.ai, 2);
  assert.equal(tally.owned, 1);
  const summary = summarizeAnswerGrades(omitted.evaluation.answerGrades);
  assert.equal(summary.level, "weak");
  assertAiHeavy(summary.label);
});

test("the interview bar does not clear on AI answers when the seat read is only in the consider band", () => {
  const { evaluation } = graded(AI_BACKED);
  const derived = deriveDecisionDetail(board(evaluation.answerGrades, evaluation.total));
  assert.equal(derived.bar.clears, false);
  assert.match(derived.bar.reason ?? "", /AI-written|does not support/i);
});

test("the interview bar does not clear on AI answers when there is no numeric seat read", () => {
  const { evaluation } = graded(AI_BACKED);
  const derived = deriveDecisionDetail(board(evaluation.answerGrades, null));
  assert.equal(derived.bar.clears, false);
  assert.match(derived.bar.reason ?? "", /AI-written|does not support/i);
});

test("unsupported synthetic zero-credit AI stays weak, and a human-owned file still clears the consider band", () => {
  const unsupported = summarizeAnswerGrades([
    { verdict: "AI", answerProvenance: "unsupported", authorshipConfidence: "likely_synthetic", candidateEvidenceCredit: "zero", present: ["invented method"] },
    { verdict: "AI", answerProvenance: "unsupported", authorshipConfidence: "likely_synthetic", candidateEvidenceCredit: "zero", present: ["invented method"] },
  ]);
  assert.equal(unsupported.level, "weak");
  assert.doesNotMatch(unsupported.label, /Strong/i);

  const owned = graded([
    { question: STUDY, verdict: "OWNED", candidateEvidenceCredit: "high", authorshipConfidence: "high", present: ["CAP binder"] },
    { question: AUDIT, verdict: "OWNED", candidateEvidenceCredit: "high", authorshipConfidence: "high", present: ["audit close"] },
    { question: DEVIATION, verdict: "OWNED", candidateEvidenceCredit: "high", authorshipConfidence: "high", present: ["CAPA"] },
  ]);
  const derived = deriveDecisionDetail(board(owned.evaluation.answerGrades, owned.evaluation.total));
  assert.equal(derived.bar.clears, true);
  assert.equal(summarizeAnswerGrades(owned.evaluation.answerGrades).level, "strong");
});
