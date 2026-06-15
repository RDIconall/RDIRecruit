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
    `- Workable: ${opts.workableUrl}\n` +
    `- Last updated: ${nowStamp()}\n\n`;

  s += "## RO time progression\n\n| Period | Org/School | Role | Tenure | Scope | Signal |\n|---|---|---|---|---|---|\n";
  tl.forEach((r) => {
    s += `| ${r.period || ""} | ${r.org || ""} | ${r.role || ""} | ${r.tenure || ""} | ${r.scope || ""} | ${r.signal || ""} |\n`;
  });

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
