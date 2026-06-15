"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@clerk/nextjs/server";
import { hasSupabase } from "@/lib/env";
import { upsertOverlay } from "@/lib/data/overlay";
import { loadOneCandidate } from "@/lib/triage/load";
import { getWorkingFile, upsertWorkingFile } from "@/lib/triage/store";
import { renderWorkingFile } from "@/lib/triage/working-file";
import { recalculateRead } from "@/lib/triage/recalc";
import type { Candidate, DecisionRead, TimelineRow, WorkspaceSlice } from "@/lib/triage/types";

async function requireAuth(): Promise<string> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");
  return userId;
}

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

function nowStamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/** Apply a freshly computed read onto the mapped candidate so the rendered .md matches it. */
function applyRead(candidate: Candidate, read: DecisionRead): Candidate {
  return {
    ...candidate,
    decision: read.decision,
    why: read.why || candidate.why,
    flag: read.risk || candidate.flag,
    next: read.next || candidate.next,
    redFlags: read.flags ?? candidate.redFlags,
  };
}

interface RecalcResult {
  ok: boolean;
  recalculated: boolean;
  read: DecisionRead | null;
  message?: string;
}

/**
 * Persist a slice patch (corrections/transcript/replies/timeline/deep), re-render
 * the stored .md, and — when requested — re-derive the decision read with Claude.
 * Disqualify is intentionally NOT here; it lives on candidate_overlay.
 */
async function persistAndMaybeRecalc(
  candidateId: string,
  patch: WorkspaceSlice,
  opts: { recalc: boolean },
): Promise<RecalcResult> {
  if (!hasSupabase()) return { ok: false, recalculated: false, read: null, message: "Supabase not configured" };

  const updatedBy = await reviewerLabel();
  // Write the human edit first so it survives even if Claude is unavailable.
  await upsertWorkingFile(candidateId, { workspace: patch }, updatedBy);

  const one = await loadOneCandidate(candidateId);
  if (!one) return { ok: false, recalculated: false, read: null, message: "Candidate not found" };

  let candidate = one.candidate;
  let read: DecisionRead | null = null;

  if (opts.recalc) {
    read = await recalculateRead({
      candidate,
      corrections: one.slice.corrections ?? [],
      transcript: one.slice.transcript ?? "",
      replies: one.slice.replies ?? {},
    });
    if (read) candidate = applyRead(candidate, read);
  }

  const content = renderWorkingFile(candidate, one.slice, {
    workableUrl: one.workableUrl,
    disqualified: one.disqualified,
  });

  await upsertWorkingFile(candidateId, read ? { content, read } : { content }, updatedBy);

  revalidatePath("/");
  return {
    ok: true,
    recalculated: Boolean(read),
    read,
    message: opts.recalc && !read ? "Saved. Claude re-analysis unavailable (no API key or transient error)." : undefined,
  };
}

export async function saveCorrection(input: { candidateId: string; text: string }): Promise<RecalcResult> {
  await requireAuth();
  const text = input.text.trim();
  if (!text) return { ok: false, recalculated: false, read: null, message: "Empty correction" };

  const existing = await getWorkingFile(input.candidateId);
  const corrections = [...(existing?.workspace.corrections ?? []), { ts: nowStamp(), text }];
  return persistAndMaybeRecalc(input.candidateId, { corrections }, { recalc: true });
}

export async function saveTranscript(input: { candidateId: string; transcript: string }): Promise<RecalcResult> {
  await requireAuth();
  return persistAndMaybeRecalc(input.candidateId, { transcript: input.transcript }, { recalc: true });
}

export async function runDeepAnalysis(input: { candidateId: string }): Promise<RecalcResult> {
  await requireAuth();
  return persistAndMaybeRecalc(input.candidateId, { deep: true }, { recalc: true });
}

export async function saveReply(input: { candidateId: string; key: string; value: string }): Promise<RecalcResult> {
  await requireAuth();
  const existing = await getWorkingFile(input.candidateId);
  const replies = { ...(existing?.workspace.replies ?? {}), [input.key]: input.value };
  return persistAndMaybeRecalc(input.candidateId, { replies }, { recalc: false });
}

export async function saveTimeline(input: { candidateId: string; ovr: TimelineRow[] }): Promise<RecalcResult> {
  await requireAuth();
  return persistAndMaybeRecalc(input.candidateId, { ovr: input.ovr }, { recalc: false });
}

export async function setDisqualified(input: {
  candidateId: string;
  disqualified: boolean;
}): Promise<{ ok: boolean }> {
  await requireAuth();
  if (!hasSupabase()) return { ok: false };
  await upsertOverlay(
    input.candidateId,
    input.disqualified
      ? { status: "disqualified", status_reason: "Cut via triage" }
      : { status: "active", status_reason: null },
    await reviewerLabel(),
  );
  // Re-render the stored .md so its decision line reflects the new state.
  const one = await loadOneCandidate(input.candidateId);
  if (one) {
    const content = renderWorkingFile(one.candidate, one.slice, {
      workableUrl: one.workableUrl,
      disqualified: input.disqualified,
    });
    await upsertWorkingFile(input.candidateId, { content }, await reviewerLabel());
  }
  revalidatePath("/");
  return { ok: true };
}

export async function bulkDisqualify(input: {
  candidateIds: string[];
  disqualified: boolean;
}): Promise<{ ok: boolean; count: number }> {
  await requireAuth();
  if (!hasSupabase()) return { ok: false, count: 0 };
  const label = await reviewerLabel();
  for (const id of input.candidateIds) {
    await upsertOverlay(
      id,
      input.disqualified
        ? { status: "disqualified", status_reason: "Cut via triage" }
        : { status: "active", status_reason: null },
      label,
    );
  }
  revalidatePath("/");
  return { ok: true, count: input.candidateIds.length };
}

/** Returns the stored .md, regenerating from current data if none has been saved yet. */
export async function getWorkingFileContent(input: { candidateId: string }): Promise<{ content: string }> {
  await requireAuth();
  const existing = await getWorkingFile(input.candidateId);
  if (existing?.content) return { content: existing.content };

  const one = await loadOneCandidate(input.candidateId);
  if (!one) return { content: `# ${input.candidateId}\n\nNo data on file.\n` };
  const content = renderWorkingFile(one.candidate, one.slice, {
    workableUrl: one.workableUrl,
    disqualified: one.disqualified,
  });
  return { content };
}
