import assert from "node:assert/strict";
import { blockedReason } from "./blocked-reason.ts";

// Nothing to grade at the source — a resync will not conjure a résumé.
assert.deepEqual(
  blockedReason({
    ready: false,
    missing: ["resume"],
    detail: { answers: true, resume: false, jobSpec: true, methodology: true },
    resumeMissingFromSource: true,
  }),
  {
    short: "no résumé on file",
    title: "Review blocked — no résumé on file in Workable, nothing to grade",
    fix: "resync",
  },
);

// A genuinely missing input names itself.
assert.deepEqual(
  blockedReason({
    ready: false,
    missing: ["jobSpec"],
    detail: { answers: true, resume: true, jobSpec: false, methodology: true },
    resumeMissingFromSource: false,
  }),
  {
    short: "waiting on job spec",
    title: "Review blocked — waiting on job spec",
    fix: "resync",
  },
);

// The case that looked like a bug: every input is present, so the file is not
// waiting on materials at all — it has simply never been analysed. Saying
// "re-sync" here is wrong; the fix is to run the analysis.
assert.deepEqual(
  blockedReason({
    ready: true,
    missing: [],
    detail: { answers: true, resume: true, jobSpec: true, methodology: true },
    resumeMissingFromSource: false,
  }),
  {
    short: "waiting on analysis",
    title: "Review blocked — materials are on file but no analysis has run yet",
    fix: "analyze",
  },
);

// No readiness computed at all is the same state: nothing graded yet.
assert.equal(blockedReason(undefined).fix, "analyze");

console.log("blocked-reason.test.ts: ok");
