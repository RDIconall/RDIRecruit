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
import { reviewerSignalFor } from "./reviewer";
import { askNumK, cityState } from "./format";
import { avatarColor, DECISION_NEXT, fitWeight, initialsOf } from "./app-theme";
import { normalizeDecision, normalizeProcessStatus } from "./types";
import { summarizeAnswerGrades } from "./answer-grades";
import {
  ADVANCE_BAND_MIN,
  applyInterviewBar,
  assessInterviewBar,
  CONSIDER_BAND_MIN,
  type InterviewBar,
} from "./interview-bar";
import {
  analyzeTenureStability,
  applyTenureDecisionGate,
  coalesceTenureRoles,
  type TenureStability,
} from "./tenure-stability";
import type {
  AnswerRow,
  Candidate,
  CareerProgression,
  CareerRead,
  CareerStep,
  CorrectionEntry,
  CoverLine,
  CutGroup,
  Decision,
  DecisionRead,
  InterviewGate,
  ProcessStatus,
  FirefliesRecording,
  Logistics,
  LogisticsSignal,
  RedFlag,
  ResumeRole,
  ResumeView,
  ReviewerSignal,
  TimelineRow,
  TimelineSignal,
  ValueRead,
  VerdictRead,
} from "./types";

export interface CandidateEvaluations {
  invest: InvestPayload | null;
  dig: DigInPayload | null;
  verification: VerificationPayload | null;
  roleReads: RoleReadPayload[];
  answerGrades: AnswerGradePayload[];
}

// One résumé experience entry as stored in applications.parsed_experience.
export interface ParsedExperienceEntry {
  title?: string | null;
  company?: string | null;
  start?: string | null;
  end?: string | null;
  current?: boolean | null;
  summary?: string | null;
}

export interface ApplicationLite {
  answers: Record<string, unknown> | null;
  cover_letter: string | null;
  parsed_experience?: ParsedExperienceEntry[] | null;
  resume_text?: string | null;
  resume_url?: string | null;
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
  /** Persisted human corrections (with optional reviewer identity) — drives rev/revNote (#7). */
  corrections?: CorrectionEntry[];
  /** Manual decision set by a human reviewer; wins over the model read. */
  decisionOverride?: Decision | null;
  /** Our post-decision process status (Sent to Lara, Interviewing, …); persisted in the working file. */
  processStatus?: ProcessStatus | null;
  rank: number;
  jobLocation: string;
  jobShortcode: string;
  /** Published job title — for cross-role views. */
  jobTitle?: string;
}

/**
 * The candidate's Workable profile photo. Prefers the durable `photo_url` column
 * (which the bulk mirror can't wipe), falling back to `raw.image_url` for rows
 * synced before the column existed.
 */
function photoUrlFor(candidate: CandidateRow): string | undefined {
  const column = candidate.photo_url;
  if (typeof column === "string" && column.startsWith("http")) return column;
  const raw = candidate.raw;
  if (!raw || typeof raw !== "object") return undefined;
  const img = (raw as { image_url?: unknown; image?: unknown }).image_url ?? (raw as { image?: unknown }).image;
  if (typeof img === "string" && img.startsWith("http")) return img;
  return undefined;
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
  return (
    input.overlay?.status === "disqualified" ||
    input.overlay?.status === "withdrawn" ||
    Boolean(input.candidate.disqualified)
  );
}

function hasDiscrepancy(v: VerificationPayload | null): boolean {
  if (!v) return false;
  const read = (v.read ?? "").toLowerCase();
  if (read.includes("discrepancy") || read.includes("material")) return true;
  return (v.claims ?? []).some((c) => (c.verdict ?? "").toUpperCase() === "DISCREPANCY");
}

/**
 * The call before the deterministic gates: a stored model read when there is
 * one, otherwise derived from the cached evaluation. The numeric `total`/bands
 * stay internal — they pick the bucket but never reach the UI. Verdict bands
 * mirror the evaluator: 85+ ADVANCE · 70-84 CONSIDER · 55-69 HOLD · <55 DENY,
 * with integrity/verification gates layered on top.
 */
