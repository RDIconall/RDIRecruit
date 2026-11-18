export async function runCanonicalAnalysis(candidateId, input, trigger) {
  const captured = globalThis.__rdiScoreInputs ?? [];
  captured.push({ candidateId, input, trigger });
  globalThis.__rdiScoreInputs = captured;
  return { state: "pending", analysisId: "test-analysis" };
}

export async function enqueueCanonicalAnalysis() {
  throw new Error("enqueueCanonicalAnalysis is not part of this reproduction");
}
