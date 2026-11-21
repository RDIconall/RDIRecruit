/**
 * Spec for the short-tenure bypass: a public applicant's blank end dates, and
 * completed ranges that measure zero months, must not read as a clean tenure.
 *
 * These tests fail while that behavior is still in the product. They should
 * pass once a role is current only when the end text says present/current/now/
 * ongoing or the current flag is set, a missing end stays unknown, zero-month
 * ranges still count, and unknown roles cannot act as a multi-year anchor or
 * keep the full tenure score.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { AnswerGradePayload, CandidateRow, ScoreRow } from "../types";
import type { NarrativeSegment } from "../types";
import { buildLifeNarrative } from "../narrative/builder";
import { narrativeFromParsedResume } from "../resume/narrative-from-parse";
import type { ParsedResumeReview } from "../resume/types";
import { createRequire } from "node:module";
import { buildSeatContext } from "../jobs/seat-context";
import { hasAnthropic } from "../env";
import type { EvaluatorInput } from "../scoring/evaluator";
import type { SeatDimension } from "../types";
import { mapCandidate, type MapInput } from "./from-supabase";
import type { FitRead } from "./fit-read";
import {
  analyzeTenureStability,
  capTenureCategoryScore,
  coalesceTenureRoles,
  roleFromPeriodSpan,
  roleTenureMonths,
  type TenureRole,
} from "./tenure-stability";

const NOW = new Date("2026-11-21T12:00:00Z");

/** Shape `parseExperience` writes onto applications.parsed_experience. */
function storedRole(input: {
  title: string;
  company: string;
  start: string | null;
  end: string | null;
  current?: boolean | null;
}): TenureRole {
  return {
    title: input.title,
    company: input.company,
    start: input.start,
    end: input.end,
    current: Boolean(input.current),
  };
}

/** Several short jobs whose end dates were left blank and not marked current. */
const blankEndRoles: TenureRole[] = [
  storedRole({ title: "Coordinator", company: "One", start: "2019-01-01", end: null, current: false }),
  storedRole({ title: "Coordinator", company: "Two", start: "2021-02-01", end: "", current: false }),
  storedRole({ title: "Coordinator", company: "Three", start: "2023-04-01", end: "   ", current: false }),
];

/** Completed stints that parse to zero months (same month, or a bare year). */
const zeroMonthRoles: TenureRole[] = [
  storedRole({ title: "Analyst", company: "March A", start: "2022-03-01", end: "2022-03-28", current: false }),
  storedRole({ title: "Analyst", company: "June B", start: "2023-06-02", end: "2023-06-20", current: false }),
  storedRole({ title: "Analyst", company: "Year C", start: "2024", end: "2024", current: false }),
];

const realShortRoles: TenureRole[] = [
  storedRole({ title: "EA", company: "Short A", start: "2023-01-01", end: "2023-08-01", current: false }),
  storedRole({ title: "EA", company: "Short B", start: "2024-01-01", end: "2024-09-01", current: false }),
];

const falseAnchorRoles: TenureRole[] = [
  ...realShortRoles,
  storedRole({ title: "EA", company: "Undated", start: "2015-01-01", end: null, current: false }),
];

const narrativeShorts: Array<{ title: string; company: string; span: string }> = [
  { title: "EA", company: "Alpha", span: "2022-01 – 2022-06" },
  { title: "EA", company: "Beta", span: "2023-01 – 2023-08" },
];

const WEIGHTS = {
  principal: 20,
  environment: 15,
  scope: 15,
  writing: 15,
  tenure: 20,
  local: 15,
} as const;

