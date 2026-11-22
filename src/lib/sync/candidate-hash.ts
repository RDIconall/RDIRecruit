import { createHash } from "crypto";
import type { WorkableCandidate } from "../workable/client";

const FINGERPRINT_VERSION = "v2";

/** Keys only the single-candidate endpoint returns; the LIST endpoint omits them entirely. */
const APPLICATION_KEYS = [
  "resume_url",
  "answers",
  "cover_letter",
  "experience_entries",
  "education_entries",
] as const;

function answersRecord(candidate: WorkableCandidate): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const item of candidate.answers ?? []) {
    answers[item.question.body] = item.answer.body;
  }
  return answers;
}

function digest(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 32);
}

/** The résumé link without query/fragment, so a re-signed download URL for the same file compares equal. */
function stableResumeLink(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/**
 * True when the payload came from the single-candidate endpoint. A LIST summary
 * has no application materials, so its fingerprint says nothing about whether
 * the application changed and must never be compared or stored.
 */
export function carriesApplication(candidate: WorkableCandidate): boolean {
  const raw = candidate as unknown as Record<string, unknown>;
  return APPLICATION_KEYS.some((key) => raw[key] !== undefined);
}

/**
 * Fingerprint of the materials a decision is read from: résumé file, screening
 * answers, cover letter, and work/education history. When it changes, the
 * stored résumé and the decision built on it are stale.
 */
export function computeApplicationFingerprint(candidate: WorkableCandidate): string {
  const file = candidate.resume_metadata ?? null;
  const payload = {
    resume: stableResumeLink(candidate.resume_url),
    resume_file: file
      ? {
          filename: file.filename ?? null,
          filetype: file.filetype ?? null,
          created_at: file.created_at ?? null,
          updated_at: file.updated_at ?? null,
        }
      : null,
    cover_letter: candidate.cover_letter ?? null,
    answers: answersRecord(candidate),
    experience_entries: candidate.experience_entries ?? [],
    education_entries: candidate.education_entries ?? [],
  };
  return `${FINGERPRINT_VERSION}:${digest(payload)}`;
}

/** Pre-v2 fingerprint, kept only so rows stored before the version bump can still be compared. */
function legacyApplicationFingerprint(candidate: WorkableCandidate): string {
  return digest({
    resume_url: candidate.resume_url ?? null,
    cover_letter: candidate.cover_letter ?? null,
    answers: answersRecord(candidate),
    experience_entries: candidate.experience_entries ?? [],
    education_entries: candidate.education_entries ?? [],
  });
}

/** Whether a stored fingerprint describes the same application as this full payload. */
export function applicationMatchesFingerprint(
  candidate: WorkableCandidate,
  stored: string,
): boolean {
  if (stored.startsWith(`${FINGERPRINT_VERSION}:`)) {
    return stored === computeApplicationFingerprint(candidate);
  }
  return stored === legacyApplicationFingerprint(candidate);
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
