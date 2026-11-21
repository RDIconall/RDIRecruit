import assert from "node:assert/strict";
import { summarizeAnswerGrades } from "./answer-grades.ts";

// Two SURFACE answers must never read as Strong — the failure mode that promoted
// a weak EA applicant in the cross-role "best new" banner.
const twoSurface = summarizeAnswerGrades([
  { verdict: "SURFACE", present: ["procedural logic", "checks for existing vendor"] },
  { verdict: "SURFACE", present: ["asks about process"] },
]);
assert.equal(twoSurface.level, "weak");
assert.match(twoSurface.label, /Surface answers/i);
assert.doesNotMatch(twoSurface.label, /Strong/i);

const ownedMajority = summarizeAnswerGrades([
  { verdict: "OWNED", present: ["confirmed specs", "closed loop"] },
  { verdict: "OWNED", present: ["budget check"] },
  { verdict: "SURFACE" },
]);
assert.equal(ownedMajority.level, "strong");

// Half surface is still weak — do not launder a thin answer as "mixed/OK".
const halfSurface = summarizeAnswerGrades([
  { verdict: "OWNED", present: ["x"] },
  { verdict: "SURFACE" },
]);
assert.equal(halfSurface.level, "weak");
assert.match(halfSurface.label, /Surface answers/i);

const allOwned = summarizeAnswerGrades([
  { verdict: "OWNED", present: ["a", "b"] },
  { verdict: "OWNED", present: ["c"] },
]);
assert.equal(allOwned.level, "strong");
assert.match(allOwned.label, /3 owned concepts/);

// An AI verdict stays in the AI bucket even when the model calls it
// experience-backed with high credit — it never reads as an owned answer.
const backedAi = summarizeAnswerGrades([
  {
    verdict: "AI",
    present: ["pricing model", "scope tradeoffs"],
    answerProvenance: "experience_backed",
    authorshipConfidence: "likely_ai_assisted",
    candidateEvidenceCredit: "high",
  },
  {
    verdict: "OWNED",
    present: ["closed loop"],
    answerProvenance: "experience_backed",
    authorshipConfidence: "high",
    candidateEvidenceCredit: "high",
  },
]);
assert.equal(backedAi.level, "weak");
assert.match(backedAi.label, /AI-heavy/i);
assert.match(backedAi.label, /1 owned · 1 AI/);
assert.doesNotMatch(backedAi.label, /Strong/i);

console.log("answer-grades.test.ts: ok");
