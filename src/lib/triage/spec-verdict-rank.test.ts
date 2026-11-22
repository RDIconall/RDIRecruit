/**
 * Spec-ranking contract for a free-text rubric verdict.
 *
 * The grader is asked for one of four labels (Strong fit, Partial fit, Weak fit,
 * Misaligned) but stores whatever sentence the model returns. The pool then
 * turns that sentence into the Vs. spec level by substring. These tests pin the
 * order a reviewer actually works:
 *
 * - An exact, case-insensitive label keeps the level the board already gives
 *   that label: Strong fit → strong, Partial fit → mixed, Weak fit → weak,
 *   Misaligned → mixed ("miss" is not a substring of "misaligned").
 * - Every other sentence, including negations and job titles that merely contain
 *   strong / excellent / direct, is mixed.
 * - Mobile list order (answers + spec) and the Vs. spec column both use that
 *   level's weight, so a negated sentence cannot sit above a Partial fit or a
 *   real Strong fit. A numeric score in the advance band must not be able to
 *   restore a strong level once a sentence is present.
 *
 * They fail while the substring classifier is in place.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AnswerGradePayload, CandidateRow, CategoryKey, ScoreRow } from "../types";
import { decisionReadFromEvaluation } from "../analysis/decision";
import type { EvaluatorInput } from "../scoring/evaluator";
import { fitWeight, verdictDot, valueWeight } from "./app-theme";
import { mapCandidate, type MapInput } from "./from-supabase";
import type { FitRead } from "./fit-read";
import { rankWeight } from "./ranking";
import type { Candidate, DecisionRead } from "./types";

const WEIGHTS: Record<CategoryKey, number> = {
  principal: 20,
  environment: 15,
  scope: 20,
  writing: 15,
  tenure: 15,
  local: 15,
};

const FALSE_STRONG_SENTENCES = [
  "not a strong fit",
  "Not a strong fit",
  "no direct experience",
  "No direct experience with this assay",
  "indirect experience only",
  "Director of clinical operations without the seat's required work",
  "excellent writing, but a poor match to the rubric",
  "weak fit overall despite a strong résumé keyword",
  "strongly recommended against",
  "Strong fit.",
  "Partial fit for a director track",
];

function candidateRow(id: string): CandidateRow {
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
    source: "applied",
    assignee_id: null,
    raw: null,
    photo_url: null,
    created_at: "2026-06-01T00:00:00.000Z",
    synced_at: "2026-06-01T00:00:00.000Z",
  };
}

function score(total: number, id: string): ScoreRow {
  return {
    id: `score_${id}`,
    candidate_id: id,
    rubric_version: 1,
    category_scores: { principal: 0, environment: 0, scope: 0, writing: 0, tenure: 0, local: 0 },
    total,
    salary_value: "justified",
    confidence: "high",
    model_version: "test",
    created_at: "2026-06-01T00:00:00.000Z",
  };
}

function grade(verdict: AnswerGradePayload["verdict"], question: string): AnswerGradePayload {
  return {
    question,
    answer: "I logged the deviation with the study lead before the next visit.",
    verdict,
    present: verdict === "OWNED" ? ["deviation logging"] : [],
    note: "",
    kind: "screen",
  };
}

/** One owned, one surface, one evasive → mixed answers, so spec decides the fit sort. */
function mixedGrades(): AnswerGradePayload[] {
  return [
    grade("OWNED", "How would you handle a missing source document?"),
    grade("SURFACE", "Describe a monitoring visit you owned."),
    grade("EVASIVE", "What would you change about the protocol?"),
  ];
}

function fit(sentiment: FitRead["sentiment"]): FitRead {
  return {
    reply: "Answers name real monitoring work.",
    sentiment,
    appliedFit: "Fits this posting.",
    rdiFit: "Worth a look for this seat.",
    suggestedSeat: "",
  };
}

function decisionRead(verdict: string): DecisionRead {
  return {
    decision: "interview",
    why: "Stored grader read.",
    risk: "The seat's required work is not demonstrated.",
    next: "Interview",
    rubricFit: {
      verdict,
      summary: "Read against this seat's rubric.",
      strengths: [],
      gaps: ["required work not shown"],
    },
    value: {
      headline: "Strength supports the ask",
      level: "strong",
      detail: "Model strength-vs-salary read.",
    },
  };
}

/**
 * Score stays in the advance band (90). If the verdict were dropped, specReadFrom
 * would fall through to "Clears the bar" / strong. A mixed level can only come
 * from classifying the sentence itself.
 */
