import type { TimelineRow } from "./types";

/**
 * Size limits for reviewer-authored text. Every human write path checks these
 * before anything is stored, so one account cannot grow a record without bound.
 */

/** Note, comment, correction, reply, chat message, or one timeline field. */
export const TEXT_MAX = 4_000;
/**
 * Pasted interview transcript, interview evidence, or VideoAsk answers. Sized
 * for a full-length interview (a Fireflies pull can run 50k+ characters).
 */
export const TRANSCRIPT_MAX = 100_000;
/** Short labels: activity author, reply key, evidence label / interviewer. */
export const LABEL_MAX = 200;
/** Disqualify / cut reason stored on the overlay and shown on the board. */
export const REASON_MAX = 1_000;
/** Rows in a reviewer's timeline override. */
export const TIMELINE_ROWS_MAX = 100;
/** Distinct reply keys kept on one candidate's working file. */
export const REPLIES_MAX = 200;
/** Job rubric or role spec markdown. */
export const RUBRIC_MAX = 100_000;

/** True when `value` is a string no longer than `max` characters. */
export function fitsText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

export function tooLongMessage(what: string, max: number): string {
  return `${what} is too long (max ${max.toLocaleString("en-US")} characters).`;
}

const TIMELINE_FIELDS: (keyof TimelineRow)[] = ["type", "period", "org", "role", "tenure", "scope", "lang", "signal"];

/**
 * Rebuild a client-sent timeline override from the known row fields only, or
 * return null when it has too many rows or any field is not a bounded string.
 */
export function sanitizeTimeline(rows: unknown): TimelineRow[] | null {
  if (!Array.isArray(rows) || rows.length > TIMELINE_ROWS_MAX) return null;
  const out: TimelineRow[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") return null;
    const clean: Record<string, string> = {};
    for (const field of TIMELINE_FIELDS) {
      const value = (row as Record<string, unknown>)[field] ?? "";
      if (!fitsText(value, TEXT_MAX)) return null;
      clean[field] = value;
    }
    out.push(clean as unknown as TimelineRow);
  }
  return out;
}
