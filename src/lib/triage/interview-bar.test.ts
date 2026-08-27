import assert from "node:assert/strict";
import { applyInterviewBar, applyInterviewGate, assessInterviewBar } from "./interview-bar.ts";

const strongFile = {
  total: 88,
  answersLevel: "strong" as const,
  refusedToAnswer: false,
  hasLiveEvidence: false,
};

// A file that holds the level and owns its answers clears the bar.
const clears = assessInterviewBar(strongFile);
assert.equal(clears.clears, true);
assert.equal(clears.reason, null);
assert.equal(applyInterviewBar("interview", clears), "interview");

// The borderline band is not interview-ready, however the model read it.
const borderline = assessInterviewBar({ ...strongFile, total: 68 });
assert.equal(borderline.clears, false);
assert.ok(borderline.reason);
assert.ok(borderline.caveat);
assert.equal(applyInterviewBar("interview", borderline), "backup");
// The bar only ever holds a file back — it never promotes one.
assert.equal(applyInterviewBar("reject", borderline), "reject");
assert.equal(applyInterviewBar("backup", clears), "backup");
assert.equal(applyInterviewBar("blocked", borderline), "blocked");

// Answers that own nothing (surface / evasive / AI-written) cannot be interviewed
// on, even with a total that clears the seat's bar.
const unsupportedExpertise = assessInterviewBar({
  ...strongFile,
  unsupportedExpertise: true,
});
assert.equal(unsupportedExpertise.clears, false);
assert.match(unsupportedExpertise.reason ?? "", /does not support/i);
assert.equal(applyInterviewBar("interview", unsupportedExpertise), "backup");

const surfaceAnswers = assessInterviewBar({ ...strongFile, answersLevel: "weak" });
assert.equal(surfaceAnswers.clears, false);
assert.equal(applyInterviewBar("interview", surfaceAnswers), "backup");

// Competent-but-unremarkable: holds the level, nothing standout in the answers.
// That is a backup, not someone to interview ahead of the field.
const competent = assessInterviewBar({ ...strongFile, total: 76, answersLevel: "mixed" });
assert.equal(competent.clears, false);
assert.match(competent.reason ?? "", /stands out/);
// The same file clears once its answers actually own the work…
assert.equal(assessInterviewBar({ ...strongFile, total: 76, answersLevel: "strong" }).clears, true);
// …and a file that clears the seat bar outright does not need standout answers.
assert.equal(assessInterviewBar({ ...strongFile, total: 90, answersLevel: "mixed" }).clears, true);

// Dash-filled / blank screening answers are named as their own reason.
const refused = assessInterviewBar({ ...strongFile, refusedToAnswer: true });
assert.equal(refused.clears, false);
assert.match(refused.reason ?? "", /dash-filled/);

// No rubric read on file: strong answers can still carry the file…
assert.equal(assessInterviewBar({ ...strongFile, total: null }).clears, true);
// …but with nothing graded and nothing standout, a stale model "interview" must
// not ride through on the absence of a disqualifier.
const nothingOnFile = assessInterviewBar({ ...strongFile, total: null, answersLevel: "mixed" });
assert.equal(nothingOnFile.clears, false);
assert.match(nothingOnFile.reason ?? "", /Nothing on file/);
assert.equal(
  assessInterviewBar({ ...strongFile, total: null, answersLevel: "none" }).clears,
  false,
);
assert.equal(
  assessInterviewBar({ ...strongFile, total: null, answersLevel: "weak" }).clears,
  false,
);

// Once someone has been interviewed, the triage bar is behind us: Advance / Hold /
// Pass is driven by the live evidence, so nothing here holds them back.
const interviewed = assessInterviewBar({
  total: 60,
  answersLevel: "weak",
  refusedToAnswer: true,
  hasLiveEvidence: true,
});
assert.equal(interviewed.clears, true);
assert.equal(applyInterviewBar("interview", interviewed), "interview");

// The gate carried to the client holds the same line, and is a no-op when absent.
assert.equal(applyInterviewGate("interview", { clears: false, note: "held" }), "backup");
assert.equal(applyInterviewGate("interview", { clears: true, note: "" }), "interview");
assert.equal(applyInterviewGate("interview", undefined), "interview");
assert.equal(applyInterviewGate("backup", { clears: false, note: "held" }), "backup");

console.log("interview-bar.test.ts: ok");
