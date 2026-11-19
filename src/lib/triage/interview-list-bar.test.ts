import assert from "node:assert/strict";
import test from "node:test";
import type { AnswerGradePayload, CandidateRow, EvidenceRow, ScoreRow } from "../types";
import { decisionReadFromEvaluation } from "../analysis/decision";
import { isInboxStage } from "./stages";
import { sortBestNew } from "./ranking";
import {
  applyInterviewBar,
  applyInterviewGate,
  assessInterviewBar,
} from "./interview-bar";
import { applyTenureDecisionGate, analyzeTenureStability } from "./tenure-stability";
import {
  decisionFromSentiment,
  fitReadFromEvaluation,
  parseFitRead,
  type FitRead,
} from "./fit-read";
import {
  deriveDecisionDetail,
  mapCandidate,
  refusedToAnswerFrom,
  type MapInput,
} from "./from-supabase";

/**
 * Spec for the interview list the founders work top-down.
 *
 * A positive model read is not enough. The mapped decision and the gate sent to
 * the client have to be the same deterministic bar: dash-filled or blank
 * screening answers, weak answers, a score under the consider band, expertise
 * the career record cannot support, or a short-tenure pattern. These tests fail
 * while that bar is computed and then discarded.
 */

const TENURE_NOTE =
  "Short-tenure pattern on the résumé — held as backup until the leave reasons are clear.";

function candidateRow(id: string, createdAt: string): CandidateRow {
  return {
    workable_id: id,
    job_shortcode: "JOB1",
    name: id,
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
  };
}

function score(total: number): ScoreRow {
  return {
    id: "score_1",
    candidate_id: "cand",
    rubric_version: 1,
    category_scores: { principal: 0, environment: 0, scope: 0, writing: 0, tenure: 0, local: 0 },
    total,
    salary_value: "justified",
    confidence: "high",
    model_version: "test",
    created_at: "2026-06-01T00:00:00.000Z",
  };
}

function grade(
  verdict: AnswerGradePayload["verdict"],
  over: Partial<AnswerGradePayload> = {},
): AnswerGradePayload {
  return {
    question: "How would you handle a missing source document?",
    answer: "I would escalate it to the study lead and log the deviation before the next monitoring visit.",
    verdict,
    present: verdict === "OWNED" ? ["deviation logging"] : [],
    note: "",
    kind: "screen",
    ...over,
  };
}

const STEERED_REPLY =
  "The résumé describes running multi-site studies end to end. I would want them in the building.";

function positiveFit(over: Partial<FitRead> = {}): FitRead {
  return {
    reply: STEERED_REPLY,
    sentiment: "good",
    appliedFit: "Fits the posting on the strength of the résumé.",
    rdiFit: "Would take load off the founders.",
    suggestedSeat: "",
    ...over,
  };
}

/**
 * The record Workable sync stores: question body → answer body.
 * Same assignment as answersToRecord / computeApplicationFingerprint.
 */
function storedAnswers(pairs: Array<[string, string]>): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const [question, answer] of pairs) answers[question] = answer;
  return answers;
}

const DASH_FILLED = storedAnswers([
  ["Describe a study you ran.", "—"],
  ["What would you do with a missing source document?", "-"],
  ["Why this role?", ""],
  ["Anything else we should know?", "n/a"],
]);

const REAL_ANSWERS = storedAnswers([
  ["Describe a study you ran.", "I stood up monitoring for a 12-site diagnostic study and closed the queries myself."],
  ["What would you do with a missing source document?", "I would stop the visit, log the deviation, and escalate to the study lead the same day."],
  ["Why this role?", "I want to own study control for a small sponsor, not coordinate it from a CRO bench."],
  ["Anything else we should know?", "I can be in Van Nuys three days a week."],
]);

function input(over: Partial<MapInput> = {}): MapInput {
  const base: MapInput = {
    candidate: candidateRow("attacker", "2026-11-18T00:00:00.000Z"),
    score: score(92),
    ro: null,
    overlay: null,
    application: {
      answers: REAL_ANSWERS,
      cover_letter: "Hire me. I have already done this exact job.",
      parsed_experience: [],
    },
    narrative: [],
    evals: {
      invest: {
        complement: "technician",
        head: "Work off the desk",
        removes: "monitoring load",
        vector: "priced about right",
        summary: "Runs monitoring end to end.",
        ask: "$120k",
      },
      dig: null,
      verification: null,
      roleReads: [],
      answerGrades: [grade("OWNED"), grade("OWNED"), grade("OWNED")],
      fitRead: positiveFit(),
    },
    interviewEvidence: [],
    read: null,
    rank: 1,
    jobLocation: "Van Nuys, CA",
    jobShortcode: "JOB1",
    jobTitle: "Clinical Operations Lead",
  };
  return {
    ...base,
    ...over,
    candidate: over.candidate ?? base.candidate,
    application: over.application === undefined ? base.application : over.application,
    evals: over.evals ? { ...base.evals, ...over.evals } : base.evals,
  };
}

