// Decision vocabulary — the ONLY status language. No scores, no tiers.
// Four meaningful actions:
//   interview = Interview (worth your time; ranked in priority order)
//   backup    = Backup (competent, only if the interview list falls through)
//   reject    = Reject / do not interview (with a reason — the cut list)
//   blocked   = Review blocked (materials incomplete — no read possible)
export type Decision =
  | "interview"
  | "backup"
  | "reject"
  | "blocked";

// Legacy persisted decisions (pre-collapse) that may still live in stored reads /
// overrides. Mapped to the four current actions at the data boundary.
export type LegacyDecision = "short" | "verify" | "hold" | "cut";

// Where a candidate we've DECIDED to pursue is in OUR hiring process — a separate
// dimension from the triage `Decision` (which is the recommendation) and from the
// Workable pipeline stage (which we mirror read-only). Human-set inside the app,
// post-decision: e.g. handing someone to Lara for an interview or reference checks.
// Absent (undefined/null) = not yet in process.
export type ProcessStatus =
  | "sentToLara"
  | "interviewing"
  | "referenceChecks"
  | "offer"
  | "hired"
  | "passed";

/** Normalize any stored value to a valid ProcessStatus, or null when unset/invalid. */
export function normalizeProcessStatus(s: string | null | undefined): ProcessStatus | null {
  switch (s) {
    case "sentToLara":
    case "interviewing":
    case "referenceChecks":
    case "offer":
    case "hired":
    case "passed":
      return s;
    default:
      return null;
  }
}

/** Normalize any stored/legacy decision to the current four-action vocabulary. */
export function normalizeDecision(d: string | null | undefined): Decision {
  switch (d) {
    case "interview":
    case "short": // "short screen" was still worth human time → interview
    case "verify": // "verify first" → interview, with the caveat surfaced separately
      return "interview";
    case "backup":
    case "hold":
      return "backup";
    case "reject":
    case "cut":
      return "reject";
    case "blocked":
      return "blocked";
    default:
      return "backup";
  }
}

// Reviewer-signal lens (Conall / Lara).
export type ReviewerSignal =
  | "none"
  | "conallPos"
  | "conallConcern"
  | "laraPos"
  | "laraConcern"
  | "laraNo"
  | "mixed"
  | "second";

// Which human reviewer a correction / signal came from. Maps to ReviewerSignal.
export type ReviewerKind = "conall" | "lara" | "other";

// A single human correction note, with optional reviewer identity (#7). The
// reviewer fields are additive — older entries persisted as { ts, text } stay valid.
export interface CorrectionEntry {
  ts: string;
  text: string;
  reviewerId?: string;
  reviewerLabel?: string;
  reviewerKind?: ReviewerKind;
}

// Timeline-row "Signal" chip vocabulary.
export type TimelineSignal =
  | "Positive"
  | "Promotion"
  | "Learning"
  | "Strong"
  | "Verify"
  | "Ask"
  | "Gap"
  | "Cert"
  | "Connected"
  | "Switched"
  | "Inflated";

// Comment "kind" for cover letter / answers margin comments.
export type CommentKind =
  | "ai"
  | "wrong"
  | "typo"
  | "flag"
  | "thin"
  | "good"
  | "ask"
  | "neutral";

export type AskTier = "top" | "high" | "mid" | "value" | "below";

// A cached AI read surfaced as a dot + label on the pool board and dossier
// (Answers · Vs-spec). Level drives the verdict dot + the within-group fit sort;
// "none" means no cached read yet (renders muted "—"). Never a numeric score.
export type VerdictLevel = "strong" | "mixed" | "weak" | "none";

export interface VerdictRead {
  label: string;
  level: VerdictLevel;
}

// The headline "strength vs salary target" read — the core judgment the recruiter
// wants: how strong is this person (life choices on the résumé + answers + fit to
// the spec/rubric) weighed against what they are asking to be paid. Words only,
// never a number.
//   strong = strong candidate for the ask (good value)
//   fair   = strength and ask line up (priced about right)
//   weak   = not strong enough for what they want (poor value / overpriced)
export type ValueLevel = "strong" | "fair" | "weak" | "none";

export interface ValueRead {
  // One-line verdict, e.g. "Strong operator, fair ask" / "Overpriced for the level".
  headline: string;
  level: ValueLevel;
  // 1-2 sentences weighing candidate strength against the salary target.
  detail: string;
}

