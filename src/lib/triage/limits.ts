import type { TimelineRow } from "./types";

/**
 * Size caps for reviewer-authored text. Every write path that stores free text a
 * signed-in user typed or pasted checks these before touching the database, so
 * one account cannot grow a candidate's record without bound.
 */

/** A note, comment, correction, reply, chat message, overlay reason, or timeline field. */
export const MAX_NOTE_CHARS = 4_000;
/** A pasted interview transcript, VideoAsk answers, or a job rubric / role spec. */
export const MAX_TRANSCRIPT_CHARS = 60_000;
/** An author name, evidence label, or reply key. */
export const MAX_LABEL_CHARS = 200;
/** Rows in a manually edited career timeline. */
export const MAX_TIMELINE_ROWS = 100;
/** Distinct keys in a candidate's reply map. */
export const MAX_REPLY_KEYS = 100;

export function tooLongMessage(what: string, max: number): string {
  return `${what} is too long — keep it under ${max.toLocaleString("en-US")} characters.`;
}

/** True when `value` is a string no longer than `max`. */
export function fitsLimit(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

const TIMELINE_FIELDS = ["type", "period", "org", "role", "tenure", "scope", "lang", "signal"] as const;

/**
 * Rebuild a client-supplied timeline from known string fields only, or return null
 * when it has too many rows, a non-string field, or a field over the note cap.
 */
export function sanitizeTimeline(rows: unknown): TimelineRow[] | null {
  if (!Array.isArray(rows) || rows.length > MAX_TIMELINE_ROWS) return null;
  const out: TimelineRow[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") return null;
    const source = row as Record<string, unknown>;
    const clean: Record<string, string> = {};
    for (const field of TIMELINE_FIELDS) {
      const value = source[field] ?? "";
      if (!fitsLimit(value, MAX_NOTE_CHARS)) return null;
      clean[field] = value;
    }
    out.push(clean as unknown as TimelineRow);
  }
  return out;
}
