// Pure reviewer-identity helpers (#7). No server-only imports — safe to use from
// both the server actions and the client corrections UI. Which Clerk user is a
// founder is decided server-side in ./founders.

import type { Decision, ReviewerKind, ReviewerSignal } from "./types";

export interface Viewer {
  id?: string;
  label: string;
  kind: ReviewerKind;
}

export function reviewerKindLabel(kind: ReviewerKind): string {
  return { conall: "Conall", lara: "Lara", other: "Other reviewer" }[kind];
}

export const REVIEWER_OPTIONS: { kind: ReviewerKind; label: string }[] = [
  { kind: "conall", label: "Conall" },
  { kind: "lara", label: "Lara" },
  { kind: "other", label: "Other" },
];

/**
 * Translate a reviewer + the resulting decision into the ReviewerSignal lens
 * used by REV()/the reviewer-signal chip. A reject/backup/blocked outcome reads
 * as a concern; interview reads as positive. Lara's reject is a hard no.
 */
export function reviewerSignalFor(kind: ReviewerKind, decision: Decision): ReviewerSignal {
  const concern = decision === "reject" || decision === "backup" || decision === "blocked";
  if (kind === "conall") return concern ? "conallConcern" : "conallPos";
  if (kind === "lara") return decision === "reject" ? "laraNo" : concern ? "laraConcern" : "laraPos";
  return "second"; // other reviewer — flag for a second read
}
