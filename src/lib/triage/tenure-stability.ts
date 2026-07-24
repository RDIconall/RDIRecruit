/**
 * Deterministic résumé tenure / hopping signals.
 * Soft LLM "tenure" category scores are not enough — short stints must gate triage.
 */

import type { Decision } from "./types";

export type TenureRole = {
  title?: string | null;
  company?: string | null;
  start?: string | null;
  end?: string | null;
  current?: boolean | null;
};

export type TenureSeverity = "none" | "mild" | "pattern" | "severe";

export type TenureStability = {
  severity: TenureSeverity;
  /** Completed roles under SHORT_MONTHS (current role excluded if still open). */
  shortCompletedCount: number;
  /** Roles (incl. current) with measurable tenure ≥ ANCHOR_MONTHS. */
  longAnchorCount: number;
  /** Measurable completed roles considered. */
  completedRoleCount: number;
  shortRoles: Array<{ title: string; company: string; months: number }>;
  /** One-line recruiter caveat when severity ≠ none. */
  caveat: string | null;
  /** Red-flag detail when pattern/severe. */
  flagDetail: string | null;
};

export const SHORT_TENURE_MONTHS = 18;
export const LONG_ANCHOR_MONTHS = 36;

const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

/** Parse a loose résumé date into year+month. Returns null if unparseable. */
export function parseResumeDate(value: string | null | undefined): { y: number; m: number } | null {
  if (!value) return null;
  const t = value.trim();
  if (!t || /present|current|now|ongoing/i.test(t)) return null;

  const iso = t.match(/\b((?:19|20)\d{2})[-/.](\d{1,2})\b/);
  if (iso) {
    const y = Number(iso[1]);
    const m = Math.max(0, Math.min(11, Number(iso[2]) - 1));
    return { y, m };
  }

  const my = t.match(/\b([A-Za-z]{3,9})\.?\s+((?:19|20)\d{2})\b/);
  if (my) {
    const mi = MONTHS[my[1].toLowerCase()];
    if (mi != null) return { y: Number(my[2]), m: mi };
  }

  const ym = t.match(/\b((?:19|20)\d{2})\s+([A-Za-z]{3,9})\.?\b/);
  if (ym) {
    const mi = MONTHS[ym[2].toLowerCase()];
    if (mi != null) return { y: Number(ym[1]), m: mi };
  }

  const yOnly = t.match(/\b((?:19|20)\d{2})\b/);
  if (yOnly) return { y: Number(yOnly[1]), m: 5 };

  return null;
}

function monthsBetween(start: { y: number; m: number }, end: { y: number; m: number }): number {
  return Math.max(0, (end.y - start.y) * 12 + (end.m - start.m));
}

function isCurrent(role: TenureRole): boolean {
  if (role.current) return true;
  const end = (role.end ?? "").trim();
  return !end || /present|current|now|ongoing/i.test(end);
}

/** Tenure in whole months for one role, or null if dates insufficient. */
export function roleTenureMonths(role: TenureRole, now = new Date()): number | null {
  const start = parseResumeDate(role.start ?? undefined);
  if (!start) return null;
  const end = isCurrent(role)
    ? { y: now.getFullYear(), m: now.getMonth() }
    : parseResumeDate(role.end ?? undefined);
  if (!end) return null;
  return monthsBetween(start, end);
}

/**
 * Parse a narrative / résumé period string ("2020-06 – 2023-12", "Jan 2021 – Present")
 * into a TenureRole date pair. Returns null when no start year is found.
 */
export function roleFromPeriodSpan(
  title: string,
  company: string,
  span: string | null | undefined,
): TenureRole | null {
  if (!span || span === "—" || span === "unknown") return null;
  // Split on en/em dash or " to " — never on bare "-", which appears inside ISO dates.
  const parts = span.split(/\s*[–—]\s*|\s+-\s+|\s+to\s+/i).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const startRaw = parts[0]!;
  const endRaw = parts.length > 1 ? parts[parts.length - 1]! : "";
  const start = parseResumeDate(startRaw);
  if (!start) return null;
  const current = !endRaw || /present|current|now|ongoing/i.test(endRaw);
  return {
    title,
    company,
    start: startRaw,
    end: current ? null : endRaw,
    current,
  };
}

