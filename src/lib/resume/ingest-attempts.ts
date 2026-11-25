/**
 * A résumé that fails to ingest this many times in a row is paused for the
 * cooldown, so one bad file can't be re-downloaded and re-parsed on every
 * backfill / recapture / readiness pass. The counter is bumped before each
 * attempt, so a run that is killed mid-parse still counts.
 */
export const MAX_RESUME_INGEST_ATTEMPTS = 3;
export const RESUME_INGEST_RETRY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export interface ResumeIngestAttemptState {
  resume_ingest_attempts?: number | null;
  resume_ingest_attempted_at?: string | null;
}

/** Epoch ms until which ingest is paused for this application, or null if it may run. */
export function resumeIngestPausedUntil(
  state: ResumeIngestAttemptState | null | undefined,
  now = Date.now(),
): number | null {
  if ((state?.resume_ingest_attempts ?? 0) < MAX_RESUME_INGEST_ATTEMPTS) return null;
  const last = Date.parse(state?.resume_ingest_attempted_at ?? "");
  if (!Number.isFinite(last)) return null;
  const until = last + RESUME_INGEST_RETRY_COOLDOWN_MS;
  return until > now ? until : null;
}