function mapped(id: string, verdict: string, total = 90): Candidate {
  const input: MapInput = {
    candidate: candidateRow(id),
    score: score(total, id),
    ro: null,
    overlay: null,
    application: {
      answers: {
        "How would you handle a missing source document?": "I logged the deviation.",
      },
      cover_letter: "Cover letter on file.",
      parsed_experience: [],
      resume_text: "Clinical research associate. No direct experience running the assay.",
    },
    narrative: [],
    evals: {
      invest: {
        complement: "technician",
        head: "Work off the desk",
        removes: "monitoring load",
        vector: "priced about right",
        summary: "Runs monitoring.",
        ask: "$120k",
      },
      dig: null,
      verification: null,
      roleReads: [],
      answerGrades: mixedGrades(),
      fitRead: fit("good"),
    },
    interviewEvidence: [],
    read: decisionRead(verdict),
    rank: 1,
    jobLocation: "Van Nuys, CA",
    jobShortcode: "JOB1",
  };
  return mapCandidate(input);
}

/** pool-board.tsx mobile group order: answers weight + spec weight, then input order. */
function mobileOrder(rows: Candidate[]): string[] {
  return rows
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const fitOf = (c: Candidate) => fitWeight(c.answersRead.level) + fitWeight(c.specRead.level);
      return fitOf(b.c) - fitOf(a.c) || a.i - b.i;
    })
    .map((x) => x.c.id);
}

/** pool-table.tsx "Vs. spec" column: fitWeight(specRead.level), higher first, then input order. */
function specColumnOrder(rows: Candidate[]): string[] {
  return rows
    .map((c, i) => ({ c, i }))
    .sort(
      (a, b) => fitWeight(b.c.specRead.level) - fitWeight(a.c.specRead.level) || a.i - b.i,
    )
    .map((x) => x.c.id);
}

/**
 * parseEvaluatorMessage lives in the server grader, which imports the
 * `server-only` marker. Next resolves that package's react-server export
 * (empty.js) on the server. This test runs in plain Node, so point the same
 * marker at that file before loading the grader. The marker has no logic.
 */
function loadEvaluator(): typeof import("../scoring/evaluator") {
  const require = createRequire(path.join(process.cwd(), "package.json"));
  const nodeModule = require("node:module") as {
    _resolveFilename: (
      request: string,
      parent: unknown,
      isMain: boolean,
      options: unknown,
    ) => string;
  };
  const empty = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../node_modules/server-only/empty.js",
  );
  const orig = nodeModule._resolveFilename;
  nodeModule._resolveFilename = function (request, parent, isMain, options) {
    if (request === "server-only") return empty;
    return orig.call(this, request, parent, isMain, options);
  };
  return require("./src/lib/scoring/evaluator.ts") as typeof import("../scoring/evaluator");
}

function evaluatorInput(resumeText: string): EvaluatorInput {
  return {
    name: "Applicant",
    resumeText,
    roles: [],
    answers: {
      "How would you handle a missing source document?":
        "I would escalate it. I have no direct experience with this assay.",
    },
    coverLetter: "I am not a strong fit for the bench work in this posting.",
    seat: {
      jobTitle: "Clinical Research Associate",
      seatStratum: "III",
      jdSummary: "Owns monitoring visits for the posted study.",
      categoryLabels: {
        principal: "Principal",
        environment: "Environment",
        scope: "Scope",
        writing: "Writing",
        tenure: "Tenure",
        local: "Local",
      },
      jobShortcode: "JOB1",
    },
    weights: WEIGHTS,
  };
}

function modelMessage(verdict: string) {
  const body = {
    categoryScores: {
      principal: 8,
      environment: 8,
      scope: 8,
      writing: 8,
      tenure: 8,
      local: 8,
    },
    summary: "The application does not show the seat's required work.",
    answerGrades: [
      {
        question: "How would you handle a missing source document?",
        verdict: "SURFACE",
        note: "Names a step but not this assay.",
      },
    ],
    triage: {
      why: "The materials do not show the required assay work.",
      risk: "No demonstrated ownership of the posted work.",
      rubricFit: {
        verdict,
        summary: "The sentence is the model's rubric verdict, not one of the four labels.",
        strengths: [],
        gaps: ["required work not shown"],
      },
    },
  };
  return {
    stop_reason: "end_turn" as const,
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
  };
}