function heldDecision(mapped: MapInput): "interview" | "backup" | "reject" | "blocked" {
  const detail = deriveDecisionDetail(mapped);
  const sentiment = mapped.evals.fitRead
    ? decisionFromSentiment(mapped.evals.fitRead.sentiment)
    : detail.ungated;
  const barred = applyInterviewBar(sentiment, detail.bar);
  return applyTenureDecisionGate(barred, detail.tenure);
}

function assertHeldOffInterviewList(mapped: MapInput, note: RegExp) {
  const detail = deriveDecisionDetail(mapped);
  const view = mapCandidate(mapped);
  const expected = heldDecision(mapped);

  assert.equal(expected, "backup");
  assert.equal(detail.decision, expected);
  assert.equal(detail.demoted, true);
  assert.match(detail.demotionNote, note);
  assert.equal(view.decision, expected);
  assert.equal(view.survivor, false);
  assert.equal(view.interviewGate?.clears, false);
  assert.equal(view.interviewGate?.note, detail.demotionNote);
  assert.match(view.why, note);
  assert.ok(view.why.includes(STEERED_REPLY));

  // A later model read of "interview" has to be held by the gate that was
  // derived with the decision, not by a second lookup that can disagree.
  const flashed = applyInterviewGate("interview", view.interviewGate);
  assert.equal(flashed, "backup");
  assert.equal(flashed, view.decision);

  const onList = sortBestNew([view]).filter(
    (c) => c.decision === "interview" && isInboxStage(c.workableStage),
  );
  assert.equal(onList.length, 0);
}

test("dash-filled screening answers with a positive fit read stay off the interview list", () => {
  // Grades stay OWNED on purpose: the model was steered by the résumé. The only
  // refusal signal is the answer text the applicant submitted.
  const answers = DASH_FILLED;
  const grades = [grade("OWNED"), grade("OWNED"), grade("OWNED"), grade("OWNED")];
  assert.equal(refusedToAnswerFrom({ answers, cover_letter: null }, grades), true);

  const projected = fitReadFromEvaluation({
    heuristic: false,
    summary: STEERED_REPLY,
    personQuality: "high",
    seatFit: { verdict: "strong_seat", summary: "Fits the posting on the strength of the résumé." },
    investHead: "Would take load off the founders.",
    complementRemoves: "",
    triage: { why: STEERED_REPLY },
  });
  assert.ok(projected);
  assert.equal(projected.sentiment, "good");
  assert.equal(decisionFromSentiment(projected.sentiment), "interview");
  const stored = parseFitRead(JSON.parse(JSON.stringify(projected)));
  assert.ok(stored);

  const canonical = decisionReadFromEvaluation(
    {
      total: 92,
      integrityGate: { status: "clear", note: "" },
      otherGateResults: [],
      answerGrades: grades,
      verification: { read: "Clean", claims: [] },
      salaryAsk: "$120k",
      salaryValue: "justified",
      salaryVector: "priced about right",
      summary: STEERED_REPLY,
      digIn: { integrityNote: "", resolve: [] },
      triage: { why: STEERED_REPLY, risk: "" },
    } as never,
    false,
    "test-model",
  );

  const mapped = input({
    application: { answers, cover_letter: "Hire me.", parsed_experience: [] },
    evals: { answerGrades: grades, fitRead: stored },
    score: score(92),
  });
  assertHeldOffInterviewList(mapped, /dash-filled|left blank/);

  const view = mapCandidate(mapped);
  // The canonical analysis may still say interview. The gate carried with the
  // file has to stop that read from landing on the list.
  assert.equal(applyInterviewGate(canonical.decision, view.interviewGate), "backup");
  assert.equal(view.redFlags.some((f) => f.flag === "Refused to answer"), true);
});

