"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@clerk/nextjs/server";
import { hasSupabase, hasWorkable } from "@/lib/env";
import { upsertOverlay } from "@/lib/data/overlay";
import { loadOneCandidate } from "@/lib/triage/load";
import { getWorkingFile, upsertWorkingFile } from "@/lib/triage/store";
import { getJobRubric, upsertJobRubric } from "@/lib/rubric/store";
import { renderWorkingFile } from "@/lib/triage/working-file";
import { recalculateRead } from "@/lib/triage/recalc";
import { DM } from "@/lib/triage/theme";
import { reviewerKindFrom, reviewerKindLabel, reviewerSignalFor } from "@/lib/triage/reviewer";
import { getServiceSupabase } from "@/lib/supabase/server";
import type {
  Candidate,
  CorrectionEntry,
  DecisionRead,
  ReviewerKind,
  TimelineRow,
  WorkspaceSlice,
} from "@/lib/triage/types";

async function requireAuth(): Promise<string> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");
  return userId;
}

interface ReviewerIdentity {
  id?: string;
  label?: string;
  kind: ReviewerKind;
}

/** Resolve the acting reviewer from Clerk, mapping name/email → reviewer kind (#7). */
async function reviewerIdentity(): Promise<ReviewerIdentity> {
  try {
    const { currentUser } = await import("@clerk/nextjs/server");
    const user = await currentUser();
    if (!user) return { kind: "other" };
    const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
    const email = user.emailAddresses?.[0]?.emailAddress;
    const label = name || (email ? email.split("@")[0] : undefined);
    return { id: user.id, label, kind: reviewerKindFrom(label || email) };
  } catch {
    return { kind: "other" };
  }
}

async function reviewerLabel(): Promise<string | undefined> {
  return (await reviewerIdentity()).label;
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
    reanalysis: read.reanalysis ?? candidate.reanalysis,
    careerRead: read.careerRead ?? candidate.careerRead,
    rubricFit: read.rubricFit ?? candidate.rubricFit,
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
  opts: { recalc: boolean; trigger?: string; reviewer?: ReviewerIdentity },
): Promise<RecalcResult> {
  if (!hasSupabase()) return { ok: false, recalculated: false, read: null, message: "Supabase not configured" };

  const reviewer = opts.reviewer;
  const updatedBy = reviewer?.label ?? (await reviewerLabel());
  // Write the human edit first so it survives even if Claude is unavailable.
  await upsertWorkingFile(candidateId, { workspace: patch }, updatedBy);

  const one = await loadOneCandidate(candidateId);
  if (!one) return { ok: false, recalculated: false, read: null, message: "Candidate not found" };

  let candidate = one.candidate;
  const priorDecision = candidate.decision;

  // The .md fed to Claude reflects the human edit just saved (one = post-write).
  const baseContent = renderWorkingFile(candidate, one.slice, {
    workableUrl: one.workableUrl,
    disqualified: one.disqualified,
  });

  let read: DecisionRead | null = null;

  if (opts.recalc) {
    const rubric = await getJobRubric(one.jobShortcode);
    read = await recalculateRead({
      candidate,
      workingFile: baseContent,
      corrections: one.slice.corrections ?? [],
      transcript: one.slice.transcript ?? "",
      replies: one.slice.replies ?? {},
      reviewer: reviewer ? { label: reviewer.label, kind: reviewer.kind } : undefined,
      rubric: rubric.rubricMd,
      jobSpec: rubric.specMd,
    });
    if (read) {
      // #7: carry the reviewer-signal lens (rev/revNote) on the persisted read so
      // the pool + candidate views show the human's signal, not a generic "none".
      if (reviewer && updatedBy) {
        read = {
          ...read,
          rev: reviewerSignalFor(reviewer.kind, read.decision),
          revNote: `${updatedBy}: ${read.timelineNote || read.why}`.slice(0, 200),
        };
      }
      // When a human note moved the decision, surface the before→after with the
      // real human reviewer (person), not the trigger type.
      if (read.decision !== priorDecision) {
        const who = updatedBy ? `${updatedBy} (human signal)` : opts.trigger ?? "Human signal";
        read = {
          ...read,
          reanalysis: {
            reviewer: who,
            before: DM(priorDecision).label,
            after: DM(read.decision).label,
            rec: read.timelineNote || read.why,
          },
        };
      }
      candidate = applyRead(candidate, read);
    }
  }

  const content = read
    ? renderWorkingFile(candidate, one.slice, { workableUrl: one.workableUrl, disqualified: one.disqualified })
    : baseContent;

  await upsertWorkingFile(candidateId, read ? { content, read } : { content }, updatedBy);

  revalidatePath("/");
  return {
    ok: true,
    recalculated: Boolean(read),
    read,
    message: opts.recalc && !read ? "Saved. Claude re-analysis unavailable (no API key or transient error)." : undefined,
  };
}

