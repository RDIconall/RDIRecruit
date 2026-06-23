import { DM } from "./theme";
import type { Candidate, TimelineRow, WorkspaceSlice } from "./types";

// Matches the prototype's nowStamp() (en-US date + time) so the stored .md reads
// the same as the spec's buildMd() output.
function nowStamp(): string {
  const d = new Date();
  return (
    d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) +
    " " +
    d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
  );
}

// Format an ISO timestamp the same en-US way as nowStamp(); falls back to the
// raw string when it isn't a parseable date.
function nowStampFrom(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return (
    d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) +
    " " +
    d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
  );
}

function effectiveTimeline(c: Candidate, slice: WorkspaceSlice): TimelineRow[] {
  return (slice.ovr ?? c.timeline ?? []).map((r) => ({ ...r }));
}

/**
 * Render the living per-candidate markdown working file — "one candidate = one
 * living case file". This is the faithful port of the spec's buildMd()
 * (prototype src/lib/triage/workspace.ts): same sections, same order —
 *   header → RO time progression → Corrections → Notes to Claude →
 *   Interview summary (if any) → Pasted transcript (if any).
 * It operates on the mapped (real-data) Candidate, its persisted human edits,
 * and the real Workable link.
 */
export function renderWorkingFile(
  c: Candidate,
  slice: WorkspaceSlice,
  opts: { workableUrl: string; disqualified: boolean },
): string {
  const tl = effectiveTimeline(c, slice);
  const corr = slice.corrections ?? [];
  const reps = slice.replies ?? {};
  const transcript = slice.transcript ?? "";

  let s = `# Candidate: ${c.name}\n\n`;
  s +=
    `- Role applied: ${c.role}\n` +
    `- Current company: ${c.company}\n` +
    `- Salary ask: ${c.salary}\n` +
    `- RO level: ${c.roLevel}\n` +
    `- Decision: ${DM(c.decision).label}${opts.disqualified ? " (DISQUALIFIED)" : ""}\n` +
    (c.value && c.value.headline && c.value.headline !== "—"
      ? `- Strength vs salary: ${c.value.headline}${c.value.detail ? ` — ${c.value.detail}` : ""}\n`
      : "") +
    (c.caveat ? `- Confirm before interview: ${c.caveat}\n` : "") +
    `- Workable: ${opts.workableUrl}\n` +
    `- Last updated: ${nowStamp()}\n\n`;

  if (c.assessment && (c.assessment.bio || c.assessment.application || c.assessment.commute)) {
    s += "## AI assessment";
    if (c.assessedAt) s += ` (generated ${nowStampFrom(c.assessedAt)})`;
    s += "\n\n";
    if (c.assessment.bio) s += `### Who they are\n\n${c.assessment.bio}\n\n`;
    if (c.assessment.application) s += `### What the application says\n\n${c.assessment.application}\n\n`;
    if (c.assessment.commute) s += `### Commute\n\n${c.assessment.commute}\n\n`;
  }

  s += "## RO time progression\n\n| Period | Org/School | Role | Tenure | Scope | Signal |\n|---|---|---|---|---|---|\n";
  tl.forEach((r) => {
    s += `| ${r.period || ""} | ${r.org || ""} | ${r.role || ""} | ${r.tenure || ""} | ${r.scope || ""} | ${r.signal || ""} |\n`;
  });

  if (c.rubricFit && (c.rubricFit.verdict || c.rubricFit.summary || c.rubricFit.strengths.length || c.rubricFit.gaps.length)) {
    s += `\n## Rubric fit — ${c.rubricFit.verdict || "read"}\n\n`;
    if (c.rubricFit.summary) s += `${c.rubricFit.summary}\n\n`;
    if (c.rubricFit.strengths.length) {
      s += "**Rubric-aligned strengths**\n\n";
      c.rubricFit.strengths.forEach((x) => (s += `- ${x}\n`));
      s += "\n";
    }
    if (c.rubricFit.gaps.length) {
      s += "**Rubric gaps**\n\n";
      c.rubricFit.gaps.forEach((x) => (s += `- ${x}\n`));
      s += "\n";
    }
  }

  s += "\n## Corrections (human, persisted)\n\n";
  if (corr.length) corr.forEach((e) => (s += `- [${e.ts}]${e.reviewerLabel ? ` (${e.reviewerLabel})` : ""} ${e.text}\n`));
  else s += "- none\n";

  s += "\n## Notes to Claude (replies on its comments)\n\n";
  const rk = Object.keys(reps).filter((k) => reps[k]);
  if (rk.length) rk.forEach((k) => (s += `- (${k}) ${reps[k]}\n`));
  else s += "- none\n";

  if (c.interview) s += `\n## Interview summary\n\n${c.interview.title}\n\n${c.interview.fit}\n`;
  if (transcript) s += `\n## Pasted transcript\n\n${transcript}\n`;

  return s;
}

// Per-section caps so a long résumé or transcript can't blow the context window.
const COVER_CAP = 12000;
const ANSWERS_CAP = 10000;
const RESUME_CAP = 14000;
const TRANSCRIPT_CAP = 12000;

function cap(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…";
}

/**
 * Serialize the candidate's RAW source materials — cover letter, application
 * answers, résumé text, and any interview/Fireflies transcripts — as a single
 * markdown block. The working file (renderWorkingFile) is the analysis layer and
 * deliberately omits these verbatim sources; the "war room" chat needs them so
 * Claude can quote and verify the actual text (e.g. a cover-letter claim) rather
 * than reasoning only from the summarized read. Degrades gracefully: sections
 * with no data on file are skipped, and an empty result returns "".
 */
export function renderCandidateMaterials(c: Candidate): string {
  const sections: string[] = [];

  if (c.cover?.hasLetter && c.cover.lines.length) {
    const body = c.cover.lines.map((ln) => ln.t).join("\n\n");
    sections.push(`## Cover letter (verbatim)\n\n${cap(body, COVER_CAP)}`);
  }

  if (c.answers?.length) {
    const body = c.answers
      .filter((a) => (a.q || a.a) && (a.a || "").trim())
      .map((a) => `**Q: ${a.q || "Application question"}**\n${a.a}`)
      .join("\n\n");
    if (body.trim()) sections.push(`## Application answers (verbatim)\n\n${cap(body, ANSWERS_CAP)}`);
  }

  if (c.resume?.hasResume) {
    if (c.resume.fullText?.trim()) {
      sections.push(`## Résumé (extracted text)\n\n${cap(c.resume.fullText, RESUME_CAP)}`);
    } else if (c.resume.roles.length) {
      const body = c.resume.roles
        .map((r) => {
          const head = `### ${r.title} — ${r.company} (${r.period}${r.current ? " · current" : ""})`;
          const bullets = r.bullets.length ? "\n" + r.bullets.map((b) => `- ${b}`).join("\n") : "";
          return head + bullets;
        })
        .join("\n\n");
      sections.push(`## Résumé (parsed roles)\n\n${cap(body, RESUME_CAP)}`);
    }
  }

  const recordings = (c.fireflies ?? []).filter((f) => f.transcript?.trim());
  for (const f of recordings) {
    sections.push(`## Interview transcript — ${f.title}${f.date && f.date !== "—" ? ` (${f.date})` : ""}\n\n${cap(f.transcript, TRANSCRIPT_CAP)}`);
  }

  return sections.join("\n\n");
}
