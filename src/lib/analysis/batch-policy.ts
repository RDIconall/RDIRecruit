export function shouldHardenBatchAttempt(attemptCount: number): boolean {
  return attemptCount > 0;
}

