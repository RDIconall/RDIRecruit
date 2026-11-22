"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { auth } from "@clerk/nextjs/server";
import { getServiceSupabase } from "@/lib/supabase/server";
import { hasSupabase } from "@/lib/env";
import { rescoreCandidateOnNewEvidence } from "@/lib/sync/rescore";
import {
  CAPTURE_TOO_LONG_MESSAGE,
  EVIDENCE_QUOTA_WINDOW_MS,
  accountQuotaReached,
  captureTooLong,
  isCaptureQuotaError,
} from "@/lib/capture-limits";

const QUOTA_MESSAGE = "You've added the most interview captures allowed for today. Try again tomorrow.";

async function requireAuth() {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");
  return userId;
}

export type InterviewKind = "interview" | "phone_screen";

/**
 * Store a pasted-in interview transcript as its OWN evidence row (never overwriting
 * prior interviews), then recalculate the candidate's read. Each call adds one
 * round — "Phone screen", "Onsite 1", etc. — so a candidate accumulates a full
 * interview history that the evaluator weighs heavily.
 */
export async function addInterviewEvidence(input: {
  candidateId: string;
  jobShortcode: string;
  kind: InterviewKind;
  label: string;
  author?: string | null;
  date?: string | null;
  transcript: string;
}) {
  const userId = await requireAuth();
  if (!hasSupabase()) return { ok: false as const, error: "Supabase not configured" };

  const transcript = input.transcript.trim();
  if (!transcript) return { ok: false as const, error: "Paste the interview transcript first." };
  if (captureTooLong(transcript)) return { ok: false as const, error: CAPTURE_TOO_LONG_MESSAGE };

  const label = input.label.trim() || (input.kind === "phone_screen" ? "Phone screen" : "Interview");
  const author = input.author?.trim() || null;
  const capturedAt = parseDate(input.date);

  const supabase = getServiceSupabase();
  if (await accountQuotaReached(supabase, "evidence", userId, EVIDENCE_QUOTA_WINDOW_MS)) {
    return { ok: false as const, error: QUOTA_MESSAGE };
  }
  const { error } = await supabase.from("evidence").insert({
    candidate_id: input.candidateId,
    source_type: input.kind,
    author,
    label,
    captured_at: capturedAt,
    raw_ref: `manual:${input.kind}:${randomUUID()}`,
    transcript,
    extracted: { manual: true, label, kind: input.kind, interviewer: author },
    created_by: userId,
  });
  if (error) return { ok: false as const, error: isCaptureQuotaError(error) ? QUOTA_MESSAGE : error.message };

  const rescore = await rescoreCandidateOnNewEvidence(
    input.candidateId,
    "interview",
    { immediate: true },
  );

  revalidatePath(`/candidates/${input.candidateId}`);
  revalidatePath("/board");
  return { ok: true as const, scored: rescore.scored };
}

/**
 * Manually capture a candidate's VideoAsk answers (no outbound VideoAsk API is
 * wired, so this is the operator's way to feed those answers in). Stored as an
 * async-video evidence row authored by the candidate, then re-scored immediately
 * so the new information moves the read.
 */
export async function addVideoAskAnswers(input: {
  candidateId: string;
  jobShortcode: string;
  label?: string | null;
  date?: string | null;
  answers: string;
}) {
  const userId = await requireAuth();
  if (!hasSupabase()) return { ok: false as const, error: "Supabase not configured" };

  const answers = input.answers.trim();
  if (!answers) return { ok: false as const, error: "Enter the candidate's VideoAsk answers first." };
  if (captureTooLong(answers)) return { ok: false as const, error: CAPTURE_TOO_LONG_MESSAGE };

  const label = input.label?.trim() || "VideoAsk answers";
  const capturedAt = parseDate(input.date);

  const supabase = getServiceSupabase();
  if (await accountQuotaReached(supabase, "evidence", userId, EVIDENCE_QUOTA_WINDOW_MS)) {
    return { ok: false as const, error: QUOTA_MESSAGE };
  }
  const { error } = await supabase.from("evidence").insert({
    candidate_id: input.candidateId,
    source_type: "async_video",
    author: "candidate",
    label,
    captured_at: capturedAt,
    raw_ref: `manual:async_video:${randomUUID()}`,
    transcript: answers,
    extracted: { manual: true, label },
    created_by: userId,
  });
  if (error) return { ok: false as const, error: isCaptureQuotaError(error) ? QUOTA_MESSAGE : error.message };

  const rescore = await rescoreCandidateOnNewEvidence(
    input.candidateId,
    "async_video",
    { immediate: true },
  );

  revalidatePath(`/candidates/${input.candidateId}`);
  revalidatePath("/board");
  return { ok: true as const, scored: rescore.scored };
}

function parseDate(value: string | null | undefined): string {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}
