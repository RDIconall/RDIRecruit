// Maps the live Supabase candidate shapes (board rows + evaluations + narrative)
// into the triage view model in ./types. Faithful to whatever the DB holds;
// where a field doesn't exist it degrades gracefully rather than fabricating.
//
// HARD RULE: the triage UI speaks decision vocabulary only. Numeric scores and
// tiers from the `scores` table are used here ONLY to derive a Decision; they
// are never surfaced in any field that reaches the screen.

import type {
  AnswerGradePayload,
  CandidateOverlayRow,
  CandidateRow,
  DigInPayload,
  EvidenceRow,
  InvestPayload,
  NarrativeSegment,
  RoAssessmentRow,
  RoleReadPayload,
  ScoreRow,
  VerificationPayload,
} from "../types";
import { wbCandidate } from "../workable/links";
import type {
  AnswerRow,
  Candidate,
  CoverLine,
  CutGroup,
  Decision,
  DecisionRead,
  FirefliesRecording,
  Logistics,
  LogisticsSignal,
  RedFlag,
  TimelineRow,
  TimelineSignal,
} from "./types";

export interface CandidateEvaluations {
  invest: InvestPayload | null;
  dig: DigInPayload | null;
  verification: VerificationPayload | null;
  roleReads: RoleReadPayload[];
  answerGrades: AnswerGradePayload[];
}

export interface ApplicationLite {
  answers: Record<string, unknown> | null;
  cover_letter: string | null;
}

export interface MapInput {
  candidate: CandidateRow;
  score: ScoreRow | null;
  ro: RoAssessmentRow | null;
  overlay: CandidateOverlayRow | null;
  application: ApplicationLite | null;
  narrative: NarrativeSegment[];
  evals: CandidateEvaluations;
  interviewEvidence: EvidenceRow[];
  read: DecisionRead | null;
  rank: number;
  jobLocation: string;
  jobShortcode: string;
}

function workableUrlFor(candidate: CandidateRow, jobShortcode: string): string {
  const raw = candidate.raw;
  const profileUrl =
    raw && typeof raw === "object" ? (raw as { profile_url?: unknown }).profile_url : undefined;
  if (typeof profileUrl === "string" && profileUrl.startsWith("http")) return profileUrl;
  return wbCandidate(jobShortcode, candidate.workable_id);
}

const JOB_BASE = "Van Nuys, CA";

function humanCut(input: MapInput): boolean {
  return input.overlay?.status === "disqualified" || Boolean(input.candidate.disqualified);
}

function hasDiscrepancy(v: VerificationPayload | null): boolean {
  if (!v) return false;
  const read = (v.read ?? "").toLowerCase();
  if (read.includes("discrepancy") || read.includes("material")) return true;
  return (v.claims ?? []).some((c) => (c.verdict ?? "").toUpperCase() === "DISCREPANCY");
}

/**
 * Derive the decision-vocabulary call. The numeric `total`/bands stay internal —
 * they pick the bucket but never reach the UI. Verdict bands mirror the evaluator:
 * 85+ ADVANCE · 70-84 CONSIDER · 55-69 HOLD · <55 DENY, with integrity/verification
 * gates layered on top.
 */
export function deriveDecision(input: MapInput): Decision {
  if (input.read?.decision) return input.read.decision;

  const { score, evals } = input;
  if (!evals.invest || !score) return "blocked";

  if (humanCut(input)) return "cut";

  const integrity = (evals.dig?.integrity ?? "").toLowerCase();
  if (integrity.startsWith("material")) return "cut";

  const total = score.total ?? 0;
  if (total < 55) return "cut";

  if (hasDiscrepancy(evals.verification)) return "verify";

  const salaryUnstated = !evals.invest.ask || (score.salary_value ?? "") === "unstated";
  if (salaryUnstated && total < 82) return "verify";

  if (total >= 82) return "interview";
  if (total >= 68) return "short";
  return "hold";
}

function nextFor(decision: Decision): string {
  return {
    interview: "Screen",
    short: "Short screen",
    verify: "Verify",
    hold: "Hold",
    cut: "Reject",
    blocked: "Re-sync",
  }[decision];
}

function askTierFor(salaryValue: string | null): Candidate["askTier"] {
  switch (salaryValue) {
    case "great value":
      return "below";
    case "justified":
      return "value";
    case "rich for fit":
      return "high";
    case "poor value":
      return "top";
    default:
      return "mid";
  }
}

