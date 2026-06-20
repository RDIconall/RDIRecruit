// Talent Radar domain types. A "contact" is the shared person record used by
// BOTH recruiting and BD pipelines — the overlap is intentional.

export type Pipeline = "recruiting" | "bd";

export const PIPELINES: { id: Pipeline; label: string }[] = [
  { id: "recruiting", label: "Recruiting" },
  { id: "bd", label: "BD outreach" },
];

export type EmailStatus = "unknown" | "valid" | "risky" | "invalid" | "bounced";
export type ConsentStatus = "unknown" | "implied" | "explicit" | "withdrawn";
export type OutreachChannel = "email" | "linkedin";
export type OutreachStatus =
  | "not_started"
  | "drafted"
  | "sent"
  | "replied"
  | "bounced"
  | "opted_out"
  | "no_response"
  | "meeting";

export interface SearchCriteria {
  titles: string[];
  keywords: string[];
  companies: string[];
  locations: string[];
  relocationAllowed: boolean;
  mustHave: string[];
  exclude: string[];
}

export const EMPTY_CRITERIA: SearchCriteria = {
  titles: [],
  keywords: [],
  companies: [],
  locations: [],
  relocationAllowed: true,
  mustHave: [],
  exclude: [],
};

export interface RadarSearch {
  id: string;
  title: string;
  pipeline: Pipeline;
  criteria: SearchCriteria;
  createdBy?: string | null;
  createdAt: string;
}

export interface ScoreDimensionDef {
  key: string;
  label: string;
  weight: number;
  /** Higher score = more concern (e.g. "too big-company/process-only"). */
  isRisk?: boolean;
  basis: string;
}

export interface ScoreDimension {
  key: string;
  label: string;
  score: number; // 1-5
  rationale: string;
  isRisk?: boolean;
}

export interface RadarScore {
  id: string;
  contactId: string;
  pipeline: Pipeline;
  scorecardName?: string | null;
  dimensions: ScoreDimension[];
  overall: number | null;
  recommendation: string | null;
  summary: string | null;
  strongestSignal: string | null;
  biggestConcern: string | null;
  nextAction: string | null;
  model?: string | null;
  createdAt: string;
}

export interface RadarOutreach {
  id: string;
  contactId: string;
  pipeline: Pipeline;
  channel: OutreachChannel;
  status: OutreachStatus;
  owner?: string | null;
  subject?: string | null;
  body?: string | null;
  lastContactDate?: string | null;
  nextFollowUpDate?: string | null;
  response?: string | null;
  unsubscribeToken: string;
  createdAt: string;
  updatedAt: string;
}

export interface RadarContact {
  id: string;
  searchId?: string | null;
  pipeline: Pipeline[];
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
  linkedinUrl: string | null;
  email: string | null;
  phone: string | null;
  source: string;
  profileSummary: string | null;
  emailStatus: EmailStatus;
  consentStatus: ConsentStatus;
  optOut: boolean;
  optOutAt?: string | null;
  optOutReason?: string | null;
  owner?: string | null;
  dedupeKey?: string | null;
  raw?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  // joined
  score?: RadarScore | null;
  outreach?: RadarOutreach[];
}

/** A raw, not-yet-persisted contact from a provider, CSV, or manual entry. */
export interface RawContact {
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  title?: string | null;
  company?: string | null;
  location?: string | null;
  linkedinUrl?: string | null;
  email?: string | null;
  phone?: string | null;
  source: string;
  profileSummary?: string | null;
  emailStatus?: EmailStatus;
  raw?: Record<string, unknown>;
}

export interface OutreachDraft {
  emailSubject: string;
  emailBody: string;
  linkedinMessage: string;
}

export const OUTREACH_STATUS_LABEL: Record<OutreachStatus, string> = {
  not_started: "Not started",
  drafted: "Drafted",
  sent: "Sent",
  replied: "Replied",
  bounced: "Bounced",
  opted_out: "Opted out",
  no_response: "No response",
  meeting: "Meeting booked",
};
