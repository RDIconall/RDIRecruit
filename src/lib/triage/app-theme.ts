// RDIRecruit app (v2) design tokens — the INTERNAL tool surface, NOT the RDI
// marketing brand. System fonts, neutral palette, one functional blue accent.
// Contract: cursor-handoff/HANDOFF-v2.md §0 + cursor-handoff/RDIRecruit (app).dc.html.
// No brand fonts, no scores/tiers, no emoji.

import type { Decision, ReadinessInput } from "./types";

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

// The pool's four active groups, in fixed display order (HANDOFF-v2 §1.A).
// `cut`/`blocked` reads fold into Hold; disqualified collapses out separately.
export const POOL_GROUPS: { key: Decision; label: string }[] = [
  { key: "interview", label: "Interview first" },
  { key: "verify", label: "Verify first" },
  { key: "short", label: "Short screen" },
  { key: "hold", label: "Hold" },
];

export function poolGroupOf(decision: Decision): Decision {
  if (decision === "interview" || decision === "verify" || decision === "short") return decision;
  return "hold"; // hold, cut, blocked all live in the Hold group on the board
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
  interview: "Interview first",
  short: "Short screen",
  verify: "Verify first",
  hold: "Hold",
  cut: "Cut",
  blocked: "Review blocked",
};

// Neutral decision color: the accent reads "interview first", red reads "cut",
// muted reads "blocked"; everything else is plain ink. One accent only.
export function decisionColor(d: Decision): string {
  if (d === "interview") return APP.accent;
  if (d === "cut") return APP.weak;
  if (d === "blocked") return APP.muted;
  return APP.ink;
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
