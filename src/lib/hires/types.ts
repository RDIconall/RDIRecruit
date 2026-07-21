/** One row in the cross-job New Hires inbox. */
export interface HireInboxItem {
  candidateId: string;
  name: string;
  email: string | null;
  /** Requisition / job title they were hired into. */
  jobTitle: string;
  jobShortcode: string;
  /** Current résumé title when known. */
  currentTitle: string;
  company: string;
  hiredAt: string;
  read: boolean;
  readAt: string | null;
  readBy: string | null;
  workableUrl: string;
  /** Deep link into the triage dossier for this job. */
  triageUrl: string;
}

export interface HireInboxSummary {
  total: number;
  unread: number;
  /** Unread counts keyed by job shortcode (for the summary strip). */
  unreadByJob: { shortcode: string; title: string; count: number }[];
  items: HireInboxItem[];
  configured: boolean;
}
