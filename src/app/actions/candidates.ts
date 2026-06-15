"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@clerk/nextjs/server";
import {
  addCandidateNote,
  addCandidateTags,
  disqualifyCandidate,
  listStages,
  moveCandidateStage,
} from "@/lib/workable/client";
import { upsertOverlay } from "@/lib/data/overlay";
import { enqueueWorkableWrite } from "@/lib/workable/write-queue";
import { hasSupabase, hasWorkable } from "@/lib/env";
import { candidatePath, jobBoardPath } from "@/lib/routes";

function revalidatePipeline(jobShortcode: string, candidateId?: string) {
  revalidatePath("/board");
  revalidatePath(jobBoardPath(jobShortcode));
  if (candidateId) {
    revalidatePath(`/candidates/${candidateId}`);
    revalidatePath(candidatePath(jobShortcode, candidateId));
  }
}

async function requireAuth() {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");
  return userId;
}

/** A human-readable owner label (first name / email prefix) for the board, or the id. */
async function reviewerLabel(): Promise<string | undefined> {
  try {
    const { currentUser } = await import("@clerk/nextjs/server");
    const user = await currentUser();
    if (!user) return undefined;
    const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
    if (name) return name;
    const email = user.emailAddresses?.[0]?.emailAddress;
    return email ? email.split("@")[0] : undefined;
  } catch {
    return undefined;
  }
}

export async function advanceCandidate(input: {
  jobShortcode: string;
  candidateId: string;
  currentStage?: string;
  targetStage?: string;
}) {
  await requireAuth();
  if (!hasWorkable()) return { ok: false, error: "Workable not configured" };

  const stages = await listStages(input.jobShortcode);
  const currentIndex = stages.findIndex((s) => s.slug === input.currentStage);
  const nextStage =
    input.targetStage ??
    stages[currentIndex >= 0 ? Math.min(currentIndex + 1, stages.length - 1) : 1]?.slug ??
    stages[1]?.slug;

  if (!nextStage) return { ok: false, error: "No target stage" };

  await enqueueWorkableWrite(async () => {
    const updated = await moveCandidateStage(input.jobShortcode, input.candidateId, nextStage);
    await addCandidateNote(
      input.jobShortcode,
      input.candidateId,
      `Advanced to ${nextStage} via RDI Hiring Layer`,
    );
    if (hasSupabase()) {
      const { upsertCandidateFromWorkable } = await import("@/lib/sync/workable-sync");
      await upsertCandidateFromWorkable(updated, input.jobShortcode, { analyze: false });
    }
  });

  revalidatePipeline(input.jobShortcode, input.candidateId);
  return { ok: true, stage: nextStage };
}

export async function holdCandidate(input: {
  jobShortcode: string;
  candidateId: string;
}) {
  await requireAuth();
  if (!hasWorkable()) return { ok: false, error: "Workable not configured" };

  await enqueueWorkableWrite(async () => {
    await addCandidateTags(input.jobShortcode, input.candidateId, ["hold-rdi"]);
    await addCandidateNote(
      input.jobShortcode,
      input.candidateId,
      "Marked on hold via RDI Hiring Layer",
    );
  });

  revalidatePipeline(input.jobShortcode);
  return { ok: true };
}

export async function denyCandidate(input: {
  jobShortcode: string;
  candidateId: string;
  reason?: string;
}) {
  await requireAuth();
  if (!hasWorkable()) return { ok: false, error: "Workable not configured" };

  await enqueueWorkableWrite(async () => {
    const updated = await disqualifyCandidate(
      input.jobShortcode,
      input.candidateId,
      input.reason ?? "Not a fit at this time",
    );
    if (hasSupabase()) {
      const { upsertCandidateFromWorkable } = await import("@/lib/sync/workable-sync");
      await upsertCandidateFromWorkable(updated, input.jobShortcode, { analyze: false });
    }
  });

  if (hasSupabase()) {
    await upsertOverlay(
      input.candidateId,
      { status: "disqualified", status_reason: input.reason ?? "Not a fit at this time" },
      await reviewerLabel(),
    );
  }

  revalidatePipeline(input.jobShortcode, input.candidateId);
  return { ok: true };
}

export async function withdrawCandidate(input: {
  jobShortcode: string;
  candidateId: string;
  reason?: string;
}) {
  await requireAuth();
  if (hasSupabase()) {
    await upsertOverlay(
      input.candidateId,
      { status: "withdrawn", status_reason: input.reason ?? "Candidate withdrew" },
      await reviewerLabel(),
    );
  }
  revalidatePipeline(input.jobShortcode, input.candidateId);
  return { ok: true };
}

export async function restoreCandidate(input: {
  jobShortcode: string;
  candidateId: string;
}) {
  await requireAuth();
  if (hasSupabase()) {
    await upsertOverlay(
      input.candidateId,
      { status: "active", status_reason: null },
      await reviewerLabel(),
    );
  }
  revalidatePipeline(input.jobShortcode, input.candidateId);
  return { ok: true };
}

export async function bulkCandidateAction(input: {
  jobShortcode: string;
  candidateIds: string[];
  action: "advance" | "hold" | "deny";
}) {
  await requireAuth();
  for (const candidateId of input.candidateIds) {
    if (input.action === "advance") {
      await advanceCandidate({ jobShortcode: input.jobShortcode, candidateId });
    } else if (input.action === "hold") {
      await holdCandidate({ jobShortcode: input.jobShortcode, candidateId });
    } else {
      await denyCandidate({ jobShortcode: input.jobShortcode, candidateId });
    }
  }
  revalidatePipeline(input.jobShortcode);
  return { ok: true, count: input.candidateIds.length };
}

/**
 * The one and only pipeline button. Loads (mirrors candidates from Workable into
 * Supabase — fast, no Claude), then analyzes any candidate that has no score yet
 * within a time budget, then saves. Re-running only mirrors changed candidates
 * and only analyzes the ones still missing intelligence, so it stays fast.
 * If `remaining > 0`, run it again to continue analyzing the backlog.
 */
export async function syncPipeline() {
  await requireAuth();
  if (!hasWorkable()) {
    return { ok: false as const, error: "Workable not configured" };
  }
  const { incrementalSync } = await import("@/lib/sync/incremental-sync");
  const result = await incrementalSync("incremental");
  revalidatePath("/board");
  revalidatePath("/");
  return { ok: true as const, ...result };
}
