import test from "node:test";
import assert from "node:assert/strict";

import {
  parseRubricMarkdown,
  rubricWeightTotal,
} from "../src/lib/rubric/parser.ts";
import {
  getBuiltinSeatRubric,
  HEAD_CLINICAL_OPS,
  MULTI_ROLE_POOL,
  seatRubricMarkdown,
} from "../src/lib/rubric/seat-rubrics.ts";
import {
  applySeatGates,
  hasMaterialSyntheticExpertise,
  legacyCategoriesFromSeatTotal,
  normalizeSeatDimensionScores,
  resolveSeatTotal,
} from "../src/lib/scoring/seat-fit.ts";
import type { AnswerGradePayload } from "../src/lib/types.ts";
import {
  MAX_WORKABLE_EVENT_ATTEMPTS,
  eventFailureStatus,
  shouldRetryEvent,
} from "../src/lib/sync/event-queue.ts";
import {
  WorkableApiError,
  isPermanentWorkableNotFound,
  isRetryableWorkableStatus,
} from "../src/lib/workable/errors.ts";

test("dynamic rubric parser reads seat dimensions totaling 100 and critical minimums", () => {
  const rubric = getBuiltinSeatRubric({ shortcode: HEAD_CLINICAL_OPS });
  assert.ok(rubric);

  const parsed = parseRubricMarkdown(seatRubricMarkdown(rubric));

  assert.equal(parsed.schemaVersion, "seat-dimensions-v2");
  assert.equal(rubricWeightTotal(parsed.dimensions), 100);
  assert.equal(parsed.dimensions.find((d) => d.key === "end_to_end_clinical_delivery_ownership")?.criticalMinimum, 8);
});

test("gates override a high numeric score", () => {
  const adjustment = applySeatGates({
    rawTotal: 92,
    dimensions: [],
    dimensionScores: {},
    integrityGate: {
      status: "fail",
      concern: "MATERIAL_SYNTHETIC_EXPERTISE",
      note: "Unsupported likely-synthetic proposal expertise.",
    },
  });

  assert.equal(adjustment.total, 54);
  assert.equal(adjustment.band, "PASS");
  assert.equal(adjustment.capped, true);
});

test("critical dimension minimum caps below interview-first without deleting the score", () => {
  const rubric = getBuiltinSeatRubric({ shortcode: HEAD_CLINICAL_OPS });
  assert.ok(rubric);
  const parsed = parseRubricMarkdown(seatRubricMarkdown(rubric));
  const scores = normalizeSeatDimensionScores(
    Object.fromEntries(parsed.dimensions.map((d) => [d.key, d.weight])),
    parsed.dimensions,
  );
  scores.end_to_end_clinical_delivery_ownership = 7;

  const adjustment = applySeatGates({
    rawTotal: 91,
    dimensions: parsed.dimensions,
    dimensionScores: scores,
  });

  assert.equal(adjustment.total, 84);
  assert.equal(adjustment.band, "VIABLE");
  assert.match(adjustment.capReasons.join("\n"), /critical minimum/i);
});

test("v2 totals fall back to legacy categories when seat dimensions are missing", () => {
  const rubric = getBuiltinSeatRubric({ shortcode: HEAD_CLINICAL_OPS });
  assert.ok(rubric);
  const parsed = parseRubricMarkdown(seatRubricMarkdown(rubric));
  const empty = normalizeSeatDimensionScores(undefined, parsed.dimensions);
  const total = resolveSeatTotal({
    schemaVersion: "seat-dimensions-v2",
    dimensions: parsed.dimensions,
    dimensionScores: empty,
    legacyTotal: 82,
  });
  assert.equal(total, 82);
});

test("excellent likely-synthetic unsupported answer gets zero capability credit", () => {
  const grades: AnswerGradePayload[] = [
    {
      question: "How would you price the proposal?",
      answer: "A polished RFP pricing answer.",
      verdict: "AI",
      answerQuality: "excellent",
      answerProvenance: "unsupported",
      authorshipConfidence: "likely_synthetic",
      candidateEvidenceCredit: "zero",
      present: ["pricing", "scope tradeoffs"],
      note: "Excellent answer, unsupported by career record.",
      kind: "screen",
    },
  ];

  assert.equal(hasMaterialSyntheticExpertise(grades), true);
  const adjustment = applySeatGates({
    rawTotal: 88,
    dimensions: [],
    dimensionScores: {},
    answerGrades: grades,
  });
  assert.equal(adjustment.total, 88);
  assert.equal(adjustment.capped, false);
});

