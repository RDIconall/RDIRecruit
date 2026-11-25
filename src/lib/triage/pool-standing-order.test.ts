import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { AnswerGradePayload, CandidateRow, RoAssessmentRow, ScoreRow } from "../types.ts";
import { parseFitRead, type FitSentiment } from "./fit-read.ts";
import { mapCandidate, type MapInput } from "./from-supabase.ts";
import { assignPoolStanding, rankWeight, standingLabel } from "./ranking.ts";
import type { Candidate, DecisionRead, ValueRead } from "./types.ts";

/**
 * Spec for pool standing. These assertions fail while assignPoolStanding orders
 * a decision group by appliedAt. They pass once each group is ordered with
 * rankWeight (spec fit, then problem complexity, then answers, then salary value)
 * before overallRank and groupRank are assigned. Application time stays on the
 * candidate; it must not decide the standing number.
 *
 * Not covered here:
 * - sortBestNew / the triage inbox, whose contract is "newest inside a decision".
 * - The narrow pool board, which reorders rows with answers+spec fit and still
 *   prints the standing number from assignPoolStanding.
 * - A daily summary that merges several jobs. Per-pool overallRank values are
 *   not comparable across jobs; this file uses one job.
 */

const require = createRequire(import.meta.url);
const HOUR = 60 * 60 * 1000;

type AnswerBand = "strong" | "mixed" | "weak";

function iso(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * HOUR).toISOString();
}

function grades(band: AnswerBand): AnswerGradePayload[] {
  const owned = (n: number): AnswerGradePayload => ({
    question: `Owned question ${n}`,
    verdict: "OWNED",
    present: ["logged the deviation"],
    note: "",
    kind: "screen",
  });
  const surface = (n: number): AnswerGradePayload => ({
    question: `Surface question ${n}`,
    verdict: "SURFACE",
    present: [],
    note: "",
    kind: "screen",
  });
  const evasive = (n: number): AnswerGradePayload => ({
    question: `Evasive question ${n}`,
    verdict: "EVASIVE",
    present: [],
    note: "",
    kind: "screen",
  });
  if (band === "strong") return [owned(1), owned(2), owned(3)];
  if (band === "mixed") return [owned(1), surface(1), evasive(1)];
  return [surface(1), surface(2), surface(3)];
}

function row(id: string, name: string, appliedAt: string, disqualified = false): CandidateRow {
  return {
    workable_id: id,
    job_shortcode: "JOB1",
    name,
    email: null,
    phone: null,
    location: "Los Angeles, CA",
    stage: "Applied",
    stage_kind: null,
    disqualified,
    source: "applied",
    assignee_id: null,
    raw: null,
    photo_url: null,
    created_at: appliedAt,
    synced_at: appliedAt,
  };
}

function score(id: string, total: number, salaryValue: ScoreRow["salary_value"]): ScoreRow {
  return {
    id: `score-${id}`,
    candidate_id: id,
    rubric_version: 1,
    category_scores: { principal: 0, environment: 0, scope: 0, writing: 0, tenure: 0, local: 0 },
    total,
    salary_value: salaryValue,
    confidence: "high",
    model_version: "test",
    created_at: "2026-06-01T00:00:00.000Z",
  };
}

function ro(id: string, capability: string): RoAssessmentRow {
  return {
    id: `ro-${id}`,
    candidate_id: id,
    per_role: [],
    seat_stratum: capability,
    current_capability: capability,
    trajectory: null,
    text_confidence: null,
    basis: null,
    created_at: "2026-06-01T00:00:00.000Z",
  };
}