/** Prefer structured experience; fall back to narrative role spans when dates are missing. */
export function coalesceTenureRoles(
  parsed: TenureRole[] | null | undefined,
  narrativeRoles?: Array<{ title?: string; company?: string; span?: string | null }> | null,
): TenureRole[] {
  const fromParsed = (parsed ?? []).filter((r) => r && (r.title || r.company || r.start));
  const dated = fromParsed.filter((r) => roleTenureMonths(r) != null);
  if (dated.length >= 2) return fromParsed;
  if (dated.length === 1 && !narrativeRoles?.length) return fromParsed;

  const fromNarrative: TenureRole[] = [];
  for (const n of narrativeRoles ?? []) {
    const role = roleFromPeriodSpan(n.title || "Role", n.company || "—", n.span);
    if (role) fromNarrative.push(role);
  }
  const narrativeDated = fromNarrative.filter((r) => roleTenureMonths(r) != null);
  if (narrativeDated.length > dated.length) return fromNarrative;
  return fromParsed.length ? fromParsed : fromNarrative;
}

/**
 * Analyze hopping / short-stint pattern from parsed résumé roles.
 *
 * - Current (open-ended) roles are not counted as "short completed".
 * - Completed roles under 18 months count as short stints.
 * - A long anchor (≥36 months) softens severity from severe → pattern when only 2 shorts.
 */
export function analyzeTenureStability(
  roles: TenureRole[] | null | undefined,
  now = new Date(),
): TenureStability {
  const empty: TenureStability = {
    severity: "none",
    shortCompletedCount: 0,
    longAnchorCount: 0,
    completedRoleCount: 0,
    shortRoles: [],
    caveat: null,
    flagDetail: null,
  };
  if (!roles?.length) return empty;

  const shortRoles: TenureStability["shortRoles"] = [];
  let completedRoleCount = 0;
  let longAnchorCount = 0;

  for (const role of roles) {
    if (!role.title && !role.company && !role.start) continue;
    const months = roleTenureMonths(role, now);
    if (months == null) continue;

    if (months >= LONG_ANCHOR_MONTHS) longAnchorCount++;

    if (isCurrent(role)) continue;

    completedRoleCount++;
    if (months > 0 && months < SHORT_TENURE_MONTHS) {
      shortRoles.push({
        title: (role.title || "Role").trim(),
        company: (role.company || "—").trim(),
        months,
      });
    }
  }

  const shortCompletedCount = shortRoles.length;
  let severity: TenureSeverity = "none";
  if (shortCompletedCount >= 3 || (shortCompletedCount >= 2 && longAnchorCount === 0)) {
    severity = "severe";
  } else if (shortCompletedCount >= 2) {
    severity = "pattern";
  } else if (shortCompletedCount === 1) {
    severity = "mild";
  }

  if (severity === "none") {
    return { ...empty, shortCompletedCount, longAnchorCount, completedRoleCount };
  }

  const examples = shortRoles
    .slice(0, 3)
    .map((r) => `${r.title} @ ${r.company} (${r.months} mo)`)
    .join("; ");

  const caveat =
    severity === "mild"
      ? `Confirm why they left after a short stint: ${examples}.`
      : `Short-tenure pattern — confirm join/leave reasons before interviewing: ${examples}.`;

  const flagDetail =
    severity === "mild"
      ? null
      : `${shortCompletedCount} completed role${shortCompletedCount === 1 ? "" : "s"} under ${SHORT_TENURE_MONTHS} months` +
        (longAnchorCount === 0 ? "; no multi-year anchor on file" : "") +
        `. ${examples}`;

  return {
    severity,
    shortCompletedCount,
    longAnchorCount,
    completedRoleCount,
    shortRoles,
    caveat,
    flagDetail,
  };
}

/**
 * Apply tenure gate to a derived decision.
 * Human overrides stay with the caller. Pattern/severe cannot remain Interview.
 */
export function applyTenureDecisionGate(
  decision: Decision,
  stability: TenureStability,
): Decision {
  if (decision === "blocked" || decision === "reject") return decision;
  if (stability.severity === "none" || stability.severity === "mild") return decision;
  if (decision === "interview") return "backup";
  return decision;
}

/**
 * Cap the soft LLM "tenure" category points once a hopping pattern is visible.
 * Pattern/severe must not keep near-max tenure points that inflate the total.
 */
export function capTenureCategoryScore(
  rawTenure: number,
  maxWeight: number,
  stability: TenureStability,
): number {
  const base = Math.max(0, Math.min(maxWeight, Math.round(rawTenure)));
  if (maxWeight <= 0) return 0;
  if (stability.severity === "severe") return Math.min(base, Math.round(maxWeight * 0.2));
  if (stability.severity === "pattern") return Math.min(base, Math.round(maxWeight * 0.4));
  if (stability.severity === "mild") return Math.min(base, Math.round(maxWeight * 0.7));
  return base;
}