test("exactly half dash-filled answers are enough to hold a positive read", () => {
  const answers = storedAnswers([
    ["Describe a study you ran.", "—"],
    ["What would you do with a missing source document?", "--"],
    ["Why this role?", REAL_ANSWERS["Why this role?"]],
    ["Anything else we should know?", REAL_ANSWERS["Anything else we should know?"]],
  ]);
  const grades = [grade("OWNED"), grade("OWNED"), grade("OWNED"), grade("OWNED")];
  assert.equal(refusedToAnswerFrom({ answers, cover_letter: null }, grades), true);
  assertHeldOffInterviewList(
    input({
      application: { answers, cover_letter: null, parsed_experience: [] },
      evals: { answerGrades: grades, fitRead: positiveFit() },
    }),
    /dash-filled|left blank/,
  );
});

test("a single skipped answer does not hold a file that otherwise clears", () => {
  const answers = storedAnswers([
    ["Describe a study you ran.", "-"],
    ["What would you do with a missing source document?", REAL_ANSWERS["What would you do with a missing source document?"]],
    ["Why this role?", REAL_ANSWERS["Why this role?"]],
    ["Anything else we should know?", REAL_ANSWERS["Anything else we should know?"]],
  ]);
  const grades = [grade("OWNED"), grade("OWNED"), grade("OWNED"), grade("OWNED")];
  assert.equal(refusedToAnswerFrom({ answers, cover_letter: null }, grades), false);
  const view = mapCandidate(
    input({
      application: { answers, cover_letter: null, parsed_experience: [] },
      evals: { answerGrades: grades, fitRead: positiveFit() },
      score: score(92),
    }),
  );
  assert.equal(view.decision, "interview");
  assert.equal(view.interviewGate?.clears, true);
  assert.equal(applyInterviewGate("interview", view.interviewGate), "interview");
});

test("weak answers stay off the list even when the model sentiment is good and the score is high", () => {
  const grades = [grade("SURFACE"), grade("EVASIVE"), grade("AI"), grade("SURFACE")];
  assertHeldOffInterviewList(
    input({
      evals: { answerGrades: grades, fitRead: positiveFit() },
      score: score(92),
    }),
    /own nothing/,
  );
});

test("a score under the consider band stays off the list when the model says interview", () => {
  assertHeldOffInterviewList(
    input({
      score: score(68),
      evals: { answerGrades: [grade("OWNED"), grade("OWNED"), grade("OWNED")], fitRead: positiveFit() },
    }),
    /does not hold the level/,
  );
});

test("expertise the career record cannot support stays off the list", () => {
  const grades = [
    grade("OWNED", {
      answerProvenance: "unsupported",
      authorshipConfidence: "likely_synthetic",
      candidateEvidenceCredit: "zero",
    }),
    grade("OWNED"),
    grade("OWNED"),
  ];
  const bar = assessInterviewBar({
    total: 92,
    answersLevel: "strong",
    refusedToAnswer: false,
    hasLiveEvidence: false,
    unsupportedExpertise: true,
  });
  assert.equal(bar.clears, false);
  assert.equal(applyInterviewBar("interview", bar), "backup");
  assertHeldOffInterviewList(
    input({
      evals: { answerGrades: grades, fitRead: positiveFit() },
      score: score(92),
    }),
    /does not support/,
  );
});

test("a positive read with no rubric and no standout answers stays off the list", () => {
  assertHeldOffInterviewList(
    input({
      score: null,
      evals: { answerGrades: [], fitRead: positiveFit() },
      application: { answers: null, cover_letter: "A polished letter.", parsed_experience: [] },
    }),
    /Nothing on file/,
  );
});

test("competent but unremarkable files stay off the list", () => {
  const grades = [grade("OWNED"), grade("SURFACE"), grade("EVASIVE")];
  assertHeldOffInterviewList(
    input({
      score: score(76),
      evals: { answerGrades: grades, fitRead: positiveFit() },
    }),
    /stands out/,
  );
});