function applicant(input: {
  id: string;
  name: string;
  appliedAt: string;
  sentiment: FitSentiment;
  specVerdict: string;
  capability: string;
  answers: AnswerBand;
  salaryValue?: ScoreRow["salary_value"];
  ask?: string | null;
  value?: ValueRead;
  scoreTotal?: number;
  /** Board index rank from the recency pre-sort (1 = newest). Not pool standing. */
  boardRank?: number;
  disqualified?: boolean;
}): Candidate {
  const fit = parseFitRead({
    reply: `${input.name} submitted a public application with enough substance to grade.`,
    sentiment: input.sentiment,
    appliedFit: "Read against the posting they applied to.",
    rdiFit: "Read for whether RDI would want them.",
    suggestedSeat: "",
  });
  assert.ok(fit, "fit read payload must parse");

  const read: DecisionRead = {
    decision: "interview",
    why: fit.reply,
    risk: "",
    next: "Interview",
    rubricFit: {
      verdict: input.specVerdict,
      summary: input.specVerdict,
      strengths: [],
      gaps: [],
    },
    ...(input.value ? { value: input.value } : {}),
  };

  const mapped = mapCandidate({
    candidate: row(input.id, input.name, input.appliedAt, input.disqualified),
    score: score(input.id, input.scoreTotal ?? 70, input.salaryValue ?? "justified"),
    ro: ro(input.id, input.capability),
    overlay: null,
    application: {
      answers: { "How would you handle a missing source document?": "I would log it and escalate." },
      cover_letter: "I am applying for this posted role.",
      parsed_experience: [],
    },
    narrative: [],
    evals: {
      invest: {
        complement: "technician",
        head: "Work off the desk",
        removes: "monitoring load",
        vector: "priced about right",
        summary: "Applied through the public posting.",
        ask: input.ask === undefined ? "$120k" : input.ask,
      },
      dig: null,
      verification: null,
      roleReads: [],
      answerGrades: grades(input.answers),
      fitRead: fit,
    },
    interviewEvidence: [],
    read,
    rank: input.boardRank ?? 1,
    jobLocation: "Van Nuys, CA",
    jobShortcode: "JOB1",
    jobTitle: "Clinical Research Coordinator",
  } satisfies MapInput);

  assert.equal(mapped.appliedAt, input.appliedAt);
  return mapped;
}

function place(candidates: Candidate[], disqualified: (id: string) => boolean = () => false): Candidate[] {
  assignPoolStanding(candidates, disqualified);
  return candidates;
}

/** Weaker person is listed first, matching the recency pre-sort, so index order cannot hide a bad key. */
function expectWeightOrder(stronger: Candidate, weaker: Candidate, label: string): void {
  assert.ok(
    rankWeight(stronger) > rankWeight(weaker),
    `${label}: fixture must give the stronger applicant a higher rankWeight ` +
      `(${rankWeight(stronger)} vs ${rankWeight(weaker)})`,
  );
  place([weaker, stronger]);
  assert.equal(stronger.standing?.groupRank, 1, `${label}: stronger applicant is #1 in the decision group`);
  assert.equal(weaker.standing?.groupRank, 2, `${label}: weaker applicant is #2 in the decision group`);
  assert.equal(stronger.standing?.overallRank, 1, `${label}: stronger applicant is #1 in the pool`);
  assert.ok(
    (stronger.standing?.overallRank ?? 99) < (weaker.standing?.overallRank ?? 0),
    `${label}: overallRank follows strength`,
  );
}