function ungatedDecision(input: MapInput): Decision {
  if (input.read?.decision) return normalizeDecision(input.read.decision);

  const { score, evals } = input;
  if (!evals.invest || !score) return "blocked";

  const integrity = (evals.dig?.integrity ?? "").toLowerCase();
  if (integrity.startsWith("material")) return "reject";

  const total = score.total ?? 0;
  if (total < 55) return "reject";

  // A discrepancy or an unstated salary no longer earns its own status — the
  // candidate is held as a backup with the thing-to-confirm surfaced as a caveat.
  if (hasDiscrepancy(evals.verification)) return "backup";

  const salaryUnstated = !evals.invest.ask || (score.salary_value ?? "") === "unstated";
  if (salaryUnstated && total < 82) return "backup";
  // The borderline (HOLD) band is NOT interview-ready — only a file that holds
  // the level for the seat goes on the list a human works top-down.
  if (total >= CONSIDER_BAND_MIN) return "interview";
  return "backup";
}

export interface DecisionDerivation {
  /** The call the board shows. */
  decision: Decision;
  /** The call before the deterministic tenure / interview-bar gates. */
  ungated: Decision;
  tenure: TenureStability;
  bar: InterviewBar;
  /** True when a gate pulled an Interview call down to Backup. */
  demoted: boolean;
  /** The sentence naming why ("" when nothing was demoted). */
  demotionNote: string;
}

/**
 * Derive the decision-vocabulary call together with the deterministic gates that
 * shaped it, so the mapper can say in the candidate's own copy why a file that
 * "looked like" an interview is being held as a backup instead.
 */
export function deriveDecisionDetail(input: MapInput): DecisionDerivation {
  const tenure = tenureStabilityFor(input);
  const bar = interviewBarFor(input);
  const settled = (decision: Decision): DecisionDerivation => ({
    decision,
    ungated: decision,
    tenure,
    bar,
    demoted: false,
    demotionNote: "",
  });

  // A human's manual status wins over everything else — the model read and both
  // gates. Legacy/stored values normalize to the current four-action vocabulary.
  if (input.decisionOverride) return settled(normalizeDecision(input.decisionOverride));

  // A cut (disqualified in Workable / overlay, or a record retired because it was
  // deleted at the source) is terminal: it outranks any stored read — including a
  // stale "blocked" read — and a cut candidate is NEVER surfaced as "Review blocked".
  if (humanCut(input)) return settled("reject");

  const ungated = ungatedDecision(input);
  // Hopping gate first (repeated short completed stints), then the interview bar
  // (borderline evidence / answers that own nothing). Neither can be overridden
  // by a model read: both are properties of the file, not of the read.
  const decision = applyInterviewBar(applyTenureDecisionGate(ungated, tenure), bar);
  const demoted = ungated === "interview" && decision !== "interview";

  return {
    decision,
    ungated,
    tenure,
    bar,
    demoted,
    demotionNote: demoted ? demotionNoteFor(tenure, bar) : "",
  };
}

export function deriveDecision(input: MapInput): Decision {
  return deriveDecisionDetail(input).decision;
}

/** The one sentence a recruiter needs for why an Interview call was held back. */
function demotionNoteFor(tenure: TenureStability, bar: InterviewBar): string {
  if (tenure.severity === "pattern" || tenure.severity === "severe") {
    return "Short-tenure pattern on the résumé — held as backup until the leave reasons are clear.";
  }
  return bar.reason ?? "";
}

function interviewBarFor(input: MapInput): InterviewBar {
  return assessInterviewBar({
    total: input.score?.total ?? null,
    answersLevel: summarizeAnswerGrades(input.evals.answerGrades).level,
    refusedToAnswer: refusedToAnswerFrom(input.application, input.evals.answerGrades),
    hasLiveEvidence: input.interviewEvidence.some((e) => (e.transcript ?? "").trim().length > 0),
  });
}

/**
 * The gate as carried to the client on the mapped candidate: what the gates would
 * do to an Interview call on this file, whatever the current decision is.
 */
function interviewGateFrom(derived: DecisionDerivation): InterviewGate {
  const clears =
    applyInterviewBar(applyTenureDecisionGate("interview", derived.tenure), derived.bar) === "interview";
  return clears
    ? { clears: true, note: "" }
    : { clears: false, note: demotionNoteFor(derived.tenure, derived.bar) };
}

