import assert from "node:assert/strict";
import {
  decisionLabelForPhase,
  detectPipelinePhase,
  hasInterviewEvidence,
  nextActionForPhase,
} from "./pipeline-phase";

assert.equal(hasInterviewEvidence({ activity: [] }), false);
assert.equal(
  hasInterviewEvidence({
    activity: [{ id: "1", type: "interview", author: "Conall", body: "Q: …\nA: …", at: "2026-07-01" }],
  }),
  true,
);

assert.equal(detectPipelinePhase({ activity: [] }), "triage");
assert.equal(
  detectPipelinePhase({
    activity: [{ id: "1", type: "interview", author: "Lara", body: "transcript body", at: "2026-07-01" }],
  }),
  "post_interview",
);
assert.equal(detectPipelinePhase({ workableStage: "Phone Screen" }), "post_interview");
assert.equal(detectPipelinePhase({ workableStage: "Applied" }), "triage");

assert.equal(decisionLabelForPhase("interview", "triage"), "Interview");
assert.equal(decisionLabelForPhase("interview", "post_interview"), "Advance");
assert.equal(decisionLabelForPhase("reject", "post_interview"), "Pass");
assert.equal(nextActionForPhase("interview", "post_interview"), "Advance to next round");
assert.equal(nextActionForPhase("reject", "post_interview"), "Pass on the candidate");

console.log("pipeline-phase.test.ts: ok");