const TRAJECTORY_LABEL: Record<string, string> = {
  "grows-the-role": "Grows the role under an RO-5",
  "bends-away": "Bends away from the role",
  plateaued: "Plateaued at current level",
  regressed: "Regressed",
};

function parseSalaryNum(ask: string | null | undefined): number {
  if (!ask) return 0;
  const digits = ask.replace(/[^0-9.]/g, "");
  if (!digits) return 0;
  const n = parseFloat(digits);
  if (!Number.isFinite(n)) return 0;
  return n >= 1000 ? Math.round(n / 1000) : Math.round(n);
}

function firstSentence(text: string | null | undefined): string {
  if (!text) return "";
  const trimmed = text.trim();
  const m = trimmed.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : trimmed).trim();
}

function truncate(text: string, max = 220): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
}

// "Clinical Data Manager at Synergen Bio" → { role, org }
function splitRoleAt(text: string): { role: string; org: string } {
  const idx = text.lastIndexOf(" at ");
  if (idx === -1) return { role: text.trim(), org: "" };
  return { role: text.slice(0, idx).trim(), org: text.slice(idx + 4).trim() };
}

function tenureFromSpan(span: string): string {
  // spans look like "2020-06 – 2023-12" or "2020 – 2024"; degrade to "—".
  const years = span.match(/(\d{4})/g);
  if (!years || years.length < 2) return "—";
  const a = Number(years[0]);
  const b = Number(years[years.length - 1]);
  if (!a || !b || b < a) return "—";
  const months = span.match(/\d{4}-(\d{2})/g);
  let yrs = b - a;
  if (months && months.length >= 2) {
    const m1 = Number(span.match(/\d{4}-(\d{2})/)?.[1] ?? 1);
    const lastMonthMatch = [...span.matchAll(/\d{4}-(\d{2})/g)].pop();
    const m2 = Number(lastMonthMatch?.[1] ?? 1);
    yrs = (b * 12 + m2 - (a * 12 + m1)) / 12;
  }
  if (yrs <= 0) return "—";
  return `${yrs.toFixed(1)} yrs`;
}

function timelineFromNarrative(
  segments: NarrativeSegment[],
  roleReads: RoleReadPayload[],
): TimelineRow[] {
  if (!segments.length) {
    return [
      {
        type: "role",
        period: "—",
        org: "—",
        role: "Materials not parsed",
        tenure: "—",
        scope: "No résumé narrative on file — re-sync from Workable.",
        lang: "—",
        signal: "Ask",
      },
    ];
  }

  return segments.map((seg) => {
    const { role, org } = splitRoleAt(seg.text);
    const type =
      seg.type === "education"
        ? "edu"
        : seg.type === "gap"
          ? "gap"
          : "role";

    if (type === "gap") {
      return {
        type: "gap",
        period: seg.span,
        org: "—",
        role: "Gap",
        tenure: tenureFromSpan(seg.span),
        scope: seg.text.replace(/^\[|\]$/g, ""),
        lang: "—",
        signal: "Gap" as TimelineSignal,
      };
    }

    if (type === "edu") {
      return {
        type: "edu",
        period: seg.span === "unknown" ? "—" : seg.span,
        org: org || seg.text,
        role: role || "Education",
        tenure: "—",
        scope: "Academic background",
        lang: "—",
        signal: "Connected" as TimelineSignal,
      };
    }

    // role — enrich with the matching role_read where companies line up.
    const match = roleReads.find(
      (r) => org && r.company && r.company.toLowerCase().includes(org.toLowerCase().slice(0, 8)),
    );
    return {
      type: "role",
      period: seg.span === "unknown" ? "—" : seg.span,
      org: org || "—",
      role: role || match?.role || "Role",
      tenure: tenureFromSpan(seg.span),
      scope: match?.read ? truncate(match.read, 180) : "—",
      lang: match?.level ? `Reads ${match.level}` : "—",
      signal: "Positive" as TimelineSignal,
    };
  });
}

function coverFromApplication(coverLetter: string | null): Candidate["cover"] {
  const text = coverLetter?.trim();
  if (!text) return { hasLetter: false, lines: [] };
  const paras = text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const lines: CoverLine[] = (paras.length ? paras : [text]).map((p) => ({
    t: p,
    kind: "neutral",
  }));
  return { hasLetter: true, lines };
}

