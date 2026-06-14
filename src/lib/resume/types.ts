export interface ParsedResumeRole {
  title: string;
  company: string;
  start: string | null;
  end: string | null;
  current: boolean;
  bullets: string[];
  resumeLine: string;
  stratumHint?: string;
}

export interface ParsedResumeEducation {
  school: string;
  degree: string | null;
  field: string | null;
  start: string | null;
  end: string | null;
}

export interface ParsedResumeGap {
  start: string;
  end: string;
  months: number;
  label: string;
  assumption?: boolean;
}

export interface ParsedResumeReview {
  chronologySummary: string;
  dateFlags: string[];
  roles: ParsedResumeRole[];
  education: ParsedResumeEducation[];
  gaps: ParsedResumeGap[];
  modelVersion: string;
  parsedAt: string;
}

export interface ResumeIngestResult {
  storagePath: string;
  mime: string;
  text: string;
  parsed: ParsedResumeReview;
  skipped?: boolean;
}
