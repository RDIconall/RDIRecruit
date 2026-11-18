// Founder identity comes only from an allowlist of Clerk user ids, never from a
// display name, an email, or anything the caller sends. Env is read per call so a
// changed allowlist takes effect without a code change.
//
//   FOUNDER_CLERK_IDS_LARA    comma-separated Clerk user ids
//   FOUNDER_CLERK_IDS_CONALL  comma-separated Clerk user ids

import { reviewerKindLabel } from "./reviewer";
import type { CorrectionEntry, ReviewerKind } from "./types";

function idList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

/** The founder a Clerk user id belongs to, or "other". An id on both lists is ambiguous and gets "other". */
export function founderKindFor(userId: string | null | undefined): ReviewerKind {
  if (!userId) return "other";
  const lara = idList(process.env.FOUNDER_CLERK_IDS_LARA).includes(userId);
  const conall = idList(process.env.FOUNDER_CLERK_IDS_CONALL).includes(userId);
  if (lara === conall) return "other";
  return lara ? "lara" : "conall";
}

/** Display label for a stored actor id: the founder's name for an allowlisted id, otherwise the id itself. */
export function actorLabel(userId: string): string {
  const kind = founderKindFor(userId);
  return kind === "other" ? userId : reviewerKindLabel(kind);
}

/**
 * The reviewer kind a stored correction is entitled to. Re-derived from its
 * reviewerId so a correction saved with a self-asserted kind or label never
 * carries a founder's weight.
 */
export function correctionReviewerKind(entry: Pick<CorrectionEntry, "reviewerId">): ReviewerKind {
  return founderKindFor(entry.reviewerId);
}

/** Who a stored correction is attributed to, from its reviewerId only. */
export function correctionAuthor(entry: Pick<CorrectionEntry, "reviewerId">): string | undefined {
  return entry.reviewerId ? actorLabel(entry.reviewerId) : undefined;
}
