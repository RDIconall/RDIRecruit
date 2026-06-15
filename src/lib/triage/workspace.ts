import type { Candidate, TimelineRow, Workspace } from "./types";
import { DM } from "./theme";

// Prototype persistence key. Move to the DB (Supabase) when wiring server-side;
// the connectors live in src/lib/supabase and src/lib/sync.
export const WS_KEY = "rdi-recruit-ws-v1";

// Workable deeplink config. Non-secret; the real candidate IDs come from the
// Workable API server-side (see src/lib/workable/client.ts + links.ts).
export const WSUB = "rditrials";
export const WJOB = "1284673";

// Deterministic mock Workable candidate id from our internal id. Replace with
// the real Workable candidate id once the API sync lands.
export function wcand(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return "50" + String(100000000 + (h % 900000000));
}

export function jobUrl(): string {
  return `https://${WSUB}.workable.com/backend/jobs/${WJOB}`;
}

export function candUrl(id: string): string {
  return `${jobUrl()}/candidates/${wcand(id)}`;
}

export function emptyWorkspace(): Workspace {
  return { dq: {}, ovr: {}, replies: {}, corrections: {}, transcripts: {}, deep: {} };
}

export function loadWorkspace(): Workspace {
  if (typeof window === "undefined") return emptyWorkspace();
  try {
    const raw = window.localStorage.getItem(WS_KEY);
    if (!raw) return emptyWorkspace();
    const d = JSON.parse(raw) as Partial<Workspace>;
    return {
      dq: d.dq || {},
      ovr: d.ovr || {},
      replies: d.replies || {},
      corrections: d.corrections || {},
      transcripts: d.transcripts || {},
      deep: d.deep || {},
    };
  } catch {
    return emptyWorkspace();
  }
}

export function saveWorkspace(ws: Workspace): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WS_KEY, JSON.stringify(ws));
  } catch {
    // ignore quota / serialization errors in the prototype
  }
}

export function nowStamp(): string {
  const d = new Date();
  return (
    d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) +
    " " +
    d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
  );
}

export function effectiveTimeline(c: Candidate, ws: Workspace): TimelineRow[] {
  return (ws.ovr[c.id] || c.timeline || []).map((r) => ({ ...r }));
}

// The per-candidate working file: one candidate = one living case file.
export function buildMd(c: Candidate, ws: Workspace): string {
  const id = c.id;
  const tl = effectiveTimeline(c, ws);
  const corr = ws.corrections[id] || [];
  const reps = ws.replies[id] || {};
  const tr = ws.transcripts[id] || "";

  let s = `# Candidate: ${c.name}\n\n`;
  s +=
    `- Role applied: ${c.role}\n` +
    `- Current company: ${c.company}\n` +
    `- Salary ask: ${c.salary}\n` +
    `- RO level: ${c.roLevel}\n` +
    `- Decision: ${DM(c.decision).label}${ws.dq[id] ? " (DISQUALIFIED)" : ""}\n` +
    `- Workable: ${candUrl(id)}\n` +
    `- Last updated: ${nowStamp()}\n\n`;

  s += "## RO time progression\n\n| Period | Org/School | Role | Tenure | Scope | Signal |\n|---|---|---|---|---|---|\n";
  tl.forEach((r) => {
    s += `| ${r.period || ""} | ${r.org || ""} | ${r.role || ""} | ${r.tenure || ""} | ${r.scope || ""} | ${r.signal || ""} |\n`;
  });

  s += "\n## Corrections (human, persisted)\n\n";
  if (corr.length) corr.forEach((e) => (s += `- [${e.ts}] ${e.text}\n`));
  else s += "- none\n";

  s += "\n## Notes to Claude (replies on its comments)\n\n";
  const rk = Object.keys(reps).filter((k) => reps[k]);
  if (rk.length) rk.forEach((k) => (s += `- (${k}) ${reps[k]}\n`));
  else s += "- none\n";

  if (c.interview) s += `\n## Interview summary\n\n${c.interview.title}\n\n${c.interview.fit}\n`;
  if (tr) s += `\n## Pasted transcript\n\n${tr}\n`;

  return s;
}
