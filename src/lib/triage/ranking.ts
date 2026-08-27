import { POOL_GROUPS, poolGroupOf, fitWeight, valueWeight } from "./app-theme";
import type { Candidate, Decision, PoolStanding } from "./types";

// Human label for each decision group's standing copy ("3rd of 12 to interview").
const GROUP_LABEL: Record<Decision, string> = {
  interview: "to interview",
  backup: "in the backup group",
  reject: "on the do-not-interview list",
  blocked: "blocked",
};

/**
 * Proven problem complexity from the RO capability read (résumé work, not prose).
 * IV/V work ranks above III, then II. Missing reads add nothing.
 */
export function complexityWeight(roLevel: string | null | undefined): number {
  const s = (roLevel ?? "").toUpperCase();
  if (s.includes("IV") || /(^|[^A-Z])V([^A-Z]|$)/.test(s)) return 3;
  if (s.includes("III")) return 2;
  if (s.includes("II")) return 1;
  return 0;
}

/**
 * Ordering inside a decision group. Interview is worked top-down:
 * job-description match first, then complexity of problems actually solved,
 * then answers and salary-value as tie-breakers. Never a displayed score.
 */
export function rankWeight(c: Pick<Candidate, "value" | "answersRead" | "specRead" | "roLevel">): number {
  const spec = fitWeight(c.specRead.level) * 1000;
  const complexity = complexityWeight(c.roLevel) * 100;
  const answers = fitWeight(c.answersRead.level) * 10;
  const value = c.value ? valueWeight(c.value.level) : 0;
  return spec + complexity + answers + value;
}

const DECISION_PRIORITY: Record<Decision, number> = {
  interview: 0,
  backup: 1,
  reject: 2,
  blocked: 3,
};

/**
 * Sort for cross-role "best new applicant": Interview first, then value/fit,
 * then newest appliedAt. Mutates nothing — returns a new array.
 */
export function sortBestNew(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => {
    const dp = DECISION_PRIORITY[a.decision] - DECISION_PRIORITY[b.decision];
    if (dp) return dp;
    const rw = rankWeight(b) - rankWeight(a);
    if (rw) return rw;
    const at = Date.parse(b.appliedAt || "") - Date.parse(a.appliedAt || "");
    return Number.isFinite(at) ? at : 0;
  });
}

/**
 * Assign each ACTIVE candidate an ordinal pool standing (never a numeric score):
 * overall rank in the pool and rank within its decision group, ordered exactly the
 * way the pool board displays them (decision groups in fixed priority; within a
 * group by fit, then by the board's score order). Mutates `candidate.standing`.
 * Disqualified candidates are excluded from the ranking.
 */
export function assignPoolStanding(
  candidates: Candidate[],
  isDisqualified: (id: string) => boolean,
): void {
  const active = candidates
    .map((c, index) => ({ c, index }))
    .filter((x) => !isDisqualified(x.c.id));

  const activeTotal = active.length;

  const flattened: { c: Candidate; index: number }[] = [];
  const groupRank = new Map<string, { rank: number; total: number; label: string }>();

  for (const g of POOL_GROUPS) {
    const rows = active
      .filter((x) => poolGroupOf(x.c.decision) === g.key)
      .sort((a, b) => rankWeight(b.c) - rankWeight(a.c) || a.index - b.index);
    rows.forEach((row, i) => {
      groupRank.set(row.c.id, { rank: i + 1, total: rows.length, label: GROUP_LABEL[g.key] });
    });
    flattened.push(...rows);
  }

  flattened.forEach((row, i) => {
    const gr = groupRank.get(row.c.id);
    const standing: PoolStanding = {
      overallRank: i + 1,
      activeTotal,
      groupRank: gr?.rank ?? 0,
      groupTotal: gr?.total ?? 0,
      groupLabel: gr?.label ?? "",
    };
    row.c.standing = standing;
  });
}

/** Ordinal helper: 1 → "1st", 2 → "2nd", 11 → "11th". */
export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

/** Short human standing label, e.g. "3rd of 12 interview-ready". Empty when unranked. */
export function standingLabel(standing: PoolStanding | undefined): string {
  if (!standing || !standing.groupTotal) return "";
  return `${ordinal(standing.groupRank)} of ${standing.groupTotal} ${standing.groupLabel}`;
}
