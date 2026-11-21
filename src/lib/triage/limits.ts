/**
 * Size limits for reviewer-supplied text. Everything here is stored per candidate
 * and read back by other reviewers, so each entry is refused (never truncated)
 * above its limit before anything is written. Safe to import on the client.
 */

/** One activity entry, correction, reply, or chat message. */
export const NOTE_MAX_CHARS = 8_000;
/** Author / label shown next to an entry. */
export const AUTHOR_MAX_CHARS = 200;
/** A pasted interview transcript, interview-evidence body, or VideoAsk answers. */
export const TRANSCRIPT_MAX_CHARS = 100_000;
/** Each free-text field on a hand-edited timeline row. */
export const TIMELINE_FIELD_MAX_CHARS = 2_000;
/** Rows on a hand-edited timeline. */
export const TIMELINE_MAX_ROWS = 100;
/** A job rubric, role spec, or the global method doc. */
export const RUBRIC_MAX_CHARS = 100_000;
/** A disqualify / withdraw reason (shown on the board for every cut candidate). */
export const REASON_MAX_CHARS = 500;
/** Distinct reply keys kept on one candidate. */
export const REPLIES_MAX_KEYS = 50;
/** Corrections kept on one candidate. */
export const CORRECTIONS_MAX = 200;
/** Chat messages kept on one candidate's war-room thread (oldest dropped first). */
export const CHAT_MAX_MESSAGES = 200;
/** Newest activity entries loaded for one candidate. */
export const ACTIVITY_LOAD_MAX = 200;
/** Raw request body accepted by the transcript ingest webhooks. */
export const WEBHOOK_BODY_MAX_BYTES = 1_000_000;
/** Reviewer-note snippet carried on the board for the reviewer signal. */
export const REVIEWER_NOTE_MAX_CHARS = 200;

export function tooLong(value: unknown, max: number): boolean {
  return typeof value === "string" && value.length > max;
}

export function tooLongMessage(what: string, max: number): string {
  return `${what} is too long (max ${max.toLocaleString("en-US")} characters).`;
}