export type CutGroup = "care" | "evidence" | "pattern" | "mismatch" | "human";

// Career-read prose block surfaced under the deep-analysis compare strip (#6).
// Mapped from dig_in (careerRead / integrityNote / resolve) or filled by Claude.
export interface CareerRead {
  path: string; // career-path read
  positive: string; // positive inference
  risk: string; // risk inference
  implication: string; // decision implication
}

// The long-form written assessment Claude composes for the candidate page — the
// narrative the dossier renders verbatim (no truncation). All prose, never a
// score. Persisted on the read + rendered into the .md working file so it is the
// candidate's saved AI assessment.
export interface AssessmentNarrative {
  // Complete written bio: schooling (+ GPA if listed), early roles, graduate
  // study, progressive roles, what the track is typical of, and the standout
  // accomplishment + the level it implies. Multiple paragraphs (split on blank lines).
  bio: string;
  // Application summary vs the spec: target salary, answer quality + AI-use read,
  // cover-letter quality, and writing-style consistency across the materials.
  application: string;
  // Commute read: where they live and the estimated drive time to the RDI office.
  commute: string;
}

// Claude's read of the candidate against the job's grading rubric. Words only —
// never a numeric score (the rubric's points are summarized as a verdict label).
export interface RubricFit {
  verdict: string; // short fit verdict, e.g. "Strong fit" / "Partial fit" / "Weak fit"
  summary: string; // 2-3 sentences on how they map to the rubric and why they fit (or not)
  strengths: string[]; // rubric-aligned strengths
  gaps: string[]; // rubric gaps / missing evidence
  generatedAt?: string;
}

// Per-job grading rubric + role spec, stored editable in Supabase (job_rubrics).
export interface JobRubric {
  rubricMd: string;
  specMd: string;
}

// --- Grading readiness gate ---------------------------------------------------
// The grader only calls the AI once ALL four required inputs are present. When
// one is missing (after an attempted repair), the candidate's decision is forced
// to "blocked" and the missing inputs are surfaced so the UI can say exactly what
// it is waiting on instead of grading on partial data.
export type ReadinessInput = "answers" | "resume" | "jobSpec" | "methodology";

export interface CandidateReadiness {
  ready: boolean;
  missing: ReadinessInput[];
  // Per-input presence, for granular UI / logging.
  detail: Record<ReadinessInput, boolean>;
  // True when the résumé is missing AND there is NOTHING to ingest — no résumé
  // URL or stored file on record in Workable. Distinguishes a genuinely
  // résumé-less candidate ("nothing to grade") from one whose résumé simply has
  // not been pulled/parsed yet (a resync can fix that). Drives the UI copy so a
  // no-résumé candidate is not mistaken for a fixable bug.
  resumeMissingFromSource: boolean;
}

// Pool-relative standing — ordinal only, NEVER a numeric score or tier. Derived
// across the active pool at load time and surfaced as "Nth of M".
export interface PoolStanding {
  // 1-based rank among all active candidates in the pool (1 = strongest).
  overallRank: number;
  activeTotal: number;
  // 1-based rank within the candidate's own decision group.
  groupRank: number;
  groupTotal: number;
  // Human label of the decision group (e.g. "interview-ready", "to verify").
  groupLabel: string;
}

export type TimelineRowType = "edu" | "role" | "cert" | "gap";

export interface TimelineRow {
  type: TimelineRowType;
  period: string;
  org: string;
  role: string;
  tenure: string;
  scope: string;
  lang: string;
  signal: TimelineSignal;
}

export interface CoverLine {
  t: string;
  comment?: string;
  kind: CommentKind;
}

export interface AnswerRow {
  q: string;
  a: string;
  comment?: string;
  kind: CommentKind;
}

export interface LogisticsSignal {
  mark: string; // "+" or "–"
  t: string;
}

export interface Logistics {
  mode: string;
  location: string;
  distance: string;
  likelihood: string; // High | Medium | Low | —
  read: string;
  signals: LogisticsSignal[];
}

export interface FirefliesRecording {
  title: string;
  date: string;
  dur: string;
  transcript: string;
}

export interface InterviewPoint {
  mark: string; // "+" or "–"
  t: string;
}

export interface InterviewSummary {
  title: string;
  fit: string;
  points: InterviewPoint[];
}

export interface Reanalysis {
  reviewer: string;
  before: string;
  after: string;
  rec: string;
}