const candidateRow: CandidateRow = {
  workable_id: "cand_blank_end",
  job_shortcode: "JOB1",
  name: "Blank End",
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

function score(total: number): ScoreRow {
  return {
    id: "score_blank",
    candidate_id: candidateRow.workable_id,
    rubric_version: 1,
    category_scores: { principal: 20, environment: 15, scope: 15, writing: 15, tenure: 20, local: 15 },
    total,
    salary_value: "justified",
    confidence: "high",
    model_version: "test",
    created_at: "2026-06-01T00:00:00.000Z",
  };
}

function grade(): AnswerGradePayload {
  return {
    question: "How would you handle a missing source document?",
    answer: "I would escalate it to the study lead and log the deviation before the next monitoring visit.",
    verdict: "OWNED",
    present: ["deviation logging"],
    note: "",
    kind: "screen",
  };
}

function fit(): FitRead {
  return {
    reply: "Owned the monitoring stand-up; answers name real work.",
    sentiment: "good",
    appliedFit: "Fits this posting.",
    rdiFit: "We would want them in the building.",
    suggestedSeat: "",
  };
}

function dossier(roles: TenureRole[], narrative: NarrativeSegment[] = []): ReturnType<typeof mapCandidate> {
  const input: MapInput = {
    candidate: candidateRow,
    score: score(88),
    ro: null,
    overlay: null,
    application: {
      answers: { "How would you handle a missing source document?": grade().answer ?? "" },
      cover_letter: "A real cover letter about monitoring work.",
      parsed_experience: roles,
    },
    narrative,
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
      answerGrades: [grade(), grade(), grade()],
      fitRead: fit(),
    },
    interviewEvidence: [],
    read: null,
    rank: 1,
    jobLocation: "Van Nuys, CA",
    jobShortcode: "JOB1",
    jobTitle: "Clinical Research Associate",
  };
  return mapCandidate(input);
}

function evaluatorInput(roles: TenureRole[], extra: Partial<EvaluatorInput> = {}): EvaluatorInput {
  return {
    name: "Blank End",
    resumeText: "Coordinator roles listed with start dates only.",
    roles: roles.map((role) => ({
      title: role.title ?? "Role",
      company: role.company ?? "Company",
      start: role.start,
      end: role.end,
      current: role.current ?? false,
    })),
    answers: {},
    coverLetter: null,
    seat: buildSeatContext({ title: "Clinical Research Associate" }),
    weights: { ...WEIGHTS },
    ...extra,
  };
}

function modelMessage(body: unknown) {
  return {
    stop_reason: "end_turn" as const,
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
  };
}

/**
 * `evaluator.ts` reaches `server-only` through the grading log. tsx loads that
 * marker with require(), which throws outside a server bundle. Point that
 * require at the package's empty server entry — the same file Node loads under
 * the `react-server` condition — then import the real evaluator.
 */
const require = createRequire(import.meta.url);
let evaluatorModule: Promise<typeof import("../scoring/evaluator.ts")> | null = null;

function loadEvaluator() {
  if (!evaluatorModule) {
    const nodeModule = require("module") as {
      _resolveFilename: (
        request: string,
        parent: unknown,
        isMain: boolean,
        options: unknown,
      ) => string;
    };
    const empty = require.resolve("server-only").replace(/index\.js$/, "empty.js");
    const original = nodeModule._resolveFilename;
    nodeModule._resolveFilename = function (request, parent, isMain, options) {
      if (request === "server-only") return empty;
      return original.call(this, request, parent, isMain, options);
    };
    evaluatorModule = import("../scoring/evaluator.ts");
  }
  return evaluatorModule;
}

test("a blank end date is unknown, not ongoing employment through today", () => {
  for (const role of blankEndRoles) {
    assert.equal(roleTenureMonths(role, NOW), null, `${role.company} should not measure to today`);
  }
  const stability = analyzeTenureStability(blankEndRoles, NOW);
  assert.equal(stability.longAnchorCount, 0);
  assert.equal(stability.shortCompletedCount, 0);
  assert.match(stability.caveat ?? "", /tenure could not be measured/i);
  assert.ok(capTenureCategoryScore(10, 10, stability) < 10);
});

test("an explicit present end or current flag is still an open role", () => {
  const presentRole = storedRole({
    title: "EA",
    company: "Now",
    start: "2024-01-01",
    end: "Present",
    current: false,
  });
  const present = analyzeTenureStability([presentRole], NOW);
  assert.equal(present.shortCompletedCount, 0);
  assert.equal(present.caveat, null);
  assert.ok((roleTenureMonths(presentRole, NOW) ?? 0) > 0);

  const currentRole = storedRole({
    title: "EA",
    company: "Now",
    start: "2024-01-01",
    end: "2024-04-01",
    current: true,
  });
  const flaggedCurrent = analyzeTenureStability([currentRole], NOW);
  assert.equal(flaggedCurrent.shortCompletedCount, 0);
  assert.equal(flaggedCurrent.caveat, null);
  assert.ok((roleTenureMonths(currentRole, NOW) ?? 0) > 0);
});