function narrativeRolesForTenure(input: MapInput) {
  return input.narrative
    .filter((s) => s.type === "role")
    .map((s) => {
      const { role, org } = splitRoleAt(s.text);
      return { title: role, company: org, span: s.span };
    });
}

function tenureStabilityFor(input: MapInput): TenureStability {
  const roles = coalesceTenureRoles(
    input.application?.parsed_experience,
    narrativeRolesForTenure(input),
  );
  return analyzeTenureStability(roles);
}

function nextFor(decision: Decision): string {
  return DECISION_NEXT[decision];
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

function stripRoSubletters(value: string | null | undefined): string {
  const text = value?.trim();
  if (!text) return "—";
  const stripped = text.replace(/\b(VII|VI|IV|IX|V|III|II|I)[a-z]\b/gi, (m) =>
    m.replace(/[a-z]$/i, "").toUpperCase(),
  );
  const parts = stripped
    .split(/\s*(?:–|—|-|\/|\bto\b)\s*/i)
    .filter(Boolean);
  if (parts.length > 1 && parts.every((part) => part === parts[0])) return parts[0]!;
  return stripped;
}

function firstSentence(text: string | null | undefined): string {
  if (!text) return "";
  const trimmed = text.trim();
  const m = trimmed.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : trimmed).trim();
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
      scope: match?.read || "—",
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

// Tokens candidates type to skip a question without leaving it blank.
const REFUSAL_TOKENS = new Set([
  "na", "none", "nil", "null", "no answer", "no comment", "idk", "tbd",
  "x", "xx", "xxx", "skip", "see resume", "see cv",
]);

/** True when an answer is a dash / placeholder rather than a real attempt. */
function looksRefused(value: string): boolean {
  const t = value.trim().toLowerCase();
  if (!t) return true;
  // Pure punctuation: "-", "--", ".", "…", "_", "*", "/", "?" and the like.
  if (/^[\s\-–—_.*/\\?!,…]+$/.test(t)) return true;
  const words = t.replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  return REFUSAL_TOKENS.has(words);
}

/**
 * "Refused to answer" — the screening questions were dash-filled or left
 * effectively blank. True when at least half of the answers on file are
 * placeholders; a single skipped question among real answers does NOT flag.
 */
export function refusedToAnswerFrom(
  application: ApplicationLite | null,
  grades: AnswerGradePayload[],
): boolean {
  const values: string[] = [];
  const raw = application?.answers;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const v of Object.values(raw as Record<string, unknown>)) {
      if (typeof v === "string") values.push(v);
    }
  }
  if (!values.length && grades.length) values.push(...grades.map((g) => g.answer ?? ""));
  if (!values.length) return false;
  const refused = values.filter(looksRefused).length;
  return refused >= Math.max(1, Math.ceil(values.length / 2));
}

function verdictOf(raw: string | undefined): AnswerRow["verdict"] | undefined {
  const v = (raw ?? "").toUpperCase();
  if (v === "AI" || v === "OWNED" || v === "SURFACE" || v === "EVASIVE") return v;
  return undefined;
}

