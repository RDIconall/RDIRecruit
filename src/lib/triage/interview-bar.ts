/**
 * Deterministic "does this file clear the bar for a first interview?" gate.
 *
 * Interview is the list a human works top-down, so it has to mean "worth your
 * calendar", not "the best of what we happen to have". Three paths were putting
 * files on it that no one would call an A player:
 *   - the evaluator's borderline band was read as interview-ready,
 *   - a model read could return "interview" on an application whose answers own
 *     nothing (surface, evasive, AI-written, or dash-filled), and
 *   - a merely competent file with nothing standout in it read the same as one
 *     that clears the seat bar outright.
 * None of those is an interview-first file. They land in Backup until a human
 * says otherwise — a manual decision always wins over this gate.
 *
 * The evaluator total and the answer verdicts stay internal: they pick the
 * bucket here and are never surfaced (no scores, no tiers in the UI).
 */

import type { Decision, InterviewGate, VerdictLevel } from "./types";

/**
 * Lowest evaluator total that still reads as "holds the level for this seat"
 * (the evaluator's CONSIDER band). Below it the read is explicitly borderline —
 * more evidence needed before anyone spends an interview slot.
 */
export const CONSIDER_BAND_MIN = 70;

/** Lowest evaluator total that reads as "clears the seat bar" (ADVANCE). */
export const ADVANCE_BAND_MIN = 85;

export interface InterviewBarInput {
  /** Latest evaluator total, or null when the candidate has no score on file. */
  total: number | null;
  /** Collapsed read of the application answers (see summarizeAnswerGrades). */
  answersLevel: VerdictLevel;
  /** Screening answers were dash-filled or left effectively blank. */
  refusedToAnswer: boolean;
  /**
   * Live interview / screen evidence is on file. Past triage the calendar
   * question is already settled, so this bar no longer applies: Advance / Hold /
   * Pass is driven by what the candidate showed live.
   */
  hasLiveEvidence: boolean;
}

export interface InterviewBar {
  clears: boolean;
  /** One sentence naming what keeps the file off the interview list. */
  reason: string | null;
  /** What a human would have to settle for it to earn a slot. */
  caveat: string | null;
}

const CLEARS: InterviewBar = { clears: true, reason: null, caveat: null };

export function assessInterviewBar(input: InterviewBarInput): InterviewBar {
  if (input.hasLiveEvidence) return CLEARS;

  if (input.refusedToAnswer) {
    return {
      clears: false,
      reason:
        "Screening questions were dash-filled or left blank — there is no application to read, so nothing here earns interview time.",
      caveat: "Get real answers to the screening questions before booking an interview.",
    };
  }

  if (input.total != null && input.total < CONSIDER_BAND_MIN) {
    return {
      clears: false,
      reason:
        "The evidence on file does not hold the level this seat needs — a borderline read, not an interview-first.",
      caveat: "Needs stronger evidence than the file carries today before it earns an interview slot.",
    };
  }

  if (input.answersLevel === "weak") {
    return {
      clears: false,
      reason:
        "The application answers own nothing — surface, evasive, or AI-written — so there is no demonstrated substance to interview.",
      caveat: "Confirm the substance in writing or on a short call before booking an interview.",
    };
  }

  // Between "holds the level" and "clears the seat bar" the file needs something
  // of its own to justify the slot: answers that actually own the work. Competent
  // and unremarkable is what Backup is for.
  if (
    input.total != null &&
    input.total < ADVANCE_BAND_MIN &&
    input.answersLevel !== "strong"
  ) {
    return {
      clears: false,
      reason:
        "Holds the level for the seat but nothing in the application stands out — competent, not someone to interview ahead of the field.",
      caveat: "Would need a standout answer, a reference, or a human's call to move ahead of the interview list.",
    };
  }

  return CLEARS;
}

/** Interview is reserved for files that clear the bar; the rest hold as backups. */
export function applyInterviewBar(decision: Decision, bar: InterviewBar): Decision {
  if (decision !== "interview") return decision;
  return bar.clears ? "interview" : "backup";
}

/**
 * Apply the gate as carried on a mapped candidate (`Candidate.interviewGate`),
 * so the client holds the same line when a fresh model read arrives mid-session
 * instead of flashing an Interview call the next page load pulls straight back
 * down. Human decisions bypass this — they are set before the read is applied.
 */
export function applyInterviewGate(decision: Decision, gate: InterviewGate | undefined): Decision {
  if (!gate || gate.clears || decision !== "interview") return decision;
  return "backup";
}
