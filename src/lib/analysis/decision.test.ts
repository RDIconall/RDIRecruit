import assert from "node:assert/strict";
import test from "node:test";
import { decisionReadFromEvaluation } from "./decision.ts";

function source(over: Record<string, unknown> = {}) {
  return {
    total: 82,
    decisionBand: "VIABLE",
    integrityGate: { status: "clear", note: "" },
    otherGateResults: [],
    answerGrades: [{ verdict: "OWNED" }],
    salaryValue: "justified",
    salaryAsk: "$120k",
    triage: {
      why: "Owns the work end to end.",
      risk: "Confirm scale live.",
      assessment: { bio: "Bio", application: "Application", commute: "Commute" },
    },
    ...over,
  };
}

test("canonical evaluation derives the pre-interview action", () => {
  const read = decisionReadFromEvaluation(source() as never, false, "test-model");
  assert.equal(read.decision, "interview");
  assert.equal(read.next, "Interview");
  assert.equal(read.why, "Owns the work end to end.");
  assert.equal(read.model, "test-model");
});

test("canonical evaluation maps the same decision to a post-interview action", () => {
  const read = decisionReadFromEvaluation(source() as never, true, "test-model");
  assert.equal(read.decision, "interview");
  assert.equal(read.next, "Advance to next round");
});

test("failed integrity gate always rejects", () => {
  const read = decisionReadFromEvaluation(
    source({ integrityGate: { status: "fail", note: "Material contradiction." } }) as never,
    false,
    "test-model",
  );
  assert.equal(read.decision, "reject");
  assert.equal(read.next, "Reject");
});

test("low evidence stays backup unless answers own nothing", () => {
  assert.equal(
    decisionReadFromEvaluation(source({ total: 40, decisionBand: "PASS" }) as never, false, "m").decision,
    "backup",
  );
  assert.equal(
    decisionReadFromEvaluation(
      source({
        total: 40,
        decisionBand: "PASS",
        answerGrades: [{ verdict: "SURFACE" }, { verdict: "EVASIVE" }],
      }) as never,
      false,
      "m",
    ).decision,
    "reject",
  );
});

