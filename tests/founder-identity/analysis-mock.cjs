/**
 * Stops scoreCandidate before a model call, after the evaluator input
 * (including recruiter notes) has been built. The test applies the real
 * prompt builder to that input.
 */
const { harness } = require("./state.cjs");

async function enqueueCanonicalAnalysis(candidateId, input, trigger) {
  harness().grading.push({ candidateId, input, trigger });
  return { id: "analysis-test", status: "pending", result: null };
}

async function runCanonicalAnalysis() {
  throw new Error("runCanonicalAnalysis is not used by these tests");
}

module.exports = { enqueueCanonicalAnalysis, runCanonicalAnalysis };