export interface RedFlag {
  flag: string;
  detail: string;
  source: string;
}

// One role parsed from the résumé (applications.parsed_experience / résumé text).
export interface ResumeRole {
  title: string;
  company: string;
  period: string; // "May 2020 – Present" | "2020 – 2024" | "—"
  current: boolean;
  bullets: string[];
}

// The candidate's résumé, surfaced read-only. Degrades gracefully: when no
// résumé has been ingested, hasResume is false and the UI shows the empty state.
export interface ResumeView {
  hasResume: boolean;
  roles: ResumeRole[];
  // Full extracted résumé text when ingested (applications.resume_text).
  fullText?: string;
  // Original résumé file link from Workable (may be a time-limited signed URL).
  fileUrl?: string;
}

// One step of the RO-derived career progression (ro_assessments.per_role).
export interface CareerStep {
  role: string;
  company: string;
  tenure: string; // "1.4 yrs" | "—"
  stratum: string; // RO capability stratum, e.g. "IIa"
  stratumRange: string; // e.g. "IIa–IIb"
  // Strongest scope verbs evidencing the stratum (highest tier present).
  verbs: string[];
}

// Career progression derived from the RO assessment. Distinct from the
// narrative timeline: this is the RO-method capability read role-by-role.
export interface CareerProgression {
  hasData: boolean;
  steps: CareerStep[];
  seatStratum: string; // RO stratum the seat calls for
  currentCapability: string; // where the candidate currently reads
  trajectory: string; // human-readable trajectory label
  confidenceNote: string; // how much to trust the résumé text
  basis: string; // what the read leaned on
}

export interface Candidate {
  id: string;
  rank: number;
  name: string;
  role: string;
  company: string;
  appliedAt: string | null;
  salary: string;
  salaryNum: number;
  decision: Decision;
  // Live Workable pipeline stage, mirrored read-only from the ATS (candidates.stage).
  // e.g. "Phone Screen", "Interview". Empty/undefined when not synced.
  workableStage?: string;
  // Our post-decision process status (human-set in-app). Null/undefined = not in process.
  processStatus?: ProcessStatus | null;
  rev: ReviewerSignal;
  revNote: string;
  why: string;
  flag: string;
  next: string;
  survivor: boolean;

  // The headline strength-vs-salary read (surfaced at the top of the page + on the
  // board). Prefer the Claude-generated value; degrades to a derived read.
  value: ValueRead;
  // What must be confirmed before booking an interview (the old "verify first",
  // now a caveat flag rather than a status). Empty when there is nothing to verify.
  caveat?: string;

  askTier: AskTier;
  askNote: string;
  roLevel: string;
  roVsPool: string;
  mismatch: boolean;
  mismatchLabel?: string;
  mismatchRead: string;

  // Cut-only fields
  cutGroup?: CutGroup;
  cutReason?: string;
  cite?: string;
  cutMatters?: string;

  // Career-read prose (deep analysis). Present only when dig_in data supports it.
  careerRead?: CareerRead;

  // Long-form written assessment (bio / application summary / commute) — present
  // once Claude has generated it (Update assessment). Renders verbatim on the page.
  assessment?: AssessmentNarrative;
  // When the pinned assessment was last generated/refreshed by Claude (ISO).
  assessedAt?: string;

  // Claude's read of this candidate against the job rubric (#rubric-fit).
  rubricFit?: RubricFit;

  reanalysis?: Reanalysis;

  timeline: TimelineRow[];
  cover: { hasLetter: boolean; lines: CoverLine[] };
  answers: AnswerRow[];
  logistics: Logistics;
  fireflies?: FirefliesRecording[];
  interview?: InterviewSummary;
  redFlags: RedFlag[];

  // Résumé content (from the application) + RO-derived career progression.
  resume: ResumeView;
  careerProgression?: CareerProgression;

  // Real Workable deeplink (from candidates.raw.profile_url, else link helper).
  workableUrl: string;

  // --- v2 app-board fields (HANDOFF-v2 §1.A) — dense row presentation +
  // the two cached AI reads. All derived from existing cached data, no Claude. ---
  initials: string;
  avatarColor: string;
  // Workable profile photo (raw.image_url), when present. The board renders it as
  // the avatar and falls back to initials + avatarColor when absent or broken.
  photoUrl?: string;
  locationShort: string;
  experience: string; // "30+ yr" | "16 yr" | "—"
  answersRead: VerdictRead; // cached read of the application answers
  specRead: VerdictRead; // cached read of fit vs. the job spec/rubric

