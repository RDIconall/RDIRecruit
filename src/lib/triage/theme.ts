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

export function DM(d: Decision): DecisionMeta {
  const m: Record<Decision, DecisionMeta> = {
    interview: { label: "Interview", c: "#E74424", bg: "rgba(231,68,36,0.10)", b: "rgba(231,68,36,0.32)" },
    backup: { label: "Backup", c: "rgba(22,35,53,0.55)", bg: "transparent", b: "rgba(22,35,53,0.16)" },
    reject: { label: "Reject", c: "#9E3B28", bg: "rgba(158,59,40,0.07)", b: "rgba(158,59,40,0.24)" },
    blocked: { label: "Review blocked", c: "#E74424", bg: "transparent", b: "rgba(231,68,36,0.32)" },
  };
  return m[d] || m.backup;
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
    ai: { label: "AI generated", color: "#C0392B", hl: "rgba(192,57,43,0.10)" },
    wrong: { label: "Wrong company", color: "#C0392B", hl: "rgba(192,57,43,0.14)" },
    typo: { label: "Typo / sloppy", color: "#C0392B", hl: "rgba(192,57,43,0.10)" },
    flag: { label: "Evasive", color: "#C0392B", hl: "rgba(192,57,43,0.10)" },
    thin: { label: "Surface", color: "#B45309", hl: "rgba(180,83,9,0.10)" },
    good: { label: "Owned", color: "#0B8F6A", hl: "rgba(11,143,106,0.10)" },
    ask: { label: "Ask this live", color: "#2563EB", hl: "rgba(37,99,235,0.08)" },
    neutral: { label: "Note", color: "#595959", hl: "transparent" },
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
