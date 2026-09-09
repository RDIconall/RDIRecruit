import assert from "node:assert/strict";
import type { AnswerGradePayload, CandidateRow, ScoreRow } from "../types";
import { MULTI_ROLE_POOL } from "../rubric/seat-rubrics";
import { deriveDecisionDetail, mapCandidate, type MapInput } from "./from-supabase";
import type { FitRead } from "./fit-read";

const candidateRow: CandidateRow = {
  workable_id: "cand_1",
  job_shortcode: "JOB1",
  name: "Test Candidate",
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
    id: "score_1",
    candidate_id: "cand_1",
    rubric_version: 1,
    category_scores: { principal: 0, environment: 0, scope: 0, writing: 0, tenure: 0, local: 0 },
    total,
    salary_value: "justified",
    confidence: "high",
    model_version: "test",
    created_at: "2026-06-01T00:00:00.000Z",
  };
}

function grade(verdict: AnswerGradePayload["verdict"]): AnswerGradePayload {
  return {
    question: "How would you handle a missing source document?",
    answer: "I would escalate it to the study lead and log the deviation before the next monitoring visit.",
    verdict,
    present: verdict === "OWNED" ? ["deviation logging"] : [],
    note: "",
    kind: "screen",
  };
}

function fit(sentiment: FitRead["sentiment"], over: Partial<FitRead> = {}): FitRead {
  return {
    reply: "Owned the BSL-2 stand-up; answers name real work.",
    sentiment,
    appliedFit: "Fits this posting.",
    rdiFit: "We would want them in the building.",
    suggestedSeat: "",
    ...over,
  };
}

function input(over: Partial<MapInput> = {}): MapInput {
  return {
    candidate: candidateRow,
    score: score(88),
    ro: null,
    overlay: null,
    application: { answers: null, cover_letter: "A real cover letter.", parsed_experience: [] },
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
      fitRead: fit("good"),
    },
    interviewEvidence: [],
    read: null,
    rank: 1,
    jobLocation: "Van Nuys, CA",
    jobShortcode: "JOB1",
    ...over,
  };
}

assert.equal(deriveDecisionDetail(input()).decision, "interview");
assert.equal(deriveDecisionDetail(input({ evals: { ...input().evals, fitRead: fit("neutral") } })).decision, "backup");
assert.equal(deriveDecisionDetail(input({ evals: { ...input().evals, fitRead: fit("negative") } })).decision, "reject");

// Leftover numeric scores and stored "Interview" reads do not invent a Good call.
const scoreOnly = deriveDecisionDetail(
  input({
    score: score(88),
    read: { decision: "interview", why: "Strong operator.", risk: "", next: "Interview" },
    evals: { ...input().evals, fitRead: null },
  }),
);
assert.equal(scoreOnly.decision, "blocked");

// Multi-role Good stays Good — the banner skips routing-only seats; the label does not.
assert.equal(
  deriveDecisionDetail(input({ jobShortcode: MULTI_ROLE_POOL })).decision,
  "interview",
);

// A human's own call always wins, including over a Negative read.
assert.equal(
  deriveDecisionDetail(input({ evals: { ...input().evals, fitRead: fit("negative") }, decisionOverride: "interview" }))
    .decision,
  "interview",
);

// A cut is terminal.
assert.equal(
  deriveDecisionDetail(
    input({
      candidate: { ...candidateRow, disqualified: true },
    }),
  ).decision,
  "reject",
);

const goodView = mapCandidate(input());
assert.equal(goodView.decision, "interview");
assert.match(goodView.why, /BSL-2/);
assert.equal(goodView.appliedFit, "Fits this posting.");
assert.equal(goodView.rdiFit, "We would want them in the building.");
assert.equal(goodView.interviewGate?.clears, true);

const routed = mapCandidate(
  input({
    evals: {
      ...input().evals,
      fitRead: fit("good", {
        appliedFit: "Wrong for this generic posting.",
        suggestedSeat: "Head of Clinical Operations",
      }),
    },
    jobShortcode: MULTI_ROLE_POOL,
  }),
);
assert.equal(routed.decision, "interview");
assert.equal(routed.suggestedSeat, "Head of Clinical Operations");
assert.equal(routed.appliedFit, "Wrong for this generic posting.");

console.log("from-supabase.test.ts: ok");
