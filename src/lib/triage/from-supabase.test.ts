import assert from "node:assert/strict";
import type { AnswerGradePayload, CandidateRow, ScoreRow } from "../types";
import { deriveDecisionDetail, mapCandidate, type MapInput } from "./from-supabase";

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
    },
    interviewEvidence: [],
    read: null,
    rank: 1,
    jobLocation: "Van Nuys, CA",
    jobShortcode: "JOB1",
    ...over,
  };
}

// A file that holds the level with owned answers is an Interview.
assert.equal(deriveDecisionDetail(input()).decision, "interview");

// The borderline band is a Backup, not an Interview. This is the regression that
// put files nobody would call an A player onto the "screen first" list.
const borderline = deriveDecisionDetail(input({ score: score(68) }));
assert.equal(borderline.decision, "backup");
assert.equal(borderline.bar.clears, false);

// Competent but unremarkable — holds the level, nothing standout in the answers.
const competent = deriveDecisionDetail(
  input({
    score: score(78),
    evals: {
      ...input().evals,
      answerGrades: [grade("OWNED"), grade("SURFACE"), grade("AI")],
    },
  }),
);
assert.equal(competent.decision, "backup");
assert.match(competent.bar.reason ?? "", /stands out/);

// Surface answers cannot be interviewed on, whatever the total says.
const surface = deriveDecisionDetail(
  input({
    evals: {
      ...input().evals,
      answerGrades: [grade("SURFACE"), grade("SURFACE"), grade("SURFACE")],
    },
  }),
);
assert.equal(surface.decision, "backup");

// A stored model read cannot promote a file past the gate…
const modelSaysInterview = deriveDecisionDetail(
  input({
    score: score(62),
    read: { decision: "interview", why: "Strong operator.", risk: "", next: "Interview" },
  }),
);
assert.equal(modelSaysInterview.decision, "backup");
assert.equal(modelSaysInterview.ungated, "interview");
assert.equal(modelSaysInterview.demoted, true);
assert.ok(modelSaysInterview.demotionNote);

// …but a human's own call always wins.
assert.equal(
  deriveDecisionDetail(input({ score: score(62), decisionOverride: "interview" })).decision,
  "interview",
);

// Once there is live interview evidence, the triage bar steps aside.
assert.equal(
  deriveDecisionDetail(
    input({
      score: score(62),
      read: { decision: "interview", why: "Held up live.", risk: "", next: "Advance to next round" },
      interviewEvidence: [
        {
          id: "ev_1",
          candidate_id: "cand_1",
          source_type: "interview",
          author: null,
          label: "Phone screen",
          captured_at: "2026-06-10T00:00:00.000Z",
          raw_ref: null,
          transcript: "They walked through the deviation end to end.",
          extracted: null,
          created_at: "2026-06-10T00:00:00.000Z",
        },
      ],
    }),
  ).decision,
  "interview",
);

// The "Vs. spec" read is grounded in the rubric grading, never read back off the
// decision — a borderline file must not present as a strong fit.
const borderlineView = mapCandidate(input({ score: score(68) }));
assert.equal(borderlineView.specRead.level, "weak");
assert.notEqual(borderlineView.value.level, "strong");
assert.equal(borderlineView.next, "Hold as backup");
assert.equal(borderlineView.interviewGate?.clears, false);
assert.ok(borderlineView.caveat);

const strongView = mapCandidate(input());
assert.equal(strongView.specRead.level, "strong");
assert.equal(strongView.interviewGate?.clears, true);
assert.equal(strongView.survivor, true);

// A demoted file's copy names the reason instead of keeping the model's pitch.
const demotedView = mapCandidate(
  input({
    score: score(64),
    read: {
      decision: "interview",
      why: "Best operator in the pool.",
      risk: "",
      next: "Interview",
      value: { headline: "Strong operator, fair ask", level: "strong", detail: "Reads strong." },
    },
  }),
);
assert.equal(demotedView.decision, "backup");
assert.notEqual(demotedView.why, "Best operator in the pool.");
assert.equal(demotedView.value.level, "fair");

console.log("from-supabase.test.ts: ok");
