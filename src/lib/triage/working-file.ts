import { DM } from "./theme";
import type { Candidate, TimelineRow, WorkspaceSlice } from "./types";

function stamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function effectiveTimeline(c: Candidate, slice: WorkspaceSlice): TimelineRow[] {
  return (slice.ovr ?? c.timeline ?? []).map((r) => ({ ...r }));
}

/**
 * Render the living per-candidate markdown working file — "one candidate = one
 * living case file". Ports buildMd() from workspace.ts but works off the mapped
 * (real-data) Candidate, its persisted human edits, and the real Workable link.
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
    `- Last updated: ${stamp()}\n\n`;

  s += `## Decision read\n\n`;
  s += `- **Why:** ${c.why}\n`;
  s += `- **Main risk:** ${c.flag}\n`;
  s += `- **Next action:** ${c.next}\n\n`;

  s += "## RO time progression\n\n| Period | Org/School | Role | Tenure | Scope | Signal |\n|---|---|---|---|---|---|\n";
  tl.forEach((r) => {
    s += `| ${r.period || ""} | ${r.org || ""} | ${r.role || ""} | ${r.tenure || ""} | ${(r.scope || "").replace(/\|/g, "/")} | ${r.signal || ""} |\n`;
  });

  s += "\n## Corrections (human, persisted)\n\n";
  if (corr.length) corr.forEach((e) => (s += `- [${e.ts}] ${e.text}\n`));
  else s += "- none\n";

  s += "\n## Notes to Claude (replies on its comments)\n\n";
  const rk = Object.keys(reps).filter((k) => reps[k]);
  if (rk.length) rk.forEach((k) => (s += `- (${k}) ${reps[k]}\n`));
  else s += "- none\n";

  if (c.answers.length) {
    s += "\n## Application answers\n\n";
    c.answers.forEach((qa) => {
      s += `**${qa.q}**\n\n${qa.a}\n\n`;
      if (qa.comment) s += `> Claude: ${qa.comment}\n\n`;
    });
  }

  if (transcript) s += `\n## Pasted / pulled transcript\n\n${transcript}\n`;

  return s;
}
