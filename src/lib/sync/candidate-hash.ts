import { createHash } from "crypto";
import type { WorkableCandidate } from "../workable/client";

/** One-time application fingerprint — used only to detect first résumé ingest, not rescoring. */
export function computeApplicationFingerprint(candidate: WorkableCandidate): string {
  const answers: Record<string, string> = {};
  for (const item of candidate.answers ?? []) {
    answers[item.question.body] = item.answer.body;
  }
  const payload = {
    resume_url: candidate.resume_url ?? null,
    cover_letter: candidate.cover_letter ?? null,
    answers,
    experience_entries: candidate.experience_entries ?? [],
    education_entries: candidate.education_entries ?? [],
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 32);
}

/** @deprecated Use computeApplicationFingerprint — column name kept for compatibility. */
export const computeAnalysisHash = computeApplicationFingerprint;

/** Evidence types that should trigger a score recalculation when added. */
export const INTERVIEW_EVIDENCE_TYPES = new Set([
  "async_video",
  "interview",
  "fireflies",
  "phone_screen",
]);

/** Workable recruiter notes/comments — sync for display, never auto-rescore. */
export const COMMENT_EVIDENCE_TYPE = "workable_comment";
