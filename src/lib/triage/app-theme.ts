// RDIRecruit app (v2) design tokens — the INTERNAL tool surface, NOT the RDI
// marketing brand. System fonts, neutral palette, one functional blue accent.
// Contract: cursor-handoff/HANDOFF-v2.md §0 + cursor-handoff/RDIRecruit (app).dc.html.
// No brand fonts, no scores/tiers, no emoji.

import type { Decision, ProcessStatus, ReadinessInput } from "./types";

export const APP = {
  // type — system stack only
  sans: "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif",
  mono: "ui-monospace,'SF Mono',Menlo,Consolas,monospace",

  // ink
  ink: "#1A1A1A",
  ink2: "#3A3A3A",
  secondary: "#595959",
  muted: "#8A8A8A",
  faint: "#9A9A9A",

  // hairlines / surfaces
  hair: "#E6E6E6",
  hair2: "#EDEDED",
  line: "#F0F0F0",
  line2: "#F4F4F4",
  surface: "#FFFFFF",
  rowHover: "#F6F8FF",

  // one functional accent + the weak/cut red
  accent: "#2563EB",
  accentHover: "#1D4ED8",
  accentSoft: "#F0F5FF",
  accentBorder: "#CBD9F5",
  weak: "#C0392B",
  weakHover: "#A93226",
  weakSoft: "#FBECEA",
  weakBorder: "#E3C9C4",
} as const;

// Verdict dot for the two cached AI reads (Answers · Vs-spec).
// Mirrors the mock's VS(): filled = strong, hollow neutral = mixed, red = weak.
export type VerdictLevel = "strong" | "mixed" | "weak" | "none";

export function verdictDot(level: VerdictLevel): { fill: string; color: string } {
  switch (level) {
    case "strong":
      return { fill: APP.ink, color: APP.ink };
    case "weak":
      return { fill: "transparent", color: APP.weak };
    case "none":
      return { fill: "transparent", color: "#C9C9C9" };
    default:
      return { fill: "transparent", color: "#78716C" };
  }
}

// Numeric weight for the within-group fit sort: fit = answers + spec.
export function fitWeight(level: VerdictLevel): number {
  return level === "strong" ? 2 : level === "mixed" ? 1 : 0;
}

// The pool's groups, in fixed display order. Interview is the ranked list you
// work top-down; Reject is the visible "do not interview" list (each with a
// reason) so you can disqualify; Blocked is waiting on materials. Disqualified
// candidates collapse out separately below the board.
export const POOL_GROUPS: { key: Decision; label: string }[] = [
  { key: "interview", label: "Interview — in priority order" },
  { key: "backup", label: "Backup" },
  { key: "reject", label: "Do not interview" },
  { key: "blocked", label: "Review blocked" },
];

export function poolGroupOf(decision: Decision): Decision {
  if (decision === "interview" || decision === "reject" || decision === "blocked") return decision;
  return "backup";
}

// Client-safe labels for the grading-readiness inputs (the server-only readiness
// module has its own copy; this one is importable from client components).
export const READINESS_INPUT_LABELS: Record<ReadinessInput, string> = {
  answers: "screening answers",
  resume: "parsed résumé",
  jobSpec: "job spec",
  methodology: "how-we-hire methodology",
};

export function describeMissingInputs(missing: ReadinessInput[]): string {
  return missing.map((m) => READINESS_INPUT_LABELS[m]).join(", ");
}

// The fixed decision vocabulary — the ONLY status language (no scores/tiers).
export const DECISION_LABEL: Record<Decision, string> = {
  interview: "Interview",
  backup: "Backup",
  reject: "Reject",
  blocked: "Review blocked",
};

// --- Post-decision process status (our pipeline, set in-app) ------------------
// A separate dimension from the triage Decision: where a candidate we've decided
// to pursue is in OUR process. Ordered as the workflow progresses.
export const PROCESS_STATUS_OPTIONS: ProcessStatus[] = [
  "sentToLara",
  "interviewing",
  "referenceChecks",
  "offer",
  "hired",
  "passed",
];

export const PROCESS_STATUS_LABEL: Record<ProcessStatus, string> = {
  sentToLara: "Sent to Lara",
  interviewing: "Interviewing",
  referenceChecks: "Reference checks",
  offer: "Offer",
  hired: "Hired",
  passed: "Passed",
};

// Chip color for a process status: hired reads as the accent (good outcome),
// passed reads muted (closed out), the rest are plain ink (in flight).
export function processColor(s: ProcessStatus): string {
  if (s === "hired") return APP.accent;
  if (s === "passed") return APP.muted;
  return APP.ink;
}

// --- Workable pipeline stage (mirrored read-only from the ATS) ----------------
// Workable stages every applicant starts in (Sourced/Applied/New) are the default
// and read as noise on the board — we only surface the chip once a candidate has
// been ADVANCED (Phone screen and beyond), which is the signal recruiters act on.
const DEFAULT_WORKABLE_STAGES = new Set(["", "sourced", "applied", "new", "lead", "candidate"]);

export function isAdvancedStage(stage: string | null | undefined): boolean {
  return !DEFAULT_WORKABLE_STAGES.has((stage ?? "").trim().toLowerCase());
}

/** Tidy a raw Workable stage string for display ("phone_screen" → "Phone screen"). */
export function workableStageLabel(stage: string | null | undefined): string {
  const raw = (stage ?? "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

// Neutral decision color: the accent reads "interview", red reads "reject",
// muted reads "blocked"; backup is plain ink. One accent only.
export function decisionColor(d: Decision): string {
  if (d === "interview") return APP.accent;
  if (d === "reject") return APP.weak;
  if (d === "blocked") return APP.muted;
  return APP.ink;
}

// Strength-vs-salary value read → dot color (mirrors verdictDot). strong reads
// as the accent, fair neutral, weak red.
export function valueDot(level: "strong" | "fair" | "weak" | "none"): { fill: string; color: string } {
  switch (level) {
    case "strong":
      return { fill: APP.accent, color: APP.accent };
    case "weak":
      return { fill: "transparent", color: APP.weak };
    case "none":
      return { fill: "transparent", color: "#C9C9C9" };
    default:
      return { fill: "transparent", color: APP.ink };
  }
}

// Numeric weight for ordering the interview list by value (strong first).
// "none" (no read yet / ask not stated) sits ABOVE "weak": an unknown ask is
// still a better bet than a known-overpriced one.
export function valueWeight(level: "strong" | "fair" | "weak" | "none"): number {
  return level === "strong" ? 3 : level === "fair" ? 2 : level === "none" ? 1 : 0;
}

// Deterministic, stable avatar tint from a candidate id/name — muted neutrals
// plus the single accent, so the board reads calm.
const AVATAR_TINTS = ["#1A1A1A", "#3F3F46", "#52525B", "#2563EB", "#475569", "#5B5B5B", "#404040"];

export function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_TINTS[h % AVATAR_TINTS.length];
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