function answersFrom(
  grades: AnswerGradePayload[],
  application: ApplicationLite | null,
): AnswerRow[] {
  if (grades.length) {
    return grades.map((g) => {
      const verdict = verdictOf(g.verdict);
      // Only OWNED answers may carry concept chips — SURFACE "procedural logic"
      // lists were inflating weak answers into looking demonstrated.
      const present =
        verdict === "OWNED" && Array.isArray(g.present)
          ? g.present.map((p) => String(p).trim()).filter(Boolean)
          : undefined;
      return {
        q: g.question || "Application answer",
        a: g.answer || "—",
        comment: g.note || undefined,
        present: present?.length ? present : undefined,
        verdict,
        kind:
          verdict === "AI"
            ? ("ai" as const)
            : verdict === "OWNED"
              ? ("good" as const)
              : verdict === "EVASIVE"
                ? ("flag" as const)
                : ("thin" as const),
      };
    });
  }
  const raw = application?.answers;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return Object.entries(raw as Record<string, unknown>)
      .filter(([, v]) => typeof v === "string" && (v as string).trim())
      .map(([q, v]) => ({
        q,
        a: String(v),
        kind: looksRefused(String(v)) ? ("flag" as const) : ("neutral" as const),
        verdict: looksRefused(String(v)) ? ("EVASIVE" as const) : undefined,
      }));
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

function redFlagsFrom(input: MapInput, tenure: TenureStability): RedFlag[] {
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
  appendTenureRedFlags(flags, tenure);
  return flags;
}

function appendTenureRedFlags(flags: RedFlag[], tenure: TenureStability) {
  if (!tenure.flagDetail) return;
  if (flags.some((f) => /short[- ]tenure/i.test(f.flag))) return;
  flags.push({
    flag: tenure.severity === "severe" ? "Short-tenure pattern" : "Short tenures",
    detail: tenure.flagDetail,
    source: "Résumé",
  });
}

function cutFieldsFor(input: MapInput): Pick<Candidate, "cutGroup" | "cutReason" | "cite" | "cutMatters"> {
  const dig = input.evals.dig;
  const integrity = (dig?.integrity ?? "").toLowerCase();
  const materialIntegrity = integrity.startsWith("material");
  const discrepancy = hasDiscrepancy(input.evals.verification);
  const gapCount = input.narrative.filter((s) => s.type === "gap").length;
  const roleCount = input.narrative.filter((s) => s.type === "role").length;
  const hasCover = Boolean(input.application?.cover_letter?.trim());
  const answerCount = input.evals.answerGrades.length;
  const reviewerHardNo = latestReviewerKind(input.corrections) === "lara";

  // #1: a human/overlay disqualification (or a reviewer "hard no") that is NOT a
  // material-integrity / contradiction cut lands in the "human signal" group.
  let cutGroup: CutGroup;
  if (materialIntegrity || discrepancy) cutGroup = "evidence";
  else if (humanCut(input) || reviewerHardNo) cutGroup = "human";
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
    cutReason,
    cite: citeFor(input, { cutGroup, materialIntegrity, discrepancy, hasCover, answerCount }),
    cutMatters: dig?.integrityNote || dig?.careerRead || "Does not remove the burden this seat exists to cover.",
  };
}

/**
 * Where the cut evidence actually comes from, so the cut row / candidate page can
 * cite a real source rather than a static "Materials" label (#2).
 */
function citeFor(
  input: MapInput,
  ctx: { cutGroup: CutGroup; materialIntegrity: boolean; discrepancy: boolean; hasCover: boolean; answerCount: number },
): string {
  if (ctx.discrepancy) return "Verification";
  if (ctx.materialIntegrity) return "Dig-in";
  if (ctx.cutGroup === "human") return input.overlay?.status_reason ? "Overlay" : "Reviewer";
  if (ctx.cutGroup === "pattern") return "Timeline";
  if (ctx.cutGroup === "care") return !ctx.hasCover ? "Cover letter" : "Application";
  if (input.evals.dig?.careerRead) return "Dig-in";
  return "Materials";
}

function yearLabel(date: string | null | undefined): string | null {
  if (!date) return null;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) {
    const m = String(date).match(/\d{4}/);
    return m ? m[0] : null;
  }
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short" });
}

function resumePeriod(entry: ParsedExperienceEntry): string {
  const start = yearLabel(entry.start);
  const end = entry.current ? "Present" : yearLabel(entry.end);
  if (start && end) return `${start} – ${end}`;
  if (start) return `${start} – Present`;
  if (end) return end;
  return "—";
}

function bulletsFromSummary(summary: string | null | undefined): string[] {
  if (!summary) return [];
  return summary
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[*\-•·]\s*/, "").trim())
    .filter(Boolean);
}

function resumeFrom(application: ApplicationLite | null): ResumeView {
  const entries = (application?.parsed_experience ?? []).filter(
    (e): e is ParsedExperienceEntry => Boolean(e && (e.title || e.company || e.summary)),
  );
  const roles: ResumeRole[] = entries.map((e) => ({
    title: (e.title ?? "").trim() || "Role",
    company: (e.company ?? "").trim() || "—",
    period: resumePeriod(e),
    current: Boolean(e.current),
    bullets: bulletsFromSummary(e.summary),
  }));
  const fullText = application?.resume_text?.trim() || undefined;
  const fileUrl = application?.resume_url?.trim() || undefined;
  return {
    hasResume: roles.length > 0 || Boolean(fullText),
    roles,
    fullText,
    fileUrl,
  };
}

