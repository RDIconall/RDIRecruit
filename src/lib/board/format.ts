import type { BoardCandidate, CategoryKey, CategoryScores } from "../types";

/**
 * Display labels for the six scoring dimensions. These mirror the category names
 * used in the rubric markdown (the "Weights" section the grader scores against),
 * so the board, the evaluator prompt, and the rubric stay consistent. They are
 * deliberately seat-neutral — earlier science-specific aliases ("Lab & CLIA",
 * "Regulatory") were demo-mock leftovers that did not match real rubrics.
 */
export const CATEGORY_LABELS: Record<CategoryKey, string> = {
  principal: "Principal",
  environment: "Environment",
  scope: "Scope",
  writing: "Writing",
  tenure: "Tenure",
  local: "Local",
};

export const CATEGORY_MAX: Record<CategoryKey, number> = {
  principal: 25,
  environment: 20,
  scope: 20,
  writing: 15,
  tenure: 10,
  local: 10,
};

export type TierKey = "strong" | "viable" | "hold" | "low";

export const TIER_META: Record<TierKey, { label: string; color: string; note: string }> = {
  strong: { label: "Strong", color: "#15803d", note: "clears the rubric bar — advance" },
  viable: { label: "Consider", color: "#162335", note: "holds the level, watch the caveat" },
  hold: { label: "Hold", color: "#b45309", note: "borderline — needs more evidence" },
  low: { label: "Deny", color: "#b91c1c", note: "below the seat requirement" },
};

export function tierKeyFromTotal(total: number | null | undefined): TierKey {
  if (total == null) return "hold";
  if (total >= 85) return "strong";
  if (total >= 70) return "viable";
  if (total >= 55) return "hold";
  return "low";
}

export function formatTierLabel(total: number | null | undefined): string {
  return TIER_META[tierKeyFromTotal(total)].label;
}

export function salaryColor(value: string | null | undefined): string {
  const map: Record<string, string> = {
    justified: "rgba(22,35,53,0.82)",
    "great value": "#15803d",
    "rich for fit": "#b45309",
    "poor value": "#b91c1c",
    unstated: "rgba(22,35,53,0.45)",
  };
  return map[value ?? "unstated"] ?? "rgba(22,35,53,0.82)";
}

export function confidenceColor(value: string | null | undefined): string {
  const map: Record<string, string> = {
    high: "rgba(22,35,53,0.82)",
    medium: "#b45309",
    "text-unreliable": "#b91c1c",
    confirmed: "rgba(22,35,53,0.82)",
  };
  return map[value ?? "medium"] ?? "rgba(22,35,53,0.82)";
}

export function trajectoryMeta(trajectory: string | null | undefined) {
  const map: Record<string, { arrow: string; color: string }> = {
    "grows-the-role": { arrow: "↗", color: "#15803d" },
    plateaued: { arrow: "→", color: "rgba(22,35,53,0.50)" },
    "bends-away": { arrow: "↘", color: "#b45309" },
    regressed: { arrow: "↓", color: "#b91c1c" },
  };
  return map[trajectory ?? "plateaued"] ?? map.plateaued!;
}

export function categorySegments(scores: CategoryScores | undefined) {
  if (!scores) return [];
  const opacity: Record<CategoryKey, number> = {
    principal: 1,
    environment: 0.72,
    scope: 0.56,
    writing: 0.42,
    tenure: 0.3,
    local: 0.2,
  };
  return (Object.keys(scores) as CategoryKey[]).map((key) => ({
    key,
    width: `${Math.round((scores[key] / CATEGORY_MAX[key]) * 100)}%`,
    bg: `rgba(22,35,53,${opacity[key]})`,
  }));
}

export function categoryLine(scores: CategoryScores | undefined): string {
  if (!scores) return "";
  return (Object.keys(scores) as CategoryKey[])
    .map((key) => `${CATEGORY_LABELS[key]} ${scores[key]}`)
    .join(" · ");
}

function candidateStatus(item: BoardCandidate): "active" | "disqualified" | "withdrawn" {
  if (item.overlay?.status === "withdrawn") return "withdrawn";
  if (item.overlay?.status === "disqualified" || item.candidate.disqualified) return "disqualified";
  return "active";
}

export function boardStats(items: BoardCandidate[]) {
  const active = items.filter((i) => candidateStatus(i) === "active");
  return {
    active: active.length,
    strong: active.filter((i) => tierKeyFromTotal(i.score?.total) === "strong").length,
    new: active.filter((i) => {
      if (!i.candidate.created_at) return false;
      return Date.now() - new Date(i.candidate.created_at).getTime() < 7 * 86400000;
    }).length,
    out: items.filter((i) => candidateStatus(i) !== "active").length,
  };
}

/**
 * Composes the §2 investment read live from cached fields — no Claude on render.
 * Mirrors the mockup's `investText`: it rewrites itself as candidates are
 * disqualified or withdraw.
 */
export function investCopy(input: {
  complement: string | null | undefined;
  removes?: string | null;
  vector?: string | null;
  rank: number;
  name?: string | null;
  ask?: string | null;
  active?: boolean;
  statusLabel?: string;
  pool?: { active: number; owners: number };
}) {
  const isOwner = input.complement === "owner";
  const head = isOwner ? "Risk off the company" : "Work off the desk";
  const first = (input.name ?? "This candidate").replace(/^Dr\.\s*/, "").split(" ").slice(-1)[0] || "This candidate";
  const active = input.pool?.active ?? 0;
  const owners = input.pool?.owners ?? 0;

  if (input.active === false) {
    return {
      head,
      text: `${first} is out of the running (${(input.statusLabel ?? "inactive").toLowerCase()}). ${active} candidate${active === 1 ? "" : "s"} remain live.`,
    };
  }

  const removes = input.removes ?? (isOwner ? "founder-dependency risk" : "operational load off the desk");
  const standing = isOwner
    ? owners <= 1
      ? "he is the only owner complement"
      : "he is the strongest owner complement"
    : input.rank === 1
      ? "he is the top of the pool"
      : `he ranks #${input.rank} of ${active}`;
  const complementClause = isOwner
    ? "an owner complement — the founder-dependency a buyer prices"
    : "a technician complement — operational relief off the desk";
  const priceClause = input.ask ? ` At ${input.ask} he is ${input.vector ?? "to be priced against the load removed"}.` : "";

  return {
    head,
    text: `${first} buys down ${removes}. That is ${complementClause}. Of ${active} candidate${active === 1 ? "" : "s"} still live, ${standing}.${priceClause}`,
  };
}

export function parseSalaryAsk(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = raw.match(/\$?\s*(\d{2,3})[\s,]*k/i);
  if (match) return `$${match[1]}k`;
  return raw.length <= 24 ? raw : `${raw.slice(0, 24)}…`;
}

export function parseSalaryAskFromText(...parts: Array<string | null | undefined>): string | null {
  for (const part of parts) {
    if (!part) continue;
    const ask = parseSalaryAsk(part);
    if (ask && ask.startsWith("$")) return ask;
  }
  return null;
}