test("a missing end on a period span is not rewritten into a current role", () => {
  const role = roleFromPeriodSpan("Coordinator", "One", "2019-01");
  assert.ok(role);
  assert.equal(role!.current, false);
  assert.equal(roleTenureMonths(role!, NOW), null);
  const stability = analyzeTenureStability([role!], NOW);
  assert.match(stability.caveat ?? "", /tenure could not be measured/i);
  assert.equal(stability.longAnchorCount, 0);
});

test("zero-month completed ranges still count as short stints", () => {
  const stability = analyzeTenureStability(zeroMonthRoles, NOW);
  assert.equal(stability.shortCompletedCount, zeroMonthRoles.length);
  assert.equal(stability.severity, "severe");
  assert.equal(stability.longAnchorCount, 0);
  assert.match(stability.caveat ?? "", /short[- ]tenure|short stint/i);
  assert.match(stability.flagDetail ?? "", /no multi-year anchor/);
  assert.equal(capTenureCategoryScore(10, 10, stability), 2);
});

test("a same-year range that spans several months is still a short stint", () => {
  const stability = analyzeTenureStability(
    [
      storedRole({ title: "EA", company: "A", start: "2023-01-01", end: "2023-11-01", current: false }),
      storedRole({ title: "EA", company: "B", start: "2024-01-01", end: "2024-10-01", current: false }),
    ],
    NOW,
  );
  assert.equal(stability.severity, "severe");
  assert.equal(stability.shortCompletedCount, 2);
});

test("a blank end cannot serve as the multi-year anchor that softens a hopping pattern", () => {
  const stability = analyzeTenureStability(falseAnchorRoles, NOW);
  assert.equal(stability.shortCompletedCount, 2);
  assert.equal(stability.longAnchorCount, 0);
  assert.equal(stability.severity, "severe");
  assert.match(stability.flagDetail ?? "", /no multi-year anchor/);
  assert.match(stability.caveat ?? "", /tenure could not be measured/i);
  assert.equal(capTenureCategoryScore(10, 10, stability), 2);
});

test("blank structured dates do not hide narrative dates that show short stints", () => {
  const structured = [
    storedRole({ title: "Coordinator", company: "Form A", start: "2024-01-01", end: null, current: false }),
    storedRole({ title: "Coordinator", company: "Form B", start: "2025-01-01", end: null, current: false }),
  ];
  const roles = coalesceTenureRoles(structured, narrativeShorts);
  const stability = analyzeTenureStability(roles, NOW);
  assert.equal(stability.severity, "severe");
  assert.equal(stability.longAnchorCount, 0);
  assert.ok(stability.shortCompletedCount >= 2);
  assert.match(stability.flagDetail ?? "", /no multi-year anchor/);
});

test("the life narrative does not relabel a blank end as present", () => {
  const segments = buildLifeNarrative({
    experience: blankEndRoles.map((role) => ({
      title: role.title ?? "Role",
      company: role.company ?? "Company",
      start: role.start ?? undefined,
      end: role.end ?? undefined,
      current: Boolean(role.current),
    })),
    education: [],
  });
  const roleSpans = segments.filter((segment) => segment.type === "role");
  assert.equal(roleSpans.length, blankEndRoles.length);
  for (const segment of roleSpans) {
    assert.doesNotMatch(segment.span, /present|current|now|ongoing/i);
  }

  const view = dossier(blankEndRoles, segments);
  assert.match(view.caveat ?? "", /tenure could not be measured/i);
  assert.equal(
    view.redFlags.some((flag) => /short[- ]tenure/i.test(flag.flag) && /no multi-year anchor/i.test(flag.detail)),
    false,
  );
  for (const role of view.resume.roles) {
    assert.equal(role.current, false);
    assert.doesNotMatch(role.period, /present|current|now|ongoing/i);
  }
});

