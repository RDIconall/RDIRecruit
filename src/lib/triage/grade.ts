import "server-only";
import { gradeLog } from "./grade-log";
import { loadPoolRoster } from "./load";
import { recalculateRead } from "./recalc";
import {
  describeMissing,
  prepareGradingInputs,
  type GradingInputs,
} from "./readiness";
import type {
  Candidate,
  CandidateReadiness,
  CorrectionEntry,
  DecisionRead,
  ReadinessInput,
  ReviewerKind,
} from "./types";

export interface GradeRequest {
  candidate: Candidate;
  jobShortcode: string;
  /** The candidate's stored .md working file (case file). */
  workingFile: string;
  /** Verbatim source materials block. */
  materials: string;
  corrections: CorrectionEntry[];
  transcript: string;
  replies: Record<string, string>;
  reviewer?: { label?: string; kind?: ReviewerKind };
  /** Pre-assembled inputs + readiness, when the caller already ran the gate. */
  prepared?: { inputs: GradingInputs; readiness: CandidateReadiness };
}

export interface GradeResult {
  read: DecisionRead | null;
  readiness: CandidateReadiness;
  /** True when the gate blocked grading because a required input is missing. */
  blocked: boolean;
}

/**
 * Build the "Review blocked" decision read written when a required grading input
 * is missing. Decision vocabulary only; the missing list drives the UI's
 * "waiting on X" state and the next action is always to re-sync.
 */
export function blockedRead(missing: ReadinessInput[]): DecisionRead {
  return {
    decision: "blocked",
    why: `Review blocked — cannot grade until ${describeMissing(missing)} ${missing.length === 1 ? "is" : "are"} on file.`,
    risk: "No read is possible on incomplete materials.",
    next: "Re-sync",
    value: { headline: "No read yet", level: "none", detail: "Materials incomplete — strength-vs-salary read pending." },
    missingInputs: missing,
    recalculatedAt: new Date().toISOString(),
    model: "readiness-gate",
  };
}

/**
 * The single grading entry point. Enforces the readiness gate (all four inputs —
 * answers, parsed résumé, job spec, methodology — present after a repair attempt),
 * then grades with the full context: methodology + rubric + spec + pool roster so
 * the call is ranked relative to the rest of the pool. Resilient: a transient
 * Claude failure returns a null read (caller keeps the prior read); a missing
 * input returns a blocked read instead of grading on partial data.
 */
export async function gradeCandidate(req: GradeRequest): Promise<GradeResult> {
  const prepared = req.prepared ?? (await prepareGradingInputs(req.candidate.id, req.jobShortcode));
  const { inputs, readiness } = prepared;

  if (!readiness.ready) {
    gradeLog("grade.blocked", {
      candidateId: req.candidate.id,
      jobShortcode: req.jobShortcode,
      missing: readiness.missing,
    });
    return { read: blockedRead(readiness.missing), readiness, blocked: true };
  }

  const poolRoster = await loadPoolRoster(req.jobShortcode, req.candidate.id);

  const read = await recalculateRead({
    candidate: req.candidate,
    workingFile: req.workingFile,
    materials: req.materials,
    corrections: req.corrections,
    transcript: req.transcript,
    replies: req.replies,
    reviewer: req.reviewer,
    rubric: inputs.rubric,
    jobSpec: inputs.jobSpec,
    methodology: inputs.methodology,
    poolRoster,
  });

  gradeLog("grade.done", {
    candidateId: req.candidate.id,
    decision: read?.decision ?? null,
    poolSize: poolRoster.length,
  });

  return { read, readiness, blocked: false };
}