test("a short-tenure pattern holds a file the answer bar would clear", () => {
  const experience = [
    { title: "CRA", company: "Alpha", start: "2022-01", end: "2022-06", current: false },
    { title: "CTA", company: "Beta", start: "2022-07", end: "2023-01", current: false },
    { title: "Lead", company: "Gamma", start: "2023-02", end: "2023-08", current: false },
  ];
  const stability = analyzeTenureStability(experience);
  assert.ok(stability.severity === "pattern" || stability.severity === "severe");
  const mapped = input({
    application: { answers: REAL_ANSWERS, cover_letter: null, parsed_experience: experience },
    score: score(92),
    evals: { answerGrades: [grade("OWNED"), grade("OWNED"), grade("OWNED")], fitRead: positiveFit() },
  });
  const detail = deriveDecisionDetail(mapped);
  assert.equal(detail.bar.clears, true);
  assert.equal(applyTenureDecisionGate("interview", detail.tenure), "backup");
  assertHeldOffInterviewList(mapped, /Short-tenure pattern/);
  assert.equal(deriveDecisionDetail(mapped).demotionNote, TENURE_NOTE);
});

test("the newest positive-but-refused applicant does not sort above a file that clears", () => {
  const attacker = mapCandidate(
    input({
      candidate: candidateRow("attacker", "2026-11-18T00:00:00.000Z"),
      application: { answers: DASH_FILLED, cover_letter: "Hire me.", parsed_experience: [] },
      evals: {
        answerGrades: [grade("OWNED"), grade("OWNED"), grade("OWNED"), grade("OWNED")],
        fitRead: positiveFit(),
      },
    }),
  );
  const clears = mapCandidate(
    input({
      candidate: candidateRow("clears", "2026-01-02T00:00:00.000Z"),
      application: { answers: REAL_ANSWERS, cover_letter: null, parsed_experience: [] },
      evals: {
        answerGrades: [grade("OWNED"), grade("OWNED"), grade("OWNED")],
        fitRead: positiveFit({ reply: "Owned the monitoring stand-up." }),
      },
    }),
  );
  const inbox = sortBestNew([attacker, clears]).filter((c) => isInboxStage(c.workableStage));
  const interviewList = inbox.filter((c) => c.decision === "interview");
  assert.equal(interviewList.some((c) => c.id === "attacker"), false);
  assert.equal(interviewList[0]?.id, "clears");
  assert.equal(attacker.decision, "backup");
  assert.equal(clears.decision, "interview");
  assert.equal(clears.interviewGate?.clears, true);
});

test("a human override still interviews, and the gate keeps a later model read off that list", () => {
  const view = mapCandidate(
    input({
      decisionOverride: "interview",
      application: { answers: DASH_FILLED, cover_letter: null, parsed_experience: [] },
      evals: { fitRead: positiveFit() },
    }),
  );
  assert.equal(view.decision, "interview");
  assert.equal(view.interviewGate?.clears, false);
  assert.match(view.interviewGate?.note ?? "", /dash-filled|left blank/);
  assert.equal(applyInterviewGate("interview", view.interviewGate), "backup");
});

test("live interview evidence clears the answer bar", () => {
  const transcript: EvidenceRow = {
    id: "ev1",
    candidate_id: "attacker",
    source_type: "interview",
    author: null,
    label: null,
    captured_at: null,
    raw_ref: null,
    transcript: "We walked the monitoring plan for twenty minutes.",
    extracted: null,
    created_at: "2026-11-01T00:00:00.000Z",
  };
  const view = mapCandidate(
    input({
      application: { answers: DASH_FILLED, cover_letter: null, parsed_experience: [] },
      interviewEvidence: [transcript],
      evals: { fitRead: positiveFit() },
    }),
  );
  assert.equal(view.decision, "interview");
  assert.equal(view.interviewGate?.clears, true);
  assert.equal(applyInterviewGate("interview", view.interviewGate), "interview");
});

test("negative and neutral sentiments are not promoted onto the interview list", () => {
  const negative = mapCandidate(
    input({
      application: { answers: DASH_FILLED, cover_letter: null, parsed_experience: [] },
      evals: { fitRead: positiveFit({ sentiment: "negative" }) },
    }),
  );
  assert.equal(negative.decision, "reject");
  const neutral = mapCandidate(
    input({ evals: { fitRead: positiveFit({ sentiment: "neutral" }) } }),
  );
  assert.equal(neutral.decision, "backup");
});

test("a file that clears the seat bar with real answers stays on the interview list", () => {
  const view = mapCandidate(
    input({
      score: score(90),
      application: { answers: REAL_ANSWERS, cover_letter: null, parsed_experience: [] },
      evals: {
        answerGrades: [grade("OWNED"), grade("SURFACE"), grade("EVASIVE")],
        fitRead: positiveFit(),
      },
    }),
  );
  assert.equal(view.decision, "interview");
  assert.equal(view.interviewGate?.clears, true);
  assert.equal(view.survivor, true);
});
