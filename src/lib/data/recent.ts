import type { BoardCandidate } from "../types";

/** How far back the cross-role inbox looks by default. */
export const RECENT_WINDOW_DAYS = 30;

/** Floor so a quiet pool still shows something instead of an empty inbox. */
export const RECENT_MINIMUM = 25;

function appliedAtMs(item: BoardCandidate): number {
  const t = Date.parse(item.candidate.created_at ?? "");
  return Number.isFinite(t) ? t : -Infinity;
}

/**
 * The cross-role view is the "new across roles" inbox, so it must be scoped to
 * recent applications. Without this it loaded the entire historical pool of
 * every published job, and old high-scoring candidates held the top of the list
 * permanently — new applicants were technically present but never visible.
 *
 * Ranking inside the returned set is unchanged (job match, then problem
 * complexity); this only decides who is in the inbox at all.
 */
export function selectRecentApplicants(
  board: BoardCandidate[],
  options?: { now?: Date; days?: number; minimum?: number },
): BoardCandidate[] {
  const now = options?.now ?? new Date();
  const days = options?.days ?? RECENT_WINDOW_DAYS;
  const minimum = options?.minimum ?? RECENT_MINIMUM;
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;

  const byRecency = [...board].sort((a, b) => appliedAtMs(b) - appliedAtMs(a));
  const inWindow = byRecency.filter((item) => appliedAtMs(item) >= cutoff);
  if (inWindow.length >= minimum) return inWindow;

  // Top up with the next most recent applications, skipping undated rows so a
  // row with no timestamp never displaces a real application.
  const dated = byRecency.filter((item) => appliedAtMs(item) > -Infinity);
  return dated.slice(0, Math.max(minimum, inWindow.length));
}