const CONFIDENCE_NOTE: Record<string, string> = {
  confirmed: "Read confirmed from the candidate's own reasoning.",
  downgraded: "Résumé over-claimed — read downgraded against tenure and roles.",
  "text-unreliable": "Résumé text reads as unreliable — lean on tenure and references.",
};

// Strongest scope verbs evidencing a role's stratum (highest tier present).
// Live `ro_assessments.per_role[].verbs` rows can be missing a tier key even
// though the type says all three are present, so guard each access.
function strongestVerbs(verbs: RoAssessmentRow["per_role"][number]["verbs"]): string[] {
  const iii = verbs?.III ?? [];
  const ii = verbs?.II ?? [];
  const i = verbs?.I ?? [];
  const tier = iii.length ? iii : ii.length ? ii : i;
  return tier.slice(0, 4);
}

function careerProgressionFrom(ro: RoAssessmentRow | null): CareerProgression | undefined {
  if (!ro) return undefined;
  const steps: CareerStep[] = (ro.per_role ?? []).map((r) => ({
    role: (r.role ?? "").trim() || "Role",
    company: (r.company ?? "").trim() || "—",
    tenure: r.years && r.years > 0 ? `${r.years.toFixed(1)} yrs` : "—",
    stratum: stripRoSubletters(r.stratum),
    stratumRange: stripRoSubletters(r.stratum_range || r.stratum),
    verbs: strongestVerbs(r.verbs ?? { I: [], II: [], III: [] }),
  }));
  if (!steps.length) return undefined;
  return {
    hasData: true,
    steps,
    seatStratum: stripRoSubletters(ro.seat_stratum),
    currentCapability: stripRoSubletters(ro.current_capability || ro.seat_stratum),
    trajectory: ro.trajectory ? TRAJECTORY_LABEL[ro.trajectory] ?? ro.trajectory : "—",
    confidenceNote: ro.text_confidence ? CONFIDENCE_NOTE[ro.text_confidence] ?? "" : "",
    basis: ro.basis ?? "",
  };
}

/** The reviewer kind of the most recent correction that carried a reviewer (#7). */
function latestReviewerKind(corrections: CorrectionEntry[] | undefined): CorrectionEntry["reviewerKind"] | undefined {
  if (!corrections?.length) return undefined;
  for (let i = corrections.length - 1; i >= 0; i--) {
    if (corrections[i].reviewerKind) return corrections[i].reviewerKind;
  }
  return undefined;
}

/**
 * Derive the reviewer-signal lens (rev/revNote) from the latest human correction
 * that named a reviewer (#7). A persisted Claude read.rev wins when present.
 */
function reviewerFrom(
  input: MapInput,
  decision: Decision,
): { rev: ReviewerSignal; revNote: string } | null {
  if (input.read?.rev) {
    return { rev: input.read.rev, revNote: input.read.revNote || input.read.why || "" };
  }
  const corrections = input.corrections ?? [];
  for (let i = corrections.length - 1; i >= 0; i--) {
    const c = corrections[i];
    if (!c.reviewerKind) continue;
    const who = c.reviewerLabel || c.reviewerKind;
    return {
      rev: reviewerSignalFor(c.reviewerKind, decision),
      revNote: `${who}: ${c.text}`,
    };
  }
  return null;
}

/**
 * The "Career read" prose block under the deep-analysis compare strip (#6).
 * Prefers a Claude-filled read.careerRead; otherwise maps from dig_in. Returns
 * undefined when there is no dig_in (degrade gracefully — block is hidden).
 */
function careerReadFrom(input: MapInput, decision: Decision): CareerRead | undefined {
  if (input.read?.careerRead) return input.read.careerRead;
  const dig = input.evals.dig;
  if (!dig) return undefined;
  const integrity = (dig.integrity ?? "").toLowerCase();
  const riskText =
    integrity.startsWith("material") && dig.integrityNote
      ? dig.integrityNote
      : dig.resolve?.[0] || input.evals.verification?.read || "";
  const positive =
    input.evals.invest?.vector?.trim() ||
    input.evals.roleReads[input.evals.roleReads.length - 1]?.read?.trim() ||
    dig.mix?.trim() ||
    "";
  const path = dig.careerRead?.trim() || firstSentence(input.evals.invest?.summary);
  if (!path && !positive && !riskText) return undefined;
  return {
    path: path || "Career path read not yet derived.",
    positive: positive || "No standout positive inference on file yet.",
    risk: riskText || "No decisive risk surfaced from the materials.",
    implication: implicationFor(decision),
  };
}

