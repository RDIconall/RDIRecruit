export type CategoryKey =
  | "principal"
  | "environment"
  | "scope"
  | "writing"
  | "tenure"
  | "local";

export type CategoryScores = Record<CategoryKey, number>;

export type SalaryValue =
  | "justified"
  | "great value"
  | "rich for fit"
  | "poor value"
  | "unstated";

export type Confidence = "high" | "medium" | "text-unreliable";

export type TextConfidence = "confirmed" | "downgraded" | "text-unreliable";

export type Trajectory =
  | "grows-the-role"
  | "bends-away"
  | "plateaued"
  | "regressed";

export interface CandidateRow {
  workable_id: string;
  job_shortcode: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
  stage: string | null;
  stage_kind: string | null;
  disqualified: boolean;
  source: string | null;
  assignee_id: string | null;
  raw: Record<string, unknown> | null;
  created_at: string | null;
  synced_at: string;
}

export interface ScoreRow {
  id: string;
  candidate_id: string;
  rubric_version: number;
  category_scores: CategoryScores;
  total: number;
  salary_value: SalaryValue | null;
  confidence: Confidence | null;
  model_version: string | null;
  created_at: string;
}

export interface ScoreInputRow {
  id: string;
  score_id: string;
  category: CategoryKey | null;
  claim: string | null;
  source_type: string | null;
  source_ref: string | null;
  quote: string | null;
  capture_kind: string | null;
  capture_path: string | null;
  capture_locator: Record<string, unknown> | null;
  capture_status: string | null;
}

export interface RoAssessmentRow {
  id: string;
  candidate_id: string;
  per_role: RoRoleAssessment[];
  seat_stratum: string | null;
  current_capability: string | null;
  trajectory: Trajectory | null;
  text_confidence: TextConfidence | null;
  basis: string | null;
  created_at: string;
}

export interface RoRoleAssessment {
  role: string;
  company: string;
  years: number;
  stratum: string;
  stratum_range: string;
  verbs: { I: string[]; II: string[]; III: string[] };
}

export interface NarrativeSegment {
  span: string;
  type: "role" | "gap" | "overlap" | "education";
  text: string;
  assumption?: boolean;
}

export interface ExtractedFeatures {
  principalType: string;
  companySize: string;
  tenureMonths: number;
  scopeVerbs: string[];
  writingQuality: number;
  localFit: number;
  aiBoilerplateTell: boolean;
  salaryExpectation: string | null;
  claims: Array<{
    category: CategoryKey;
    claim: string;
    sourceType: string;
    sourceRef: string;
    quote: string;
  }>;
}

/** An evidence row backing the score — interviews, async-video answers, transcripts. */
export interface EvidenceRow {
  id: string;
  candidate_id: string;
  source_type: string;
  author: string | null;
  label: string | null;
  captured_at: string | null;
  raw_ref: string | null;
  transcript: string | null;
  extracted: Record<string, unknown> | null;
  created_at: string;
}

export interface CandidateOverlayRow {
  candidate_id: string;
  status: "active" | "disqualified" | "withdrawn";
  status_reason: string | null;
  complement: "owner" | "technician" | null;
  complement_removes: string | null;
  salary_vector: string | null;
  updated_by?: string | null;
  updated_at?: string | null;
}

export type AnswerVerdict = "OWNED" | "SURFACE" | "EVASIVE";
export type VerificationVerdict = "CONFIRMED" | "DISCREPANCY" | "UNVERIFIABLE";

/** invest_head evaluation — the §2 complement read + the candidate-level summary. */
export interface InvestPayload {
  complement: "owner" | "technician";
  head: string;
  removes: string;
  vector: string;
  summary: string;
  /** Parsed salary ask, e.g. "$100k" (present in stored invest_head payloads). */
  ask?: string | null;
}

/** role_read evaluation — one per career role, keyed by role/company. */
export interface RoleReadPayload {
  role: string;
  company: string;
  read: string;
  level: string;
  burden: string;
  stratum: string;
  quote: string;
}

/** dig_in evaluation — the application-quality card. */
export interface DigInPayload {
  quality: string;
  mix: string;
  integrity: string;
  integrityNote: string;
  careerRead: string;
  resolve: string[];
}

/** verification evaluation — the claims table + the live/offer checklists. */
export interface VerificationPayload {
  read: string;
  claims: Array<{
    category: string;
    application: string;
    profile: string;
    verdict: VerificationVerdict;
    note: string;
  }>;
  questions: string[];
  actions: string[];
}

/** answer_grade evaluation — one per screening answer. */
export interface AnswerGradePayload {
  question: string;
  answer: string;
  verdict: AnswerVerdict;
  present: string[];
  note: string;
  kind: string;
}

/** compose_questions evaluation — AI-suggested risk probes for the invite. */
export interface ComposeQuestionsPayload {
  questions: Array<{ q: string; why: string }>;
}

export interface BoardCandidate {
  candidate: CandidateRow;
  score: ScoreRow | null;
  ro: RoAssessmentRow | null;
  overlay?: CandidateOverlayRow | null;
  /** One-line AI investment read, surfaced on the Evidence view. */
  why?: string | null;
  /** Parsed salary ask, surfaced on the Ledger view. */
  ask?: string | null;
  /** Count of cited evidence sources backing the score. */
  sources?: number;
  /** Who owns the candidate in the layer (the reviewer who last acted). */
  assignee?: string | null;
}