export async function saveCorrection(input: {
  candidateId: string;
  text: string;
  reviewerKind?: ReviewerKind;
}): Promise<RecalcResult> {
  await requireAuth();
  const text = input.text.trim();
  if (!text) return { ok: false, recalculated: false, read: null, message: "Empty correction" };

  // Reviewer identity: default to the Clerk user, but honour an explicit picker choice.
  const ident = await reviewerIdentity();
  const kind = input.reviewerKind ?? ident.kind;
  const label =
    ident.label && reviewerKindFrom(ident.label) === kind ? ident.label : reviewerKindLabel(kind);
  const reviewer: ReviewerIdentity = { id: ident.id, label, kind };

  const entry: CorrectionEntry = {
    ts: nowStamp(),
    text,
    reviewerId: ident.id,
    reviewerLabel: label,
    reviewerKind: kind,
  };
  const existing = await getWorkingFile(input.candidateId);
  const corrections = [...(existing?.workspace.corrections ?? []), entry];
  return persistAndMaybeRecalc(input.candidateId, { corrections }, { recalc: true, trigger: "Human correction", reviewer });
}

export async function saveTranscript(input: { candidateId: string; transcript: string }): Promise<RecalcResult> {
  await requireAuth();
  const reviewer = await reviewerIdentity();
  return persistAndMaybeRecalc(input.candidateId, { transcript: input.transcript }, { recalc: true, trigger: "Interview transcript", reviewer });
}