function implicationFor(decision: Decision): string {
  return {
    interview: "Clears the bar — put them on the interview list.",
    backup: "Competent but not differentiating — hold as a backup behind the interview list.",
    reject: "Does not clear the bar for this seat — do not interview.",
    blocked: "Materials incomplete — re-sync before any read.",
  }[decision];
}

/** Pool-board Answers column — see summarizeAnswerGrades for the strict rules. */
function answersReadFrom(grades: AnswerGradePayload[]): VerdictRead {
  return summarizeAnswerGrades(grades);
}

/**
 * The cached "Vs. spec" read for the pool board — fit against the job rubric/spec.
 * Prefers a Claude-persisted rubricFit verdict; otherwise falls back to the
 * evaluator's own rubric read so the column is never blank for a scored candidate.
 *
 * It must NOT be derived from the decision. Reading "Strong fit" off an Interview
 * call was circular — the decision made the fit look strong, the fit fed the
 * strength-vs-salary read, and that pushed the file to the top of the interview
 * list. The band below is the evaluator's grading of the candidate against the
 * seat's rubric, which is real evidence; it is translated to words here and the
 * number itself never reaches the screen.
 */
function specReadFrom(input: MapInput, decision: Decision): VerdictRead {
  const verdict = input.read?.rubricFit?.verdict?.trim();
  if (verdict) {
    const v = verdict.toLowerCase();
    const level = /strong|excellent|direct/.test(v)
      ? "strong"
      : /weak|poor|thin|miss/.test(v)
        ? "weak"
        : "mixed";
    return { label: verdict, level };
  }
  if (decision === "blocked") return { label: "—", level: "none" };
  if (decision === "reject") return { label: "Below bar", level: "weak" };

  const total = input.score?.total;
  if (total == null) return { label: "No spec read yet", level: "none" };
  if (total >= ADVANCE_BAND_MIN) return { label: "Clears the bar", level: "strong" };
  if (total >= CONSIDER_BAND_MIN) return { label: "Partial", level: "mixed" };
  return { label: "Below bar", level: "weak" };
}

/**
 * The value read is what orders the interview list (see rankWeight), so a model
 * that calls a file "strong" puts it at the top — which is how a weak applicant
 * ended up billed as the best new candidate. A "strong" verdict has to be backed
 * by the evidence we can actually check: the answers and the rubric grading. When
 * it isn't, keep the model's own words in the detail but stop the headline and the
 * ordering from claiming more than the file earns.
 */
function groundValueRead(value: ValueRead, answers: VerdictRead, spec: VerdictRead): ValueRead {
  if (value.level !== "strong") return value;
  const strength = fitWeight(answers.level) + fitWeight(spec.level); // 0..4
  if (strength >= 3) return value;
  return {
    headline: "Strong on paper, limited evidence",
    level: "fair",
    detail: value.detail,
  };
}

/**
 * The headline strength-vs-salary value read for the board + page. Prefers a
 * Claude-persisted value (grounded against the checkable evidence); otherwise
 * derives a coarse read from the cached answer/spec fit and the salary-value
 * signal so the column is never blank. Words only.
 *
 * A candidate with NO stated salary is "unpriced", never "overpriced": there is
 * no ask to weigh strength against, so the read degrades to level "none" and the
 * caveat ("Salary expectation not stated…") carries the follow-up.
 */
