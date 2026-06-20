import { POOL_GROUPS, poolGroupOf, fitWeight } from "./app-theme";
import type { Candidate, Decision, PoolStanding } from "./types";

// Human label for each decision group's standing copy ("3rd of 12 interview-ready").
const GROUP_LABEL: Record<Decision, string> = {
  interview: "interview-ready",
  verify: "to verify",
  short: "to short-screen",
  hold: "in the hold group",
  cut: "in the hold group",
  blocked: "in the hold group",
};

/** Coarse within-group fit signal — mirrors the pool board's fit sort. */
function fit(c: Candidate): number {
  return fitWeight(c.answersRead.level) + fitWeight(c.specRead.level);
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
      .sort((a, b) => fit(b.c) - fit(a.c) || a.index - b.index);
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