function answersFrom(
  grades: AnswerGradePayload[],
  application: ApplicationLite | null,
): AnswerRow[] {
  if (grades.length) {
    return grades.map((g) => ({
      q: g.question || "Application answer",
      a: g.answer || "—",
      comment: g.note || undefined,
      kind:
        (g.verdict ?? "").toUpperCase() === "OWNED"
          ? "good"
          : (g.verdict ?? "").toUpperCase() === "EVASIVE"
            ? "flag"
            : "thin",
    }));
  }
  const raw = application?.answers;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return Object.entries(raw as Record<string, unknown>)
      .filter(([, v]) => typeof v === "string" && (v as string).trim())
      .map(([q, v]) => ({ q, a: String(v), kind: "neutral" as const }));
  }
  return [];
}

function likelihoodFrom(location: string): Logistics["likelihood"] {
  const loc = location.toLowerCase();
  if (!loc || loc === "—") return "—";
  if (/(\bca\b|california)/.test(loc)) return "High";
  if (/(united states|usa|u\.s\.|, [a-z]{2}$)/.test(loc) || /\b(tx|ny|nj|wa|fl|az|il|ma|pa)\b/.test(loc))
    return "Medium";
  return "Low";
}

function logisticsFrom(input: MapInput, location: string): Logistics {
  const likelihood = likelihoodFrom(location);
  const localClaims = (input.evals.verification?.claims ?? []).filter(
    (c) => (c.category ?? "").toLowerCase() === "local",
  );
  const signals: LogisticsSignal[] = localClaims.map((c) => ({
    mark: (c.verdict ?? "").toUpperCase() === "CONFIRMED" ? "+" : "–",
    t: c.note || c.application || "",
  }));

  let read: string;
  if (likelihood === "High") read = `${location} reads as in or near California — the ${JOB_BASE} on-site ask is realistic. Confirm exact commute.`;
  else if (likelihood === "Medium") read = `${location} is US-based but outside California — confirm relocation intent before a ${JOB_BASE} on-site slot.`;
  else if (likelihood === "Low") read = `${location} is outside the US / region on file — relocation and work-authorization are open questions for a ${JOB_BASE} role.`;
  else read = "Location not stated — confirm where the candidate is based before assessing the on-site ask.";

  return {
    mode: `Role based in ${JOB_BASE}`,
    location: location || "—",
    distance: "—",
    likelihood,
    read,
    signals,
  };
}

function firefliesFrom(evidence: EvidenceRow[]): FirefliesRecording[] {
  return evidence
    .filter((e) => e.transcript && e.transcript.trim())
    .map((e) => ({
      title: e.label || e.source_type || "Interview recording",
      date: e.captured_at ? new Date(e.captured_at).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "—",
      dur: "—",
      transcript: e.transcript as string,
    }));
}

function redFlagsFrom(input: MapInput): RedFlag[] {
  const flags: RedFlag[] = [];
  const integrity = (input.evals.dig?.integrity ?? "").toLowerCase();
  if (integrity.startsWith("material") && input.evals.dig?.integrityNote) {
    flags.push({ flag: "Integrity", detail: input.evals.dig.integrityNote, source: "Application" });
  }
  for (const c of input.evals.verification?.claims ?? []) {
    if ((c.verdict ?? "").toUpperCase() === "DISCREPANCY") {
      flags.push({
        flag: c.category ? `${c.category} discrepancy` : "Discrepancy",
        detail: c.note || `${c.application} vs ${c.profile}`,
        source: "Verification",
      });
    }
  }
  return flags;
}

