// Pure reviewer-identity helpers (#7). No server-only imports — safe to use from
// both the server actions (Clerk-derived label) and the client corrections UI.

import type { Decision, ReviewerKind, ReviewerSignal } from "./types";

export interface Viewer {
  id?: string;
  label: string;
  kind: ReviewerKind;
}

/** Map a human's name/email to a reviewer kind. Defaults to "other". */
export function reviewerKindFrom(text: string | null | undefined): ReviewerKind {
  const t = (text ?? "").toLowerCase();
  if (t.includes("conall")) return "conall";
  if (t.includes("lara")) return "lara";
  return "other";
}

export function reviewerKindLabel(kind: ReviewerKind): string {
  return { conall: "Conall", lara: "Lara", other: "Other reviewer" }[kind];
}

/**
 * Human-readable label for comments, corrections, and activity log entries.
 * Known reviewers (Conall / Lara) always get their canonical name even when
 * Clerk only has an email like lara@rditrials.com with no first/last name set.
 */
export function resolveReviewerLabel(input: {
  name?: string | null;
  email?: string | null;
  kind?: ReviewerKind;
}): string {
  const name = input.name?.trim();
  if (name) return name;
  const email = input.email?.trim().toLowerCase() ?? "";
  const kind = input.kind ?? reviewerKindFrom(email);
  if (kind !== "other") return reviewerKindLabel(kind);
  if (email) {
    const local = email.split("@")[0] ?? "";
    if (!local) return reviewerKindLabel("other");
    return local.charAt(0).toUpperCase() + local.slice(1);
  }
  return reviewerKindLabel("other");
}

/** Build the signed-in viewer from a Clerk user record. */
export function viewerFromClerkUser(
  user: {
    id: string;
    firstName?: string | null;
    lastName?: string | null;
    emailAddresses?: { emailAddress: string }[];
  } | null
  | undefined,
): Viewer {
  if (!user) return { kind: "other", label: reviewerKindLabel("other") };
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  const email = user.emailAddresses?.[0]?.emailAddress ?? null;
  const kind = reviewerKindFrom(name || email);
  return { id: user.id, label: resolveReviewerLabel({ name, email, kind }), kind };
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
