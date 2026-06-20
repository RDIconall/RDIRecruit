"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@clerk/nextjs/server";
import { hasSupabase, hasWorkable } from "@/lib/env";
import { upsertOverlay } from "@/lib/data/overlay";
import { loadOneCandidate, loadPoolRoster } from "@/lib/triage/load";
import { getWorkingFile, upsertWorkingFile } from "@/lib/triage/store";
import { getJobRubric, upsertJobRubric } from "@/lib/rubric/store";
import { renderWorkingFile, renderCandidateMaterials } from "@/lib/triage/working-file";
import { gradeCandidate } from "@/lib/triage/grade";
import { prepareGradingInputs, describeMissing } from "@/lib/triage/readiness";
import { chatWithClaude } from "@/lib/triage/chat";
import { DM } from "@/lib/triage/theme";
import { reviewerKindFrom, reviewerKindLabel, reviewerSignalFor } from "@/lib/triage/reviewer";
import { getServiceSupabase } from "@/lib/supabase/server";
import type {
  ActivityEntry,
  ActivityType,
  Candidate,
  ChatMessage,
  CorrectionEntry,
  Decision,
  DecisionRead,
  ReviewerKind,
  TimelineRow,
  WorkspaceSlice,
} from "@/lib/triage/types";

const VALID_DECISIONS: Decision[] = ["interview", "short", "verify", "hold", "cut", "blocked"];

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
    assessment: read.assessment ?? candidate.assessment,
    assessedAt: read.assessment ? read.recalculatedAt ?? candidate.assessedAt : candidate.assessedAt,
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

  let one = await loadOneCandidate(candidateId);
  if (!one) return { ok: false, recalculated: false, read: null, message: "Candidate not found" };

  // For a recalc, run the readiness gate (and its repair step) BEFORE building the
  // materials, so a freshly-ingested résumé / re-synced answers are reflected in
  // the candidate view Claude sees — and we never grade on partial data.
  let prepared: Awaited<ReturnType<typeof prepareGradingInputs>> | undefined;
  if (opts.recalc) {
    prepared = await prepareGradingInputs(candidateId, one.jobShortcode);
    one = (await loadOneCandidate(candidateId)) ?? one;
  }

  let candidate = one.candidate;
  const priorDecision = candidate.decision;

  // The .md fed to Claude reflects the human edit just saved (one = post-write).
  const baseContent = renderWorkingFile(candidate, one.slice, {
    workableUrl: one.workableUrl,
    disqualified: one.disqualified,
  });

  let read: DecisionRead | null = null;
  let blocked = false;

  if (opts.recalc && prepared) {
    const result = await gradeCandidate({
      candidate,
      jobShortcode: one.jobShortcode,
      workingFile: baseContent,
      materials: renderCandidateMaterials(candidate),
      corrections: one.slice.corrections ?? [],
      transcript: one.slice.transcript ?? "",
      replies: one.slice.replies ?? {},
      reviewer: reviewer ? { label: reviewer.label, kind: reviewer.kind } : undefined,
      prepared,
    });
    read = result.read;
    blocked = result.blocked;
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

  // A successful Claude re-analysis hands the call back to the model, so any
  // prior manual decision override is cleared.
  await upsertWorkingFile(
    candidateId,
    read ? { content, read, workspace: { decisionOverride: null } } : { content },
    updatedBy,
  );

  revalidatePath("/");

  let message: string | undefined;
  if (opts.recalc && blocked && read?.missingInputs?.length) {
    message = `Saved. Review blocked — waiting on ${describeMissing(read.missingInputs)} before a read can be made.`;
  } else if (opts.recalc && !read) {
    message = "Saved. Claude re-analysis unavailable (no API key or transient error).";
  }

  return {
    ok: true,
    recalculated: Boolean(read) && !blocked,
    read,
    message,
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

/**
 * Manually set a candidate's decision/status. Persists as a workspace override
 * that wins over the model read until the next Claude re-analysis clears it.
 */
export async function setDecision(input: { candidateId: string; decision: Decision }): Promise<RecalcResult> {
  await requireAuth();
  if (!VALID_DECISIONS.includes(input.decision)) {
    return { ok: false, recalculated: false, read: null, message: "Invalid decision" };
  }
  return persistAndMaybeRecalc(input.candidateId, { decisionOverride: input.decision }, { recalc: false });
}

/** Re-run Claude on the current materials (with the per-role rubric). Clears any manual override. */
export async function reanalyze(input: { candidateId: string }): Promise<RecalcResult> {
  await requireAuth();
  return persistAndMaybeRecalc(input.candidateId, {}, { recalc: true, trigger: "Re-analysis" });
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

// ---- Activity log (HANDOFF-v2 §2) — the human-authored record ----

async function fetchActivity(candidateId: string): Promise<ActivityEntry[]> {
  if (!hasSupabase()) return [];
  const supabase = getServiceSupabase();
  const { data } = await supabase
    .from("activity")
    .select("id, type, author, body, created_at")
    .eq("candidate_id", candidateId)
    .order("created_at", { ascending: true });
  return ((data ?? []) as Array<{ id: string; type: string | null; author: string | null; body: string; created_at: string }>).map((r) => ({
    id: r.id,
    type: r.type === "interview" || r.type === "comment" ? r.type : "note",
    author: r.author || "—",
    body: r.body,
    at: r.created_at,
  }));
}

/** Fold the activity log into recalc inputs: interviews → transcript, notes/comments → corrections. */
function activityDigest(acts: ActivityEntry[]): { transcript: string; notes: CorrectionEntry[] } {
  const transcript = acts
    .filter((a) => a.type === "interview")
    .map((a) => `[${a.author}] ${a.body}`)
    .join("\n\n");
  const notes: CorrectionEntry[] = acts
    .filter((a) => a.type !== "interview")
    .map((a) => ({ ts: a.at, text: a.body, reviewerLabel: a.author }));
  return { transcript, notes };
}

/** Append a human entry to the candidate's activity log. Claude never writes here. */
export async function logActivity(input: {
  candidateId: string;
  type: ActivityType;
  author?: string;
  body: string;
}): Promise<{ ok: boolean; entry: ActivityEntry | null; message?: string }> {
  await requireAuth();
  const body = input.body.trim();
  if (!body) return { ok: false, entry: null, message: "Empty entry" };
  if (!hasSupabase()) return { ok: false, entry: null, message: "Supabase not configured" };

  const ident = await reviewerIdentity();
  const author = input.author?.trim() || ident.label || "You";
  const supabase = getServiceSupabase();
  const { data, error } = await supabase
    .from("activity")
    .insert({ candidate_id: input.candidateId, type: input.type, author, body })
    .select("id, created_at")
    .single();
  if (error || !data) {
    console.error("logActivity failed", error);
    return { ok: false, entry: null, message: "Save failed — please retry." };
  }
  revalidatePath("/");
  return { ok: true, entry: { id: data.id as string, type: input.type, author, body, at: data.created_at as string } };
}

/**
 * "Update assessment" (HANDOFF-v2 §2, Build Spec §1): re-run the evaluator over
 * the DELTA — the activity log (interviews → transcript, notes/comments folded as
 * corrections) plus the stored working file — and re-persist the pinned assessment.
 * Free-chat turns never reach here; only this re-persists the read.
 */
export async function updateAssessment(input: {
  candidateId: string;
}): Promise<RecalcResult & { regenAt?: string }> {
  await requireAuth();
  if (!hasSupabase()) return { ok: false, recalculated: false, read: null, message: "Supabase not configured" };

  let one = await loadOneCandidate(input.candidateId);
  if (!one) return { ok: false, recalculated: false, read: null, message: "Candidate not found" };

  // Readiness gate + repair first, then reload so freshly-pulled materials are used.
  const prepared = await prepareGradingInputs(input.candidateId, one.jobShortcode);
  one = (await loadOneCandidate(input.candidateId)) ?? one;

  const acts = await fetchActivity(input.candidateId);
  const { transcript, notes } = activityDigest(acts);
  const combinedTranscript = [one.slice.transcript ?? "", transcript].filter(Boolean).join("\n\n");
  const corrections = [...(one.slice.corrections ?? []), ...notes];

  const baseContent = renderWorkingFile(one.candidate, one.slice, {
    workableUrl: one.workableUrl,
    disqualified: one.disqualified,
  });
  const priorDecision = one.candidate.decision;

  const result = await gradeCandidate({
    candidate: one.candidate,
    jobShortcode: one.jobShortcode,
    workingFile: baseContent,
    materials: renderCandidateMaterials(one.candidate),
    corrections,
    transcript: combinedTranscript,
    replies: one.slice.replies ?? {},
    prepared,
  });
  let read = result.read;

  if (result.blocked && read?.missingInputs?.length) {
    // Persist the blocked read so the UI shows exactly what grading is waiting on.
    const blockedCandidate = applyRead(one.candidate, read);
    const blockedContent = renderWorkingFile(blockedCandidate, one.slice, { workableUrl: one.workableUrl, disqualified: one.disqualified });
    await upsertWorkingFile(input.candidateId, { content: blockedContent, read }, await reviewerLabel());
    revalidatePath("/");
    return {
      ok: true,
      recalculated: false,
      read,
      message: `Saved. Review blocked — waiting on ${describeMissing(read.missingInputs)} before a read can be made.`,
    };
  }

  if (!read) {
    return { ok: true, recalculated: false, read: null, message: "Saved. Claude re-analysis unavailable (no API key or transient error)." };
  }

  if (read.decision !== priorDecision) {
    read = {
      ...read,
      reanalysis: {
        reviewer: "Activity log",
        before: DM(priorDecision).label,
        after: DM(read.decision).label,
        rec: read.timelineNote || read.why,
      },
    };
  }

  const candidate = applyRead(one.candidate, read);
  const content = renderWorkingFile(candidate, one.slice, { workableUrl: one.workableUrl, disqualified: one.disqualified });
  await upsertWorkingFile(input.candidateId, { content, read }, await reviewerLabel());
  revalidatePath("/");
  return { ok: true, recalculated: true, read, regenAt: nowStamp() };
}

interface ChatResult {
  ok: boolean;
  messages: ChatMessage[];
  message?: string;
}

/**
 * Continue the per-candidate "war room" conversation with Claude. Appends the
 * human's turn, calls Claude grounded in the candidate's working file + rubric +
 * spec, appends the reply, and persists the whole thread to the workspace so the
 * conversation survives reloads. Resilient: on any AI failure the human turn is
 * still saved and a friendly notice is returned.
 */
export async function sendCandidateChat(input: {
  candidateId: string;
  message: string;
}): Promise<ChatResult> {
  await requireAuth();
  const text = input.message.trim();
  if (!text) return { ok: false, messages: [], message: "Empty message" };
  if (!hasSupabase()) return { ok: false, messages: [], message: "Supabase not configured" };

  const ident = await reviewerIdentity();
  const existing = await getWorkingFile(input.candidateId);
  const history = existing?.workspace.chat ?? [];
  const userMsg: ChatMessage = {
    role: "user",
    content: text,
    ts: new Date().toISOString(),
    author: ident.label,
  };
  const withUser = [...history, userMsg];

  // Build fresh grounding context from the candidate's current working file plus
  // the verbatim source materials (cover letter, answers, résumé, transcripts) so
  // Claude can quote and verify the actual text, not just the summarized read.
  const one = await loadOneCandidate(input.candidateId);
  const workingFile = one
    ? renderWorkingFile(one.candidate, one.slice, {
        workableUrl: one.workableUrl,
        disqualified: one.disqualified,
      })
    : existing?.content ?? "";
  const baseMaterials = one ? renderCandidateMaterials(one.candidate) : "";
  const acts = await fetchActivity(input.candidateId);
  const activityBlock = acts.length
    ? `## Activity log (${acts.length} ${acts.length === 1 ? "entry" : "entries"})\n\n` +
      acts.map((a) => `- [${a.type}] ${a.author} (${a.at.slice(0, 10)}): ${a.body}`).join("\n")
    : "";
  const materials = [baseMaterials, activityBlock].filter(Boolean).join("\n\n");
  const rubric = one ? await getJobRubric(one.jobShortcode) : { rubricMd: "", specMd: "" };

  // Cross-candidate awareness: load a compact roster of every OTHER candidate in
  // this job's pool, and give Claude a tool to pull any of their full records on
  // demand (RAG-like, scoped to this pool). The same job pool is already fully
  // visible to any authenticated user via the pool screen, so this adds no new
  // exposure; the tool is hard-scoped to ids present in this roster.
  const roster = one ? await loadPoolRoster(one.jobShortcode, one.candidate.id) : [];
  const rosterText = roster
    .map((r) => {
      const head =
        `- ${r.name} [id:${r.id}] — ${r.role}` +
        (r.company && r.company !== "—" ? ` @ ${r.company}` : "") +
        ` · ${DM(r.decision).label}` +
        (r.experience && r.experience !== "—" ? ` · ${r.experience} exp` : "") +
        (r.roLevel && r.roLevel !== "—" ? ` · RO ${r.roLevel}` : "");
      return r.why ? `${head}\n  why: ${r.why}` : head;
    })
    .join("\n");

  const rosterById = new Map(roster.map((r) => [r.id, r]));
  const rosterByName = new Map(roster.map((r) => [r.name.toLowerCase(), r]));
  const fetchOtherCandidate = async (
    query: string,
  ): Promise<{ name: string; content: string } | null> => {
    const q = query.trim();
    if (!q) return null;
    const ql = q.toLowerCase();
    const entry =
      rosterById.get(q) ??
      rosterByName.get(ql) ??
      roster.find((r) => r.name.toLowerCase().includes(ql) || ql.includes(r.name.toLowerCase()));
    if (!entry) return null;
    const other = await loadOneCandidate(entry.id);
    if (!other) return null;
    const otherFile = renderWorkingFile(other.candidate, other.slice, {
      workableUrl: other.workableUrl,
      disqualified: other.disqualified,
    });
    const otherMaterials = renderCandidateMaterials(other.candidate);
    const content = [otherFile, otherMaterials].filter(Boolean).join("\n\n");
    return { name: other.candidate.name, content };
  };

  const reply = await chatWithClaude({
    candidateName: one?.candidate.name,
    workingFile,
    materials,
    rubric: rubric.rubricMd,
    jobSpec: rubric.specMd,
    roster: rosterText,
    fetchOtherCandidate: roster.length ? fetchOtherCandidate : undefined,
    // Cap the turns we replay so a long thread can't blow the context window.
    history: withUser.slice(-24),
  });

  const next: ChatMessage[] = reply
    ? [...withUser, { role: "assistant", content: reply, ts: new Date().toISOString() }]
    : withUser;

  // Persist the human turn (and Claude's reply when we got one) either way.
  await upsertWorkingFile(input.candidateId, { workspace: { chat: next } }, ident.label);

  return {
    ok: Boolean(reply),
    messages: next,
    message: reply ? undefined : "Claude is unavailable right now (no API key or transient error) — your message was saved.",
  };
}

/** Clear a candidate's war-room conversation. */
export async function clearCandidateChat(input: { candidateId: string }): Promise<{ ok: boolean }> {
  await requireAuth();
  if (!hasSupabase()) return { ok: false };
  await upsertWorkingFile(input.candidateId, { workspace: { chat: [] } }, await reviewerLabel());
  return { ok: true };
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
      if (result.applicationIngested) {
        return { ok: true, message: "Synced from Workable · résumé pulled in." };
      }
      if (result.resumeError) {
        // The ingest was attempted and genuinely failed — surface it rather than
        // reporting a misleading success.
        return {
          ok: false,
          message: `Synced from Workable, but résumé parse failed: ${result.resumeError}`,
        };
      }
      return {
        ok: true,
        message: candidate.resume_url
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
