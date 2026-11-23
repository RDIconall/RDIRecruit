import type { VerificationPayload } from "../types";

export const VERIFICATION_READ_LABELS = [
  "Clean",
  "Minor flags",
  "Material discrepancy",
  "Unverified (no profile)",
] as const;

export type VerificationReadLabel = (typeof VERIFICATION_READ_LABELS)[number];

/**
 * The verification read is a closed label set. Free prose (which can echo the
 * applicant's own wording, e.g. "no material discrepancy") is not a label and
 * must never be read for keywords.
 */
export function verificationReadLabel(read: unknown): VerificationReadLabel | null {
  if (typeof read !== "string") return null;
  const key = read.trim().toLowerCase();
  return VERIFICATION_READ_LABELS.find((label) => label.toLowerCase() === key) ?? null;
}

type VerificationLike = Pick<VerificationPayload, "read"> & {
  claims?: Array<{ verdict?: unknown }> | null;
};

export function hasDiscrepancyClaim(v: VerificationLike | null | undefined): boolean {
  if (!v || !Array.isArray(v.claims)) return false;
  return v.claims.some(
    (claim) => typeof claim?.verdict === "string" && claim.verdict.trim().toUpperCase() === "DISCREPANCY",
  );
}

export function hasVerificationDiscrepancy(v: VerificationLike | null | undefined): boolean {
  if (!v) return false;
  return verificationReadLabel(v.read) === "Material discrepancy" || hasDiscrepancyClaim(v);
}

/** Pin the stored read to a prompt label; prose falls back to what the claims show. */
export function normalizeVerificationRead(
  read: unknown,
  claims: VerificationPayload["claims"],
): VerificationReadLabel {
  const label = verificationReadLabel(read);
  if (label) return label;
  if (hasDiscrepancyClaim({ read: "", claims })) return "Material discrepancy";
  if (claims.length > 0 && claims.every((claim) => String(claim?.verdict ?? "").trim().toUpperCase() === "CONFIRMED")) {
    return "Clean";
  }
  return "Unverified (no profile)";
}
