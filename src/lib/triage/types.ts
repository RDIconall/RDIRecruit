// Decision vocabulary — the ONLY status language. No scores, no tiers.
export type Decision =
  | "interview"
  | "short"
  | "verify"
  | "hold"
  | "cut"
  | "blocked";

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

export type CutGroup = "care" | "evidence" | "pattern" | "mismatch" | "human";

// Career-read prose block surfaced under the deep-analysis compare strip (#6).
// Mapped from dig_in (careerRead / integrityNote / resolve) or filled by Claude.
export interface CareerRead {
  path: string; // career-path read
  positive: string; // positive inference
  risk: string; // risk inference
  implication: string; // decision implication
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
  salary: string;
  salaryNum: number;
  decision: Decision;
  rev: ReviewerSignal;
  revNote: string;
  why: string;
  flag: string;
  next: string;
  survivor: boolean;

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
}

// Persisted human-edit workspace. Hydrated server-side from candidate_overlay
// (disqualify) + candidate_working_files.workspace (everything else); edits are
// written back through server actions (see src/app/actions/triage.ts).
export interface Workspace {
  dq: Record<string, boolean>;
  ovr: Record<string, TimelineRow[]>;
  replies: Record<string, Record<string, string>>;
  corrections: Record<string, CorrectionEntry[]>;
  transcripts: Record<string, string>;
  deep: Record<string, boolean>;
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
  /**
   * Manual decision set by a human reviewer. Wins over Claude's read in
   * deriveDecision, so the table/profile reflect it immediately. Cleared when a
   * Claude re-analysis runs (re-analyze hands the call back to the model).
   */
  decisionOverride?: Decision | null;
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
