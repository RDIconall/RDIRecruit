/** Longest disqualify / withdraw reason a reviewer may store on an overlay. */
export const MAX_CUT_REASON_CHARS = 500;

/**
 * Normalize a caller-supplied cut reason: trimmed text, `fallback` when blank or
 * absent, or null when it is not a string or exceeds MAX_CUT_REASON_CHARS (the
 * caller must refuse the write rather than store or truncate it).
 */
export function normalizeCutReason(raw: unknown, fallback: string): string | null {
  if (raw == null) return fallback;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  return trimmed.length > MAX_CUT_REASON_CHARS ? null : trimmed;
}