  // Grading readiness — present when the decision is "blocked" because a required
  // grading input is missing. Drives the "Review blocked — waiting on X" UI.
  readiness?: CandidateReadiness;
  // Pool-relative standing (ordinal only), derived across the active pool at load.
  standing?: PoolStanding;
}

// Persisted human-edit workspace. Hydrated server-side from candidate_overlay
// (disqualify) + candidate_working_files.workspace (everything else); edits are
// written back through server actions (see src/app/actions/triage.ts).
// One turn in the per-candidate "war room" conversation with Claude.
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  ts: string;
  // For user turns: the human reviewer's label (e.g. "Conall"). Omitted for Claude.
  author?: string;
}

// One entry in the per-candidate activity log (HANDOFF-v2 §2) — human-authored
// only; Claude does not auto-reply here. Persisted one row per entry in `activity`.
export type ActivityType = "interview" | "note" | "comment";

export interface ActivityEntry {
  id: string;
  type: ActivityType;
  author: string;
  body: string;
  at: string; // ISO timestamp
}

export interface Workspace {
  dq: Record<string, boolean>;
  ovr: Record<string, TimelineRow[]>;
  replies: Record<string, Record<string, string>>;
  corrections: Record<string, CorrectionEntry[]>;
  transcripts: Record<string, string>;
  deep: Record<string, boolean>;
  chat: Record<string, ChatMessage[]>;
  activity: Record<string, ActivityEntry[]>;
  /** When the pinned assessment was last regenerated from the war room / activity. */
  regen: Record<string, string>;
  /** Post-decision process status per candidate (Sent to Lara, Interviewing, …). */
  process: Record<string, ProcessStatus>;
}

// The per-candidate slice of the workspace, as stored in
// candidate_working_files.workspace (jsonb). Disqualify lives on
// candidate_overlay, so it is intentionally absent here.
export interface WorkspaceSlice {
  ovr?: TimelineRow[];
  replies?: Record<string, string>;
  corrections?: CorrectionEntry[];
  transcript?: string;
  deep?: boolean;
  chat?: ChatMessage[];
  /**
   * Manual decision set by a human reviewer. Wins over Claude's read in
   * deriveDecision, so the board/dossier reflect it immediately. Cleared when a
   * Claude re-analysis runs (re-analyze hands the call back to the model).
   */
  decisionOverride?: Decision | null;
  /**
   * Our post-decision process status (Sent to Lara, Interviewing, Reference
   * checks, …). Human-set in-app and orthogonal to the triage decision. Null
   * clears it back to "not in process". Untouched by Claude re-analysis.
   */
  processStatus?: ProcessStatus | null;
}

// Claude's re-derived decision read, stored in candidate_working_files.read.
// Decision vocabulary only — NEVER any numeric score or tier.
export interface DecisionRead {
  decision: Decision;
  why: string;
  risk: string;
  next: string;
  timelineNote?: string;
  flags?: RedFlag[];
  // Set when a human note/transcript moved the decision: surfaces the
  // before→after re-analysis with the human-signal reviewer in the UI.
  reanalysis?: Reanalysis;
  // Reviewer-signal lens, derived from the human who left the latest correction (#7).
  rev?: ReviewerSignal;
  revNote?: string;
  // Career-read prose, optionally filled/refined by Claude (#6).
  careerRead?: CareerRead;
  // Headline strength-vs-salary value read.
  value?: ValueRead;
  // What to confirm before an interview (verify-first caveat). Empty if nothing.
  caveat?: string;
  // Long-form written assessment (bio / application summary / commute).
  assessment?: AssessmentNarrative;
  // Rubric-fit read, filled by Claude when a job rubric is available.
  rubricFit?: RubricFit;
  // When the grader blocked on missing inputs, the inputs it was waiting on.
  // Present only on a "blocked" read produced by the readiness gate.
  missingInputs?: ReadinessInput[];
  recalculatedAt?: string;
  model?: string;
}

// Pool-level header values, derived server-side from the live job + counts.
export interface PoolMeta {
  title: string;
  jobShortcode: string;
  jobUrl: string;
  healthState: string;
  healthRead: string;
  total: number;
}

export interface JobOption {
  shortcode: string;
  title: string;
}