export async function runDeepAnalysis(input: { candidateId: string }): Promise<RecalcResult> {
  await requireAuth();
  return persistAndMaybeRecalc(input.candidateId, { deep: true }, { recalc: true, trigger: "Deep analysis" });
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

/** What happened to the candidate's status in Workable as a result of a triage cut. */
type WorkableSync = "disqualified" | "restore-local" | "skipped" | "failed";

async function jobShortcodeFor(candidateId: string): Promise<string | null> {
  if (!hasSupabase()) return null;
  const supabase = getServiceSupabase();
  const { data } = await supabase
    .from("candidates")
    .select("job_shortcode")
    .eq("workable_id", candidateId)
    .maybeSingle();
  return (data?.job_shortcode as string | null) ?? null;
}

/**
 * Propagate a triage cut to Workable. Disqualify hits Workable's disqualify endpoint
 * (rate-limited) and mirrors the result back to Supabase. Restore stays local: Workable
 * has no safe requalify endpoint wired here, so un-cutting only clears our overlay.
 * Best-effort: a Workable failure never blocks the local overlay write.
 */
async function pushDisqualifyToWorkable(
  candidateId: string,
  disqualified: boolean,
  reason: string,
): Promise<WorkableSync> {
  if (!hasWorkable()) return "skipped";
  if (!disqualified) return "restore-local";
  try {
    const shortcode = await jobShortcodeFor(candidateId);
    if (!shortcode) return "failed";
    const { enqueueWorkableWrite } = await import("@/lib/workable/write-queue");
    const { disqualifyCandidate } = await import("@/lib/workable/client");
    await enqueueWorkableWrite(async () => {
      const updated = await disqualifyCandidate(shortcode, candidateId, reason);
      if (hasSupabase()) {
        const { upsertCandidateFromWorkable } = await import("@/lib/sync/workable-sync");
        await upsertCandidateFromWorkable(updated, shortcode, { analyze: false, syncComments: false });
      }
    });
    return "disqualified";
  } catch (error) {
    console.error(`Workable disqualify failed for ${candidateId}`, error);
    return "failed";
  }
}

export async function setDisqualified(input: {
  candidateId: string;
  disqualified: boolean;
  reason?: string;
}): Promise<{ ok: boolean; workable: WorkableSync }> {
  await requireAuth();
  if (!hasSupabase()) return { ok: false, workable: "skipped" };
  const reason = input.reason?.trim() || "Cut via triage";
  await upsertOverlay(
    input.candidateId,
    input.disqualified
      ? { status: "disqualified", status_reason: reason }
      : { status: "active", status_reason: null },
    await reviewerLabel(),
  );

  const workable = await pushDisqualifyToWorkable(input.candidateId, input.disqualified, reason);

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
  return { ok: true, workable };
}

export async function bulkDisqualify(input: {
  candidateIds: string[];
  disqualified: boolean;
}): Promise<{ ok: boolean; count: number; workableDisqualified: number; workableFailed: number }> {
  await requireAuth();
  if (!hasSupabase()) return { ok: false, count: 0, workableDisqualified: 0, workableFailed: 0 };
  const label = await reviewerLabel();
  let workableDisqualified = 0;
  let workableFailed = 0;
  for (const id of input.candidateIds) {
    await upsertOverlay(
      id,
      input.disqualified
        ? { status: "disqualified", status_reason: "Cut via triage" }
        : { status: "active", status_reason: null },
      label,
    );
    const res = await pushDisqualifyToWorkable(id, input.disqualified, "Cut via triage");
    if (res === "disqualified") workableDisqualified += 1;
    else if (res === "failed") workableFailed += 1;
  }
  revalidatePath("/");
  return { ok: true, count: input.candidateIds.length, workableDisqualified, workableFailed };
}

/**
 * Re-derive the candidate's read with Claude against the current job rubric, surfacing
 * (or refreshing) the rubric-fit section. No workspace edit — just a recalc pass.
 */
export async function compareToRubric(input: { candidateId: string }): Promise<RecalcResult> {
  await requireAuth();
  const reviewer = await reviewerIdentity();
  return persistAndMaybeRecalc(input.candidateId, {}, { recalc: true, trigger: "Rubric comparison", reviewer });
}

/** Read the active job's rubric + spec (for in-app viewing/editing). */
export async function getJobRubricContent(input: {
  jobShortcode: string;
}): Promise<{ rubricMd: string; specMd: string }> {
  await requireAuth();
  return getJobRubric(input.jobShortcode);
}

/** Persist an edited rubric and/or role spec for a job. */
export async function saveJobRubric(input: {
  jobShortcode: string;
  rubricMd?: string;
  specMd?: string;
}): Promise<{ ok: boolean }> {
  await requireAuth();
  if (!hasSupabase()) return { ok: false };
  await upsertJobRubric(
    input.jobShortcode,
    { rubricMd: input.rubricMd, specMd: input.specMd },
    await reviewerLabel(),
  );
  revalidatePath("/");
  return { ok: true };
}

/**
 * Pull the latest candidate record from Workable into Supabase, and ingest the résumé
 * if it has not been captured yet. Best-effort and resilient: returns a human-readable
 * message for the UI notice instead of throwing.
 */
export async function resyncCandidate(input: {
  candidateId: string;
}): Promise<{ ok: boolean; message: string }> {
  await requireAuth();
  if (!hasSupabase()) return { ok: false, message: "Supabase not configured." };
  if (!hasWorkable()) return { ok: false, message: "Workable not configured." };

  const supabase = getServiceSupabase();
  const shortcode = await jobShortcodeFor(input.candidateId);
  if (!shortcode) return { ok: false, message: "No Workable job on file for this candidate." };

  const { data: app } = await supabase
    .from("applications")
    .select("resume_storage_path")
    .eq("candidate_id", input.candidateId)
    .maybeSingle();
  const needResume = !app?.resume_storage_path;

  try {
    const { getCandidate } = await import("@/lib/workable/client");
    const { upsertCandidateFromWorkable } = await import("@/lib/sync/workable-sync");
    const candidate = await getCandidate(shortcode, input.candidateId);
    const result = await upsertCandidateFromWorkable(candidate, shortcode, {
      analyze: true,
      // Force a fresh résumé ingest only when we don't already have the file.
      forceAnalyze: needResume,
      syncComments: true,
    });
    revalidatePath("/");

    if (needResume) {
      return {
        ok: true,
        message: result.applicationIngested
          ? "Synced from Workable · résumé pulled in."
          : candidate.resume_url
            ? "Synced from Workable · résumé queued (parse pending)."
            : "Synced from Workable · no résumé on file in Workable yet.",
      };
    }
    return { ok: true, message: "Synced from Workable." };
  } catch (error) {
    console.error(`Resync failed for ${input.candidateId}`, error);
    return { ok: false, message: "Sync failed — please retry." };
  }
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
