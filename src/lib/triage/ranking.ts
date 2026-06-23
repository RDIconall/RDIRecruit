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
 * Ordering signal within a group. The interview list is worked top-down, so it is
 * ordered by the strength-vs-salary value read first, then by raw fit; the other
 * groups fall back to fit alone.
 */
function rankWeight(c: Candidate): number {
  const value = c.value ? valueWeight(c.value.level) * 10 : 0;
  return value + fitWeight(c.answersRead.level) + fitWeight(c.specRead.level);
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