test("experience-backed AI assistance is not a synthetic expertise failure", () => {
  const grades: AnswerGradePayload[] = [
    {
      question: "How do you use AI?",
      answer: "I use it to map code, then verify by reading tests and traces.",
      verdict: "OWNED",
      answerQuality: "excellent",
      answerProvenance: "experience_backed",
      authorshipConfidence: "likely_ai_assisted",
      candidateEvidenceCredit: "high",
      present: ["AI verification", "production ownership"],
      note: "Backed by production engineering history.",
      kind: "screen",
    },
  ];

  assert.equal(hasMaterialSyntheticExpertise(grades), false);
  const adjustment = applySeatGates({
    rawTotal: 89,
    dimensions: [],
    dimensionScores: {},
    answerGrades: grades,
  });
  assert.equal(adjustment.total, 89);
});

test("generic multi-role posting is parsed as routing rather than fake seat fit", () => {
  const rubric = getBuiltinSeatRubric({ shortcode: MULTI_ROLE_POOL });
  assert.ok(rubric);
  assert.equal(rubric.routingOnly, true);

  const parsed = parseRubricMarkdown(seatRubricMarkdown(rubric));
  assert.equal(parsed.schemaVersion, "seat-dimensions-v2");
  assert.equal(rubricWeightTotal(parsed.dimensions), 100);
});

test("RO maturation assumptions are not inputs to seat-fit gate math", () => {
  const dimensions = [
    { key: "delivery", label: "Delivery", weight: 100, description: "", evidenceRequirements: [] },
  ];
  const dimensionScores = { delivery: 86 };

  const youngerAssumption = applySeatGates({ rawTotal: 86, dimensions, dimensionScores });
  const olderAssumption = applySeatGates({ rawTotal: 86, dimensions, dimensionScores });

  assert.deepEqual(youngerAssumption, olderAssumption);
});

test("legacy compatibility categories preserve the adjusted total", () => {
  const categories = legacyCategoriesFromSeatTotal(84, {
    principal: 25,
    environment: 20,
    scope: 20,
    writing: 15,
    tenure: 10,
    local: 10,
  });

  assert.equal(Object.values(categories).reduce((sum, value) => sum + value, 0), 84);
});

test("Workable 404 is permanent, 429 and 5xx are bounded retryable", () => {
  assert.equal(isPermanentWorkableNotFound(new WorkableApiError(404, "/candidates/missing", "not found")), true);
  assert.equal(isPermanentWorkableNotFound(new Error("profile photo not found on CDN")), false);
  assert.equal(isPermanentWorkableNotFound(new Error("timeout 404ms later")), false);
  assert.equal(isRetryableWorkableStatus(429), true);
  assert.equal(isRetryableWorkableStatus(503), true);
  assert.equal(isRetryableWorkableStatus(400), false);
});

test("title routing does not steal unrelated engineer or monitoring jobs", () => {
  assert.equal(getBuiltinSeatRubric({ title: "Clinical Data Engineer" }), null);
  assert.equal(getBuiltinSeatRubric({ title: "Software QA Analyst" }), null);
  assert.equal(getBuiltinSeatRubric({ title: "Site Monitoring Coordinator" }), null);
  assert.ok(getBuiltinSeatRubric({ title: "Founding Product Engineer - Clinical Systems" }));
  assert.ok(getBuiltinSeatRubric({ shortcode: HEAD_CLINICAL_OPS }));
});

test("event retry policy stops after the bounded retry budget", () => {
  assert.equal(shouldRetryEvent("pending", 0), true);
  assert.equal(shouldRetryEvent("retryable_failure", MAX_WORKABLE_EVENT_ATTEMPTS), false);
  assert.equal(
    eventFailureStatus(new Error("temporary timeout"), MAX_WORKABLE_EVENT_ATTEMPTS),
    "permanent_failure",
  );
  assert.equal(
    eventFailureStatus(new WorkableApiError(404, "/candidates/missing", "not found"), 1),
    "permanent_failure",
  );
});
