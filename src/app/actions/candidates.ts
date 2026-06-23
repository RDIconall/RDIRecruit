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

  // Workable propagation is best-effort: the move endpoint returns an empty 202,
  // so we re-fetch the candidate to mirror the new stage. A Workable failure or a
  // member-id skip must NOT 500 the UI — the local state is the source of truth.
  try {
    await enqueueWorkableWrite(async () => {
      await moveCandidateStage(input.candidateId, nextStage);
      await addCandidateNote(
        input.candidateId,
        `Advanced to ${nextStage} via RDI Hiring Layer`,
      );
      if (hasSupabase()) {
        const { getCandidate } = await import("@/lib/workable/client");
        const updated = await getCandidate(input.jobShortcode, input.candidateId);
        const { upsertCandidateFromWorkable } = await import("@/lib/sync/workable-sync");
        await upsertCandidateFromWorkable(updated, input.jobShortcode, { analyze: false });
      }
    });
  } catch (error) {
    console.error(`Workable advance failed for ${input.candidateId}`, error);
  }

  revalidatePath("/board");
  revalidatePath(`/candidates/${input.candidateId}`);
  return { ok: true, stage: nextStage };
}

export async function holdCandidate(input: {
  jobShortcode: string;
  candidateId: string;
}) {
  await requireAuth();
  if (!hasWorkable()) return { ok: false, error: "Workable not configured" };

  // Best-effort: tags/comment writes never block the local hold state.
  try {
    await enqueueWorkableWrite(async () => {
      await addCandidateTags(input.candidateId, ["hold-rdi"]);
      await addCandidateNote(input.candidateId, "Marked on hold via RDI Hiring Layer");
    });
  } catch (error) {
    console.error(`Workable hold failed for ${input.candidateId}`, error);
  }

  revalidatePath("/board");
  return { ok: true };
}

export async function denyCandidate(input: {
  jobShortcode: string;
  candidateId: string;
  reason?: string;
}) {
  await requireAuth();
  if (!hasWorkable()) return { ok: false, error: "Workable not configured" };

  // Best-effort Workable propagation; the local overlay below is the source of
  // truth and is written regardless of whether the Workable write succeeds/skips.
  try {
    await enqueueWorkableWrite(async () => {
      await disqualifyCandidate(input.candidateId, input.reason ?? "Not a fit at this time");
      if (hasSupabase()) {
        try {
          const { getCandidate } = await import("@/lib/workable/client");
          const updated = await getCandidate(input.jobShortcode, input.candidateId);
          const { upsertCandidateFromWorkable } = await import("@/lib/sync/workable-sync");
          await upsertCandidateFromWorkable(updated, input.jobShortcode, { analyze: false });
        } catch (mirrorError) {
          console.warn(`Workable status mirror skipped for ${input.candidateId}`, mirrorError);
        }
      }
    });
  } catch (error) {
    console.error(`Workable disqualify failed for ${input.candidateId}`, error);
  }

  if (hasSupabase()) {
    await upsertOverlay(
      input.candidateId,
      { status: "disqualified", status_reason: input.reason ?? "Not a fit at this time" },
      await reviewerLabel(),
    );
  }

  revalidatePath("/board");
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
  revalidatePath("/board");
  revalidatePath(`/candidates/${input.candidateId}`);
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
  revalidatePath("/board");
  revalidatePath(`/candidates/${input.candidateId}`);
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
  revalidatePath("/board");
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