function valueReadFrom(input: MapInput, decision: Decision, answers: VerdictRead, spec: VerdictRead): ValueRead {
  if (input.read?.value) return groundValueRead(input.read.value, answers, spec);
  if (decision === "blocked") {
    return { headline: "No read yet", level: "none", detail: "Materials incomplete — strength-vs-salary read pending." };
  }

  const salaryValue = (input.score?.salary_value ?? "").toLowerCase();
  const unpriced = !input.evals.invest?.ask || salaryValue === "unstated";
  if (unpriced) {
    return {
      headline: "Ask not stated",
      level: "none",
      detail: "No salary expectation on file — no strength-vs-salary read until the ask is confirmed.",
    };
  }

  const strength = fitWeight(answers.level) + fitWeight(spec.level); // 0..4
  const richAsk = salaryValue === "rich for fit" || salaryValue === "poor value";
  const goodValue = salaryValue === "great value" || salaryValue === "justified";

  let level: ValueRead["level"];
  if (decision === "reject") level = "weak";
  else if (strength >= 3 && !richAsk) level = "strong";
  else if (strength <= 1 || (richAsk && strength < 3)) level = "weak";
  else level = "fair";

  const askPart = richAsk ? "rich ask" : goodValue ? "good value" : "fair ask";
  const strengthPart = strength >= 3 ? "Strong" : strength <= 1 ? "Weak" : "Solid";
  const headline =
    decision === "reject"
      ? "Below the bar for the ask"
      : `${strengthPart} candidate, ${askPart}`;

  return {
    headline,
    level,
    detail:
      input.read?.why ||
      `Reads ${strengthPart.toLowerCase()} on the materials against a ${askPart}. Re-analyze for a full strength-vs-salary read.`,
  };
}

/** Total years of experience, from the earliest parsed role start to now. */
function experienceFrom(application: ApplicationLite | null, ro: RoAssessmentRow | null): string {
  const years: number[] = [];
  for (const e of application?.parsed_experience ?? []) {
    const m = String(e.start ?? "").match(/\d{4}/);
    if (m) years.push(Number(m[0]));
  }
  if (years.length) {
    const span = new Date().getFullYear() - Math.min(...years);
    if (span >= 30) return "30+ yr";
    if (span > 0) return `${span} yr`;
  }
  const totalTenure = (ro?.per_role ?? []).reduce((sum, r) => sum + (r.years ?? 0), 0);
  if (totalTenure >= 1) return `${Math.round(totalTenure)} yr`;
  return "—";
}

