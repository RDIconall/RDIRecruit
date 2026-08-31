export function shouldHardenBatchAttempt(attemptCount: number): boolean {
  return attemptCount > 0;
}

export function isDefiniteBatchRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: unknown }).status;
  return (
    typeof status === "number" &&
    [400, 401, 403, 404, 409, 422, 429].includes(status)
  );
}