test("pool standing and the daily email follow strength, not who applied last", async () => {
  // Same Good call, lower numeric score on the stronger file, so a leftover
  // score total cannot be the order. The later applicant is weaker on spec fit.
  const earlierStronger = applicant({
    id: "earlier-stronger",
    name: "Amina Shah",
    appliedAt: iso(30),
    sentiment: "good",
    specVerdict: "Strong fit",
    capability: "IIb",
    answers: "mixed",
    scoreTotal: 61,
    boardRank: 2,
  });
  const laterWeaker = applicant({
    id: "later-weaker",
    name: "Blake Ortiz",
    appliedAt: iso(1),
    sentiment: "good",
    specVerdict: "Partial fit",
    capability: "IVb",
    answers: "strong",
    scoreTotal: 94,
    boardRank: 1,
  });
  assert.equal(earlierStronger.decision, "interview");
  assert.equal(laterWeaker.decision, "interview");
  assert.equal(earlierStronger.specRead.level, "strong");
  assert.equal(laterWeaker.specRead.level, "mixed");
  assert.ok(rankWeight(earlierStronger) > rankWeight(laterWeaker));
  expectWeightOrder(earlierStronger, laterWeaker, "spec fit beats a newer, higher-complexity applicant");
  assert.equal(standingLabel(earlierStronger.standing), "1st of 2 good");
  assert.equal(standingLabel(laterWeaker.standing), "2nd of 2 good");

  // The other direction: a strength sort that merely flips recency still fails.
  expectWeightOrder(
    applicant({
      id: "newer-stronger-spec",
      name: "Newer Strong Spec",
      appliedAt: iso(1),
      sentiment: "good",
      specVerdict: "Strong fit",
      capability: "IIb",
      answers: "mixed",
      scoreTotal: 61,
    }),
    applicant({
      id: "older-weaker-spec",
      name: "Older Weak Spec",
      appliedAt: iso(30),
      sentiment: "good",
      specVerdict: "Partial fit",
      capability: "IVb",
      answers: "strong",
      scoreTotal: 94,
    }),
    "spec fit beats an older, higher-complexity applicant",
  );

  expectWeightOrder(
    applicant({
      id: "older-complex",
      name: "Older Complex",
      appliedAt: iso(20),
      sentiment: "good",
      specVerdict: "Strong fit",
      capability: "IVb",
      answers: "strong",
    }),
    applicant({
      id: "newer-simple",
      name: "Newer Simple",
      appliedAt: iso(2),
      sentiment: "good",
      specVerdict: "Strong fit",
      capability: "IIb",
      answers: "strong",
    }),
    "problem complexity beats a newer applicant at the same spec fit",
  );
  expectWeightOrder(
    applicant({
      id: "newer-complex",
      name: "Newer Complex",
      appliedAt: iso(2),
      sentiment: "good",
      specVerdict: "Strong fit",
      capability: "IVb",
      answers: "strong",
    }),
    applicant({
      id: "older-simple",
      name: "Older Simple",
      appliedAt: iso(20),
      sentiment: "good",
      specVerdict: "Strong fit",
      capability: "IIb",
      answers: "strong",
    }),
    "problem complexity beats an older applicant at the same spec fit",
  );

  const sameValue: ValueRead = {
    headline: "Solid candidate, fair ask",
    level: "fair",
    detail: "Held equal so only the answer read differs.",
  };
  expectWeightOrder(
    applicant({
      id: "older-answers",
      name: "Older Answers",
      appliedAt: iso(18),
      sentiment: "good",
      specVerdict: "Strong fit",
      capability: "IIIb",
      answers: "strong",
      value: sameValue,
    }),
    applicant({
      id: "newer-answers",
      name: "Newer Answers",
      appliedAt: iso(3),
      sentiment: "good",
      specVerdict: "Strong fit",
      capability: "IIIb",
      answers: "weak",
      value: sameValue,
    }),
    "answers beat a newer applicant when spec fit and complexity match",
  );
  expectWeightOrder(
    applicant({
      id: "newer-answers",
      name: "Newer Answers",
      appliedAt: iso(3),
      sentiment: "good",
      specVerdict: "Strong fit",
      capability: "IIIb",
      answers: "strong",
      value: sameValue,
    }),
    applicant({
      id: "older-answers",
      name: "Older Answers",
      appliedAt: iso(18),
      sentiment: "good",
      specVerdict: "Strong fit",
      capability: "IIIb",
      answers: "weak",
      value: sameValue,
    }),
    "answers beat an older applicant when spec fit and complexity match",
  );

  const strongValue: ValueRead = {
    headline: "Strong candidate, good value",
    level: "strong",
    detail: "Ask is justified by the work.",
  };
  const weakValue: ValueRead = {
    headline: "Rich ask for the evidence",
    level: "weak",
    detail: "The ask is ahead of the evidence.",
  };
  expectWeightOrder(
    applicant({
      id: "older-value",
      name: "Older Value",
      appliedAt: iso(16),
      sentiment: "good",
      specVerdict: "Strong fit",
      capability: "IIIb",
      answers: "strong",
      value: strongValue,
    }),
    applicant({
      id: "newer-value",
      name: "Newer Value",
      appliedAt: iso(4),
      sentiment: "good",
      specVerdict: "Strong fit",
      capability: "IIIb",
      answers: "strong",
      value: weakValue,
    }),
    "salary value beats a newer applicant when spec, complexity, and answers match",
  );
  expectWeightOrder(
    applicant({
      id: "newer-value",
      name: "Newer Value",
      appliedAt: iso(4),
      sentiment: "good",
      specVerdict: "Strong fit",
      capability: "IIIb",
      answers: "strong",
      value: strongValue,
    }),
    applicant({
      id: "older-value",
      name: "Older Value",
      appliedAt: iso(16),
      sentiment: "good",
      specVerdict: "Strong fit",
      capability: "IIIb",
      answers: "strong",
      value: weakValue,
    }),
    "salary value beats an older applicant when spec, complexity, and answers match",
  );

  for (const sentiment of ["neutral", "negative"] as const) {
    expectWeightOrder(
      applicant({
        id: `${sentiment}-older-strong`,
        name: `${sentiment} older`,
        appliedAt: iso(12),
        sentiment,
        specVerdict: "Strong fit",
        capability: "IVb",
        answers: "strong",
      }),
      applicant({
        id: `${sentiment}-newer-weak`,
        name: `${sentiment} newer`,
        appliedAt: iso(1),
        sentiment,
        specVerdict: "Partial fit",
        capability: "IIb",
        answers: "weak",
      }),
      `${sentiment} group uses the same strength order`,
    );
  }

  // A newer Neutral file can outscore a Good file and still sits behind that group.
  const good = applicant({
    id: "good-low",
    name: "Good Low",
    appliedAt: iso(40),
    sentiment: "good",
    specVerdict: "Partial fit",
    capability: "IIb",
    answers: "weak",
    value: weakValue,
  });
  const neutral = applicant({
    id: "neutral-high",
    name: "Neutral High",
    appliedAt: iso(0.1),
    sentiment: "neutral",
    specVerdict: "Strong fit",
    capability: "IVb",
    answers: "strong",
    value: strongValue,
  });
  assert.equal(good.decision, "interview");
  assert.equal(neutral.decision, "backup");
  assert.ok(rankWeight(neutral) > rankWeight(good));
  place([neutral, good]);
  assert.equal(good.standing?.overallRank, 1, "Good stays ahead of a stronger, newer Neutral file");
  assert.equal(neutral.standing?.groupRank, 1);
  assert.ok((good.standing?.overallRank ?? 99) < (neutral.standing?.overallRank ?? 0));

  const cut = applicant({
    id: "cut-newest",
    name: "Cut Newest",
    appliedAt: iso(0.05),
    sentiment: "good",
    specVerdict: "Strong fit",
    capability: "IVb",
    answers: "strong",
    disqualified: true,
  });
  const activeStrong = applicant({
    id: "active-strong",
    name: "Active Strong",
    appliedAt: iso(26),
    sentiment: "good",
    specVerdict: "Strong fit",
    capability: "IIIb",
    answers: "strong",
  });
  const activeWeak = applicant({
    id: "active-weak",
    name: "Active Weak",
    appliedAt: iso(2),
    sentiment: "good",
    specVerdict: "Partial fit",
    capability: "IIb",
    answers: "weak",
  });
  place([cut, activeWeak, activeStrong], (id) => id === cut.id);
  assert.equal(activeStrong.standing?.groupRank, 1, "a disqualified newer applicant does not take #1");
  assert.equal(activeWeak.standing?.groupRank, 2);
  assert.equal(activeStrong.standing?.activeTotal, 2);
  assert.equal(cut.standing, undefined);

  // Full pool the loader hands the board and the daily email.
  // Board recency order would be Casey, Blake, Amina, Dana. Strength order is not that.
  const dana = applicant({
    id: "dana",
    name: "Dana Okonkwo",
    appliedAt: iso(72),
    sentiment: "good",
    specVerdict: "Excellent direct fit",
    capability: "IVb",
    answers: "strong",
    value: strongValue,
    scoreTotal: 60,
    boardRank: 4,
  });
  const amina = applicant({
    id: "amina",
    name: "Amina Shah",
    appliedAt: iso(20),
    sentiment: "good",
    specVerdict: "Strong fit",
    capability: "IIIb",
    answers: "strong",
    value: strongValue,
    scoreTotal: 62,
    boardRank: 3,
  });
  const blake = applicant({
    id: "blake",
    name: "Blake Ortiz",
    appliedAt: iso(1),
    sentiment: "good",
    specVerdict: "Partial fit",
    capability: "IIb",
    answers: "mixed",
    scoreTotal: 93,
    boardRank: 2,
  });
  const casey = applicant({
    id: "casey",
    name: "Casey Ng",
    appliedAt: iso(0.2),
    sentiment: "neutral",
    specVerdict: "Strong fit",
    capability: "IVb",
    answers: "strong",
    value: strongValue,
    scoreTotal: 97,
    boardRank: 1,
  });
  assert.ok(rankWeight(dana) > rankWeight(amina));
  assert.ok(rankWeight(amina) > rankWeight(blake));
  assert.equal(blake.decision, "interview");
  assert.equal(casey.decision, "backup");

  const pool = place([casey, blake, amina, dana]);
  const board = [...pool].sort(
    (a, b) => (a.standing?.overallRank ?? 1e9) - (b.standing?.overallRank ?? 1e9),
  );
  assert.deepEqual(
    board.map((c) => c.id),
    ["dana", "amina", "blake", "casey"],
    "board order is overallRank, which follows strength inside Good, then the next decision group",
  );
  assert.equal(blake.standing?.groupRank, 3, "the newest Good applicant is not #1");
  assert.equal(amina.standing?.groupRank, 2);
  assert.equal(dana.standing?.groupRank, 1);

  const daily = await loadDailySummary(pool);
  const summary = await daily.collectDailySummary(24);
  assert.equal(summary.total, 3, "the applicant from outside the window is left out of the email");
  assert.equal(summary.top?.id, amina.id, "the email's top candidate is the strongest Good applicant still inside the window");
  assert.equal(summary.top?.fullName, "Amina Shah");
  assert.notEqual(summary.top?.id, blake.id);
  const html = daily.renderSummaryHtml(summary);
  const topAt = html.indexOf("Top candidate");
  const restAt = html.indexOf("Good");
  assert.ok(topAt >= 0);
  const topBlock = html.slice(topAt, restAt > topAt ? restAt : topAt + 800);
  assert.match(topBlock, /Amina/);
  assert.doesNotMatch(topBlock, /Blake/);
  assert.match(daily.summarySubject(summary), /top: Amina/);
  assert.match(daily.renderSummaryText(summary), /TOP CANDIDATE\nAmina —/);
  const goodGroup = summary.groups.find((g) => g.decision === "interview");
  assert.deepEqual(
    goodGroup?.candidates.map((c) => c.id),
    [blake.id],
    "the newer, weaker Good applicant is listed after the top candidate",
  );
});

