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

export type CutGroup = "care" | "evidence" | "pattern" | "mismatch";

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

  reanalysis?: Reanalysis;

  timeline: TimelineRow[];
  cover: { hasLetter: boolean; lines: CoverLine[] };
  answers: AnswerRow[];
  logistics: Logistics;
  fireflies?: FirefliesRecording[];
  interview?: InterviewSummary;
  redFlags: RedFlag[];
}

// Persisted human-edit workspace (localStorage key rdi-recruit-ws-v1).
export interface Workspace {
  dq: Record<string, boolean>;
  ovr: Record<string, TimelineRow[]>;
  replies: Record<string, Record<string, string>>;
  corrections: Record<string, { ts: string; text: string }[]>;
  transcripts: Record<string, string>;
  deep: Record<string, boolean>;
}