export function mapCandidate(input: MapInput): Candidate {
  const derived = deriveDecisionDetail(input);
  const decision = derived.decision;
  const tenure = derived.tenure;
  const invest = input.evals.invest;
  const dig = input.evals.dig;
  const ro = input.ro;

  // current role/company from the most recent role_read or narrative role.
  const lastRoleRead = input.evals.roleReads[input.evals.roleReads.length - 1] ?? null;
  const roleTitle = lastRoleRead?.role || ro?.per_role?.[ro.per_role.length - 1]?.role || "Candidate";
  const company = lastRoleRead?.company || ro?.per_role?.[ro.per_role.length - 1]?.company || "—";

  const salary = invest?.ask || "—";
  let why =
    input.read?.why ||
    dig?.careerRead ||
    firstSentence(invest?.summary) ||
    "Read derived from submitted materials.";

  const integrity = (dig?.integrity ?? "").toLowerCase();
  const riskBase =
    integrity !== "clear" && integrity !== "" && dig?.integrityNote
      ? dig.integrityNote
      : dig?.resolve?.[0] || input.evals.verification?.read || "No decisive risk surfaced.";
  const risk = input.read?.risk || riskBase;

  const salaryValue = input.score?.salary_value ?? null;
  const askTier = askTierFor(salaryValue);
  const mismatch =
    salaryValue === "rich for fit" || salaryValue === "poor value" || hasDiscrepancy(input.evals.verification);

  const location = input.candidate.location || ((input.candidate.raw?.address as string) ?? "") || "—";

  const baseRedFlags = [...(input.read?.flags ?? redFlagsFrom(input, tenure))];
  // Claude-authored flag lists omit our deterministic hopping flag — always merge it.
  appendTenureRedFlags(baseRedFlags, tenure);

  const refusedToAnswer = refusedToAnswerFrom(input.application, input.evals.answerGrades);
  if (refusedToAnswer && !baseRedFlags.some((f) => f.flag === "Refused to answer")) {
    baseRedFlags.push({
      flag: "Refused to answer",
      detail: "Screening questions dash-filled or left effectively blank — no real attempt to answer.",
      source: "Application",
    });
  }

  const answersRead = refusedToAnswer
    ? { label: "Blank", level: "weak" as const }
    : answersReadFrom(input.evals.answerGrades);
  const specRead = specReadFrom(input, decision);
  let value = valueReadFrom(input, decision, answersRead, specRead);

  // What must be confirmed before booking (the old "verify first", now a caveat).
  let caveat = input.read?.caveat;
  if (tenure.caveat) {
    // Tenure caveat always surfaces — append if Claude already wrote one.
    caveat = caveat && !/short[- ]tenure|short stint/i.test(caveat)
      ? `${tenure.caveat} ${caveat}`
      : tenure.caveat;
  } else if (!caveat) {
    if (derived.bar.caveat) caveat = derived.bar.caveat;
    else if (hasDiscrepancy(input.evals.verification)) caveat = "Confirm the flagged discrepancy before booking an interview.";
    else if (!invest?.ask || salaryValue === "unstated") caveat = "Salary expectation not stated — confirm it before an interview.";
  }

  // When a gate pulled Interview → Backup, make the copy name the reason. A
  // stored "interview" why (or a "Strong candidate" value headline) otherwise
  // sells the recruiter on a file the gate just held back.
  if (derived.demoted && derived.demotionNote) {
    if (!why.includes(derived.demotionNote)) why = `${derived.demotionNote} ${why}`;
    if (value.level === "strong") {
      value = {
        headline:
          tenure.severity === "pattern" || tenure.severity === "severe"
            ? "Hold — short-tenure pattern"
            : "Hold — not an interview-first",
        level: "fair",
        detail: `${caveat ?? derived.demotionNote} ${value.detail}`.trim(),
      };
    }
  }

  const candidate: Candidate = {
    id: input.candidate.workable_id,
    rank: input.rank,
    name: input.candidate.name || "Unnamed candidate",
    role: roleTitle,
    company,
    jobShortcode: input.jobShortcode,
    jobTitle: input.jobTitle,
    appliedAt: input.candidate.created_at,
    salary,
    salaryNum: askNumK(invest?.ask),
    decision,
    workableStage: (input.candidate.stage ?? "").trim() || undefined,
    processStatus: normalizeProcessStatus(input.processStatus),
    rev: "none",
    revNote: "No human review yet — read synced from submitted materials.",
    why,
    flag: risk,
    // After a gate demotion, ignore stale Claude "Interview" next-step copy.
    next: input.decisionOverride
      ? nextFor(normalizeDecision(input.decisionOverride))
      : derived.demoted
        ? nextFor(decision)
        : input.read?.next || nextFor(decision),
    survivor: decision === "interview",
    value,
    caveat,
    refusedToAnswer,

    askTier,
    askNote: invest?.vector || salaryValue || "ask unstated",
    roLevel: stripRoSubletters(ro?.current_capability || ro?.seat_stratum),
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
    resume: resumeFrom(input.application),
    careerProgression: careerProgressionFrom(ro),
    careerRead: careerReadFrom(input, decision),
    assessment: input.read?.assessment,
    assessedAt: input.read?.assessment ? input.read?.recalculatedAt : undefined,
    rubricFit: input.read?.rubricFit,
    workableUrl: workableUrlFor(input.candidate, input.jobShortcode),

    // v2 app-board fields — derived from cached data only.
    initials: initialsOf(input.candidate.name || "?"),
    avatarColor: avatarColor(input.candidate.workable_id || input.candidate.name || "x"),
    photoUrl: photoUrlFor(input.candidate),
    locationShort: cityState(location),
    experience: experienceFrom(input.application, ro),
    answersRead,
    specRead,
    interviewGate: interviewGateFrom(derived),
  };

  if (decision === "reject") {
    Object.assign(candidate, cutFieldsFor(input));
  }

  if (input.read?.reanalysis) {
    candidate.reanalysis = input.read.reanalysis;
  }

  // #7: surface the human reviewer's signal where a named correction exists.
  const reviewer = reviewerFrom(input, decision);
  if (reviewer) {
    candidate.rev = reviewer.rev;
    candidate.revNote = reviewer.revNote;
  } else if (input.read?.timelineNote) {
    candidate.revNote = `Re-analyzed by Claude. ${input.read.timelineNote}`;
  }

  return candidate;
}