test("exact rubric labels keep a single spec level and weight", () => {
  const strong = mapped("exact-strong", "Strong fit");
  const strongFolded = mapped("exact-strong-folded", "  sTrOnG fIt  ");
  const partial = mapped("exact-partial", "Partial fit");
  const weak = mapped("exact-weak", "Weak fit");
  const misaligned = mapped("exact-misaligned", "Misaligned");

  assert.equal(strong.specRead.level, "strong");
  assert.equal(fitWeight(strong.specRead.level), 2);
  assert.equal(strongFolded.specRead.level, "strong");
  assert.equal(partial.specRead.level, "mixed");
  assert.equal(fitWeight(partial.specRead.level), 1);
  assert.equal(weak.specRead.level, "weak");
  assert.equal(fitWeight(weak.specRead.level), 0);
  assert.equal(misaligned.specRead.level, "mixed");
  assert.equal(fitWeight(misaligned.specRead.level), 1);
  assert.equal(verdictDot(strong.specRead.level).fill, verdictDot("strong").fill);
  assert.notEqual(verdictDot(partial.specRead.level).fill, verdictDot("strong").fill);
});

for (const sentence of FALSE_STRONG_SENTENCES) {
  test(`free-text spec verdict stays mixed: ${sentence}`, () => {
    const view = mapped(`false:${sentence}`, sentence);
    assert.equal(view.answersRead.level, "mixed", sentence);
    assert.equal(view.specRead.level, "mixed", sentence);
    assert.equal(fitWeight(view.specRead.level), 1, sentence);
    assert.notEqual(verdictDot(view.specRead.level).fill, verdictDot("strong").fill, sentence);
    assert.notEqual(view.specRead.label.toLowerCase(), "strong fit", sentence);
  });
}

test("the same sentence stays mixed when the numeric score is in the advance band or below it", () => {
  for (const total of [90, 40]) {
    const view = mapped(`band-${total}`, "not a strong fit", total);
    assert.equal(view.specRead.level, "mixed", `total ${total}`);
    assert.equal(fitWeight(view.specRead.level), 1, `total ${total}`);
  }
});

test("mobile list does not place the negated sentence above Partial fit or an exact Strong fit", () => {
  const partial = mapped("partial", "Partial fit");
  const negated = mapped("negated", "not a strong fit");
  const weak = mapped("weak", "Weak fit");
  const strong = mapped("strong", "Strong fit");
  assert.deepEqual(mobileOrder([partial, negated, weak, strong]), [
    "strong",
    "partial",
    "negated",
    "weak",
  ]);
});

test("Vs. spec column sort does not place the negated sentence above Partial fit", () => {
  const partial = mapped("spec-partial", "Partial fit");
  const negated = mapped("spec-negated", "not a strong fit");
  const weak = mapped("spec-weak", "Weak fit");
  const strong = mapped("spec-strong", "Strong fit");
  assert.deepEqual(specColumnOrder([partial, negated, weak, strong]), [
    "spec-strong",
    "spec-partial",
    "spec-negated",
    "spec-weak",
  ]);
  assert.ok(
    rankWeight({ ...partial, roLevel: "IV" }) > rankWeight({ ...negated, roLevel: "II" }),
    "a partial fit with harder demonstrated work stays ahead of the negated sentence",
  );
});

test("a false strong spec read cannot keep a strong strength-vs-salary rank", () => {
  const negated = mapped("value-negated", "no direct experience");
  const strong = mapped("value-strong", "Strong fit");
  assert.equal(negated.value?.level, "fair");
  assert.equal(strong.value?.level, "strong");
  assert.ok(valueWeight(negated.value?.level ?? "none") < valueWeight(strong.value?.level ?? "none"));
});

test("applicant materials reach the grader, and a free-text verdict is what the board ranks", () => {
  const { buildEvaluatorRequest, parseEvaluatorMessage } = loadEvaluator();
  const resume = "Résumé: no direct experience running the posted assay. Not a strong fit.";
  const request = buildEvaluatorRequest(evaluatorInput(resume));
  const user = request.messages[0]?.content;
  assert.equal(typeof user, "string");
  assert.ok(String(user).includes(resume));
  assert.ok(String(user).includes("no direct experience with this assay"));
  assert.ok(String(user).includes("not a strong fit for the bench work"));

  const parsed = parseEvaluatorMessage(modelMessage("not a strong fit"), evaluatorInput(resume));
  assert.ok(parsed, "a model reply that carries the sentence is a usable evaluation");

  const read = decisionReadFromEvaluation(parsed, false, "test-model");
  const storedVerdict = read.rubricFit?.verdict?.trim() ?? "";
  assert.ok(storedVerdict, "the scorer keeps a rubric verdict for the board to rank");

  const view = mapped("from-model", storedVerdict);
  assert.equal(view.specRead.level, "mixed", `stored verdict ${JSON.stringify(storedVerdict)}`);
  assert.equal(fitWeight(view.specRead.level), 1);
  assert.equal(view.decision, "interview");

  const partial = mapped("from-model-partial", "Partial fit");
  assert.deepEqual(mobileOrder([partial, view]), ["partial", view.id]);
  assert.deepEqual(specColumnOrder([partial, view]), ["partial", view.id]);
});