function cutFieldsFor(input: MapInput): Pick<Candidate, "cutGroup" | "cutReason" | "cite" | "cutMatters"> {
  const dig = input.evals.dig;
  const integrity = (dig?.integrity ?? "").toLowerCase();
  const gapCount = input.narrative.filter((s) => s.type === "gap").length;
  const roleCount = input.narrative.filter((s) => s.type === "role").length;
  const hasCover = Boolean(input.application?.cover_letter?.trim());
  const answerCount = input.evals.answerGrades.length;

  let cutGroup: CutGroup;
  if (integrity.startsWith("material") || hasDiscrepancy(input.evals.verification)) cutGroup = "evidence";
  else if (gapCount >= 2 || (roleCount >= 4 && gapCount >= 1)) cutGroup = "pattern";
  else if (!hasCover && answerCount === 0) cutGroup = "care";
  else cutGroup = "mismatch";

  const cutReason =
    input.overlay?.status_reason ||
    dig?.careerRead ||
    dig?.resolve?.[0] ||
    firstSentence(input.evals.invest?.summary) ||
    "Below the bar for this seat against the rubric.";

  return {
    cutGroup,
    cutReason: truncate(cutReason, 200),
    cite: "Materials",
    cutMatters: dig?.integrityNote ? truncate(dig.integrityNote, 200) : truncate(input.evals.dig?.careerRead ?? "Does not remove the burden this seat exists to cover.", 200),
  };
}

export function mapCandidate(input: MapInput): Candidate {
  const decision = deriveDecision(input);
  const invest = input.evals.invest;
  const dig = input.evals.dig;
  const ro = input.ro;

  // current role/company from the most recent role_read or narrative role.
  const lastRoleRead = input.evals.roleReads[input.evals.roleReads.length - 1] ?? null;
  const roleTitle = lastRoleRead?.role || ro?.per_role?.[ro.per_role.length - 1]?.role || "Candidate";
  const company = lastRoleRead?.company || ro?.per_role?.[ro.per_role.length - 1]?.company || "—";

  const salary = invest?.ask || "—";
  const why =
    input.read?.why ||
    dig?.careerRead ||
    firstSentence(invest?.summary) ||
    "Read derived from submitted materials.";

  const integrity = (dig?.integrity ?? "").toLowerCase();
  const riskBase =
    integrity !== "clear" && integrity !== "" && dig?.integrityNote
      ? dig.integrityNote
      : dig?.resolve?.[0] || input.evals.verification?.read || "No decisive risk surfaced.";
  const risk = input.read?.risk || truncate(riskBase, 220);

  const salaryValue = input.score?.salary_value ?? null;
  const askTier = askTierFor(salaryValue);
  const mismatch =
    salaryValue === "rich for fit" || salaryValue === "poor value" || hasDiscrepancy(input.evals.verification);

  const location = input.candidate.location || ((input.candidate.raw?.address as string) ?? "") || "—";

  const baseRedFlags = input.read?.flags ?? redFlagsFrom(input);

  const candidate: Candidate = {
    id: input.candidate.workable_id,
    rank: input.rank,
    name: input.candidate.name || "Unnamed candidate",
    role: roleTitle,
    company,
    salary,
    salaryNum: parseSalaryNum(invest?.ask),
    decision,
    rev: "none",
    revNote: "No human review yet — read synced from submitted materials.",
    why: truncate(why, 240),
    flag: risk,
    next: input.read?.next || nextFor(decision),
    survivor: decision === "interview" || decision === "short",

    askTier,
    askNote: invest?.vector ? truncate(invest.vector, 90) : salaryValue ?? "ask unstated",
    roLevel: ro?.current_capability || ro?.seat_stratum || "—",
    roVsPool: ro?.trajectory ? TRAJECTORY_LABEL[ro.trajectory] ?? ro.trajectory : "—",
    mismatch,
    mismatchLabel:
      decision === "blocked"
        ? "Review blocked"
        : hasDiscrepancy(input.evals.verification)
          ? "Contradiction"
          : salaryValue === "rich for fit" || salaryValue === "poor value"
            ? "Ask / level mismatch"
            : undefined,
    mismatchRead:
      invest?.vector ||
      (decision === "blocked"
        ? "Materials incomplete — no read possible until re-sync."
        : "Ask and level line up for this seat."),

    timeline: timelineFromNarrative(input.narrative, input.evals.roleReads),
    cover: coverFromApplication(input.application?.cover_letter ?? null),
    answers: answersFrom(input.evals.answerGrades, input.application),
    logistics: logisticsFrom(input, location),
    fireflies: firefliesFrom(input.interviewEvidence),
    redFlags: baseRedFlags,
    workableUrl: workableUrlFor(input.candidate, input.jobShortcode),
  };

  if (decision === "cut") {
    Object.assign(candidate, cutFieldsFor(input));
  }

  if (input.read?.timelineNote) {
    candidate.revNote = `Re-analyzed by Claude. ${input.read.timelineNote}`;
  }

  return candidate;
}
