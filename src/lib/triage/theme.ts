// RDI design system tokens. No new hues, no gradients, no emoji.
export const COLORS = {
  navy: "#162335",
  orange: "#E74424",
  cream: "#FAFAF7",
  brick: "#9E3B28", // reserved for cut / flags
  white: "#FFFFFF",
} as const;

// Font stacks. The licensed RDI faces (National 2 / Söhne Mono / Tiempos
// Headline) are substituted with the closest Google faces wired in layout.tsx
// via CSS variables, preserving the brand feel without shipping licensed files.
export const FONTS = {
  sans: "var(--font-instrument-sans), -apple-system, system-ui, sans-serif",
  mono: "var(--font-jetbrains-mono), 'Söhne Mono', monospace",
  serif: "var(--font-instrument-serif), 'Tiempos Headline', Georgia, serif",
} as const;

import type {
  Decision,
  ReviewerSignal,
  TimelineSignal,
  CommentKind,
  AskTier,
} from "./types";

export interface DecisionMeta {
  label: string;
  c: string;
  bg: string;
  b: string;
}

// Labels are the recruiting ACTION each decision maps to (single source of truth
// for the pills on both screens and the .md working file's Decision line):
//   interview=Leadership Interview · short=HR Screen · verify=Targeted Follow-Up
//   · hold=Hold · cut=Reject · blocked=Blocked
export function DM(d: Decision): DecisionMeta {
  const m: Record<Decision, DecisionMeta> = {
    interview: { label: "Leadership Interview", c: "#E74424", bg: "rgba(231,68,36,0.10)", b: "rgba(231,68,36,0.32)" },
    short: { label: "HR Screen", c: "#162335", bg: "rgba(22,35,53,0.06)", b: "rgba(22,35,53,0.22)" },
    verify: { label: "Targeted Follow-Up", c: "#162335", bg: "transparent", b: "rgba(22,35,53,0.30)" },
    hold: { label: "Hold", c: "rgba(22,35,53,0.55)", bg: "transparent", b: "rgba(22,35,53,0.16)" },
    cut: { label: "Reject", c: "#9E3B28", bg: "rgba(158,59,40,0.07)", b: "rgba(158,59,40,0.24)" },
    blocked: { label: "Blocked", c: "#E74424", bg: "transparent", b: "rgba(231,68,36,0.32)" },
  };
  return m[d] || m.hold;
}

export interface ReviewerMeta {
  label: string;
  dot: string;
  c: string;
}

export function REV(r: ReviewerSignal): ReviewerMeta {
  const m: Record<ReviewerSignal, ReviewerMeta> = {
    none: { label: "Not reviewed", dot: "rgba(22,35,53,0.20)", c: "rgba(22,35,53,0.45)" },
    conallPos: { label: "Conall positive", dot: "#162335", c: "#162335" },
    conallConcern: { label: "Conall concern", dot: "#9E3B28", c: "#9E3B28" },
    laraPos: { label: "Lara positive", dot: "#162335", c: "#162335" },
    laraConcern: { label: "Lara concern", dot: "#9E3B28", c: "#9E3B28" },
    laraNo: { label: "Lara hard no", dot: "#9E3B28", c: "#9E3B28" },
    mixed: { label: "Mixed signal", dot: "#E74424", c: "#E74424" },
    second: { label: "Needs second read", dot: "#E74424", c: "#E74424" },
  };
  return m[r] || m.none;
}

export interface SignalMeta {
  c: string;
  bg: string;
}

export function SIG(s: TimelineSignal): SignalMeta {
  const m: Record<TimelineSignal, SignalMeta> = {
    Positive: { c: "#162335", bg: "rgba(22,35,53,0.06)" },
    Promotion: { c: "#E74424", bg: "rgba(231,68,36,0.10)" },
    Learning: { c: "rgba(22,35,53,0.6)", bg: "rgba(22,35,53,0.05)" },
    Strong: { c: "#E74424", bg: "rgba(231,68,36,0.10)" },
    Verify: { c: "#9E3B28", bg: "rgba(158,59,40,0.08)" },
    Ask: { c: "#9E3B28", bg: "rgba(158,59,40,0.08)" },
    Gap: { c: "#9E3B28", bg: "rgba(158,59,40,0.08)" },
    Cert: { c: "#162335", bg: "rgba(22,35,53,0.06)" },
    Connected: { c: "#162335", bg: "rgba(22,35,53,0.06)" },
    Switched: { c: "#9E3B28", bg: "rgba(158,59,40,0.08)" },
    Inflated: { c: "#9E3B28", bg: "rgba(158,59,40,0.08)" },
  };
  return m[s] || m.Positive;
}

export interface CommentMeta {
  label: string;
  color: string;
  hl: string;
}

export function CM(k: CommentKind): CommentMeta {
  const m: Record<CommentKind, CommentMeta> = {
    ai: { label: "AI-written?", color: "#9E3B28", hl: "rgba(158,59,40,0.10)" },
    wrong: { label: "Wrong company", color: "#9E3B28", hl: "rgba(158,59,40,0.14)" },
    typo: { label: "Typo / sloppy", color: "#9E3B28", hl: "rgba(158,59,40,0.10)" },
    flag: { label: "Red flag", color: "#9E3B28", hl: "rgba(158,59,40,0.10)" },
    thin: { label: "Thin / generic", color: "#9E3B28", hl: "rgba(158,59,40,0.08)" },
    good: { label: "Paid attention", color: "#162335", hl: "transparent" },
    ask: { label: "Ask this live", color: "#162335", hl: "transparent" },
    neutral: { label: "Note", color: "rgba(22,35,53,0.5)", hl: "transparent" },
  };
  return m[k] || m.neutral;
}

export function askColor(t: AskTier): string {
  return (
    { top: "#9E3B28", high: "#9E3B28", mid: "#162335", value: "#E74424", below: "#E74424" }[t] ||
    "#162335"
  );
}

export function askTierLabel(t: AskTier): string {
  return (
    {
      top: "Top-tier ask",
      high: "High ask",
      mid: "Mid-range ask",
      value: "Value ask",
      below: "Below-median ask",
    }[t] || "Mid-range ask"
  );
}

export function logColor(l: string): string {
  return ({ High: "#162335", Medium: "#E74424", Low: "#9E3B28" } as Record<string, string>)[l] || "#162335";
}
