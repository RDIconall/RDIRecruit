import assert from "node:assert/strict";
import { answerQuestionKey, compareAnswerToPool, summarizeAnswerGrades } from "./answer-grades";

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

// --- pool placement (compareAnswerToPool) ---

// No one else answered → no comparison line at all.
assert.equal(compareAnswerToPool("OWNED", []), null);

// Sole owned answer in the pool.
assert.equal(
  compareAnswerToPool("OWNED", ["SURFACE", "EVASIVE", "AI"]),
  "the only owned answer to this question across 4 candidates",
);

// Owned alongside others — counts include this candidate.
assert.equal(
  compareAnswerToPool("OWNED", ["OWNED", "SURFACE", "OWNED"]),
  "one of 3 owned answers to this question across 4 candidates",
);

// Surface answer where the pool has owned answers — the gap is the read.
assert.equal(
  compareAnswerToPool("SURFACE", ["OWNED", "OWNED", "EVASIVE"]),
  "2 of 4 candidates answered this at owned depth — this one stays surface",
);

// AI / evasive answers name the failure, never soften it.
assert.match(compareAnswerToPool("AI", ["OWNED"]) ?? "", /reads as AI/);
assert.match(compareAnswerToPool("EVASIVE", ["SURFACE"]) ?? "", /dodges it/);

// Nobody owned it — say so instead of implying a ranking.
assert.equal(
  compareAnswerToPool("SURFACE", ["SURFACE", "EVASIVE"]),
  "no owned answers to this question yet across 3 candidates — this one stays surface",
);

// Question matching absorbs formatting noise only.
assert.equal(answerQuestionKey("  Why  RDI?\n"), answerQuestionKey("why rdi"));
assert.notEqual(answerQuestionKey("Why RDI?"), answerQuestionKey("Why us?"));

console.log("answer-grades.test.ts: ok");
