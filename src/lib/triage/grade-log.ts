import "server-only";

/**
 * Structured, single-line logging for the grading pipeline (readiness checks,
 * repair attempts, grade outcomes). Kept deliberately tiny — one JSON line per
 * event so it is greppable in Vercel logs without pulling in a logging dep.
 */
export function gradeLog(event: string, fields: Record<string, unknown> = {}): void {
  try {
    const payload = {
      scope: "grading",
      event,
      at: new Date().toISOString(),
      ...fields,
    };
    console.log(JSON.stringify(payload));
  } catch {
    // Logging must never break the request path.
    console.log(`[grading] ${event}`);
  }
}