type DailyModule = {
  collectDailySummary: (windowHours?: number) => Promise<{
    total: number;
    top: { id: string; fullName: string; firstName: string } | null;
    groups: Array<{ decision: string; candidates: Array<{ id: string }> }>;
  }>;
  renderSummaryHtml: (summary: never) => string;
  renderSummaryText: (summary: never) => string;
  summarySubject: (summary: never) => string;
};

/**
 * collectDailySummary loads jobs and the pool from Supabase, then sorts by the
 * standing those loaders already stored. Stub only those two reads. The sort,
 * the window filter, and the "Top candidate" render stay the real module.
 */
async function loadDailySummary(pool: Candidate[]): Promise<DailyModule> {
  const moduleCtor = require("module") as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const original = moduleCtor._load;
  moduleCtor._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "server-only" || request.includes("server-only")) return {};
    if (request.includes("jobs/service")) {
      return {
        getPublishedJobs: async () => [
          { shortcode: "JOB1", title: "Clinical Research Coordinator", status: "published" },
        ],
      };
    }
    if (
      request === "./load" ||
      request === "./load.ts" ||
      request.endsWith("/triage/load") ||
      request.endsWith("/triage/load.ts")
    ) {
      return { loadTriagePool: async () => ({ candidates: pool }) };
    }
    return original.call(this, request, parent, isMain);
  };
  try {
    return (await import("./daily-summary.ts")) as DailyModule;
  } finally {
    moduleCtor._load = original;
  }
}
