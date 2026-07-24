/**
 * Hiring-phase framing for war room + assessment re-derive.
 * Pre-interview: protect calendar (interview / backup / reject).
 * Post-interview: decide the pipeline move (advance / hold / pass).
 */

import { isAdvancedStage } from "./app-theme";
import type { ActivityEntry, Candidate, Decision, ProcessStatus } from "./types";

export type PipelinePhase = "triage" | "post_interview";

export function hasInterviewEvidence(input: {
  activity?: ActivityEntry[] | null;
  /** Workspace / Fireflies / pasted transcript body. */
  transcript?: string | null;
  fireflies?: Array<{ transcript?: string | null }> | null;
}): boolean {
  if ((input.transcript ?? "").trim()) return true;
  if ((input.fireflies ?? []).some((f) => (f.transcript ?? "").trim())) return true;
  if ((input.activity ?? []).some((a) => a.type === "interview" && a.body.trim())) return true;
  return false;
}

/** Prefer transcript evidence; fall back to an advanced Workable stage once they're past Applied. */
export function detectPipelinePhase(input: {
  activity?: ActivityEntry[] | null;
  transcript?: string | null;
  fireflies?: Array<{ transcript?: string | null }> | null;
  workableStage?: string | null;
  processStatus?: ProcessStatus | null;
}): PipelinePhase {
  if (hasInterviewEvidence(input)) return "post_interview";
  if (
    input.processStatus === "interviewing" ||
    input.processStatus === "referenceChecks" ||
    input.processStatus === "offer"
  ) {
    return "post_interview";
  }
  if (isAdvancedStage(input.workableStage)) return "post_interview";
  return "triage";
}

/** Decision labels that match the phase the recruiter is actually in. */
export function decisionLabelForPhase(decision: Decision, phase: PipelinePhase): string {
  if (phase === "triage") {
    return (
      {
        interview: "Interview",
        backup: "Backup",
        reject: "Reject",
        blocked: "Review blocked",
      } as const
    )[decision];
  }
  return (
    {
      interview: "Advance",
      backup: "Hold",
      reject: "Pass",
      blocked: "Review blocked",
    } as const
  )[decision];
}

export function nextActionForPhase(decision: Decision, phase: PipelinePhase): string {
  if (phase === "triage") {
    return (
      {
        interview: "Interview",
        backup: "Hold as backup",
        reject: "Reject",
        blocked: "Re-sync",
      } as const
    )[decision];
  }
  return (
    {
      interview: "Advance to next round",
      backup: "Hold — do not advance yet",
      reject: "Pass on the candidate",
      blocked: "Re-sync",
    } as const
  )[decision];
}

/** Compact block injected into Claude context so it knows which question to answer. */
export function phaseContextBlock(input: {
  phase: PipelinePhase;
  candidate: Pick<Candidate, "name" | "decision" | "workableStage" | "processStatus" | "next" | "why">;
  interviewCount: number;
}): string {
  const stage = (input.candidate.workableStage || "").trim() || "Applied / inbox";
  const process = input.candidate.processStatus || "unset";
  if (input.phase === "triage") {
    return `PIPELINE PHASE: TRIAGE (pre-interview)
Focus candidate: ${input.candidate.name}
Workable stage: ${stage}
Your job for this conversation: help decide whether to INTERVIEW, keep as BACKUP, or REJECT — protect interview time. Do not pretend an interview already happened.`;
  }
  return `PIPELINE PHASE: POST-INTERVIEW (live evidence on file)
Focus candidate: ${input.candidate.name}
Workable stage: ${stage}
Process status: ${process}
Interview transcripts on file: ${input.interviewCount}
Prior triage call: ${decisionLabelForPhase(input.candidate.decision, "triage")} — ${input.candidate.why || "—"}
Suggested next on file: ${input.candidate.next || "—"}

Your job for this conversation: the interview already happened. Answer what we should do NEXT with THIS candidate:
- ADVANCE to the next round (map to decision "interview"), OR
- HOLD without advancing yet (map to "backup") when signal is incomplete or mixed, OR
- PASS on the candidate (map to "reject").
Do NOT re-litigate "should we interview them?" as the primary question — that call is behind us. Ground the next-step call in what they said and did in the transcript vs the role spec.`;
}