test("résumé narrative spans keep a missing end unknown", () => {
  const parsed = {
    chronologySummary: "",
    dateFlags: [],
    roles: blankEndRoles.map((role) => ({
      title: role.title ?? "Role",
      company: role.company ?? "Company",
      start: role.start ?? null,
      end: null,
      current: false,
      bullets: [],
      resumeLine: "",
    })),
    education: [],
    gaps: [],
    modelVersion: "test",
    parsedAt: "2026-11-21T00:00:00.000Z",
  } satisfies ParsedResumeReview;
  const segments = narrativeFromParsedResume(parsed);
  for (const segment of segments.filter((item) => item.type === "role")) {
    assert.doesNotMatch(segment.span, /present|current|now|ongoing/i);
  }
});

test("the hiring file keeps narrative short-stint warnings when structured end dates are blank", () => {
  const view = dossier(blankEndRoles, [
    { span: "2022-01 – 2022-06", type: "role", text: "EA at Alpha" },
    { span: "2023-01 – 2023-08", type: "role", text: "EA at Beta" },
  ]);
  assert.match(view.caveat ?? "", /short[- ]tenure|short stint/i);
  assert.ok(
    view.redFlags.some(
      (flag) => /short[- ]tenure/i.test(flag.flag) && /no multi-year anchor/i.test(flag.detail),
    ),
  );
});

test("the hiring file flags zero-month stints and does not call them present", () => {
  const view = dossier(zeroMonthRoles);
  assert.match(view.caveat ?? "", /short[- ]tenure|short stint/i);
  assert.ok(view.redFlags.some((flag) => /short[- ]tenure/i.test(flag.flag)));
  assert.ok(view.redFlags.some((flag) => /no multi-year anchor/i.test(flag.detail)));
});

test("the evaluator caps a full tenure score when end dates are blank", async () => {
  const { parseEvaluatorMessage } = await loadEvaluator();
  const input = evaluatorInput(blankEndRoles);
  const evaluation = parseEvaluatorMessage(
    modelMessage({
      categoryScores: { ...WEIGHTS },
      summary: "Looks steady.",
    }),
    input,
  );
  assert.ok(evaluation);
  assert.ok(evaluation!.categoryScores.tenure < WEIGHTS.tenure);
  assert.ok(evaluation!.total < 100);
});

test("the evaluator caps the seat-dimension total when end dates are blank", async () => {
  const { parseEvaluatorMessage } = await loadEvaluator();
  const dimensions: SeatDimension[] = [
    {
      key: "ownership",
      label: "Ownership",
      weight: 100,
      description: "Owns the work.",
      evidenceRequirements: ["a named outcome"],
    },
  ];
  const input = evaluatorInput(blankEndRoles, {
    rubricSchemaVersion: "seat-dimensions-v2",
    dimensions,
  });
  const evaluation = parseEvaluatorMessage(
    modelMessage({
      categoryScores: { ...WEIGHTS },
      seatDimensionScores: { ownership: 80 },
      summary: "Looks steady.",
    }),
    input,
  );
  assert.ok(evaluation);
  assert.ok(evaluation!.total < 80);
});

test("the evaluator keeps full tenure points for a measured multi-year role", async () => {
  const { parseEvaluatorMessage } = await loadEvaluator();
  const input = evaluatorInput([
    storedRole({ title: "EA", company: "Long", start: "2018-01-01", end: "2024-01-01", current: false }),
  ]);
  const evaluation = parseEvaluatorMessage(
    modelMessage({ categoryScores: { ...WEIGHTS }, summary: "Long tenure." }),
    input,
  );
  assert.ok(evaluation);
  assert.equal(evaluation!.categoryScores.tenure, WEIGHTS.tenure);
});

test("the heuristic fallback also reduces tenure points when ends are blank", async (t) => {
  if (hasAnthropic()) {
    t.skip("heuristic fallback runs only when no model key is configured");
    return;
  }
  const { evaluateCandidateWithUsage } = await loadEvaluator();
  const blank = await evaluateCandidateWithUsage(evaluatorInput(blankEndRoles));
  const measured = await evaluateCandidateWithUsage(
    evaluatorInput([
      storedRole({ title: "EA", company: "Long", start: "2018-01-01", end: "2024-01-01", current: false }),
    ]),
  );
  assert.ok(blank.evaluation.categoryScores.tenure < measured.evaluation.categoryScores.tenure);
  assert.equal(blank.evaluation.heuristic, true);
});
