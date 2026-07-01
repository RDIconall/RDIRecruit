import "server-only";
import { getPublishedJobs } from "../jobs/service";
import { loadTriagePool } from "./load";
import type { Candidate, Decision } from "./types";

// Per-candidate status word for the email (the four-action vocabulary — no
// scores, no tiers). Mirrors POOL_GROUPS but phrased for a single candidate.
const STATUS_LABEL: Record<Decision, string> = {
  interview: "Interview",
  backup: "Backup",
  reject: "Do not interview",
  blocked: "Review blocked",
};

// Fixed display order + decision priority for picking the single top candidate.
const DECISION_ORDER: Decision[] = ["interview", "backup", "reject", "blocked"];

export interface SummaryCandidate {
  id: string;
  firstName: string;
  fullName: string;
  /** The role they applied for (the requisition title). */
  role: string;
  /** Their current title/company, when known (adds colour to the top pick). */
  currentTitle: string;
  company: string;
  decision: Decision;
  statusLabel: string;
  why: string;
  flag: string;
  appliedAt: string | null;
  rank: number;
  workableUrl: string;
}

export interface SummaryGroup {
  decision: Decision;
  label: string;
  candidates: SummaryCandidate[];
}

export interface DailySummary {
  windowHours: number;
  generatedAt: string;
  total: number;
  top: SummaryCandidate | null;
  /** Everyone except the top pick, grouped by status (in fixed order). */
  groups: SummaryGroup[];
}

function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] || name.trim() || "Candidate";
}

function withinWindow(appliedAt: string | null, sinceMs: number): boolean {
  if (!appliedAt) return false;
  const t = Date.parse(appliedAt);
  return Number.isFinite(t) && t >= sinceMs;
}

function toSummaryCandidate(c: Candidate, jobTitle: string): SummaryCandidate {
  return {
    id: c.id,
    firstName: firstNameOf(c.name),
    fullName: c.name,
    role: jobTitle,
    currentTitle: c.role || "",
    company: c.company || "",
    decision: c.decision,
    statusLabel: STATUS_LABEL[c.decision],
    why: c.why || "Read derived from submitted materials.",
    flag: c.flag || "",
    appliedAt: c.appliedAt,
    rank: c.standing?.overallRank ?? c.rank,
    workableUrl: c.workableUrl,
  };
}

/**
 * Gather every candidate who applied in the last `windowHours` across all
 * published jobs, with the live decision + "why" exactly as the triage UI
 * derives them. Picks one top candidate and groups the rest by status.
 */
export async function collectDailySummary(windowHours = 24): Promise<DailySummary> {
  const now = Date.now();
  const sinceMs = now - windowHours * 60 * 60 * 1000;
  const jobs = await getPublishedJobs();

  const recent: SummaryCandidate[] = [];
  for (const job of jobs) {
    let pool;
    try {
      pool = await loadTriagePool(job.shortcode);
    } catch (error) {
      console.error(`daily-summary: failed to load pool for ${job.shortcode}`, error);
      continue;
    }
    for (const candidate of pool.candidates) {
      if (!withinWindow(candidate.appliedAt, sinceMs)) continue;
      recent.push(toSummaryCandidate(candidate, job.title));
    }
  }

  // Best-first ordering: interview before backup before reject before blocked,
  // then by pool standing (lower rank = stronger) within a status.
  const priority = (d: Decision) => DECISION_ORDER.indexOf(d);
  recent.sort((a, b) => priority(a.decision) - priority(b.decision) || a.rank - b.rank);

  const top = recent[0] ?? null;
  const rest = top ? recent.slice(1) : recent;

  const groups: SummaryGroup[] = DECISION_ORDER.map((decision) => ({
    decision,
    label: STATUS_LABEL[decision],
    candidates: rest.filter((c) => c.decision === decision),
  })).filter((group) => group.candidates.length > 0);

  return {
    windowHours,
    generatedAt: new Date(now).toISOString(),
    total: recent.length,
    top,
    groups,
  };
}

// ---------------------------------------------------------------------------
// Rendering — inline-styled HTML (email clients ignore <style>) + a plain-text
// fallback. Neutral palette, no scores, no tiers.
// ---------------------------------------------------------------------------

const C = {
  ink: "#1A1A1A",
  secondary: "#595959",
  muted: "#8A8A8A",
  hair: "#E6E6E6",
  accent: "#2563EB",
  accentSoft: "#F0F5FF",
  accentBorder: "#CBD9F5",
  bg: "#F6F7F9",
  surface: "#FFFFFF",
};

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function summarySubject(summary: DailySummary): string {
  const window = summary.windowHours === 24 ? "today" : `last ${summary.windowHours}h`;
  if (summary.total === 0) return `Applicant summary — no new applicants ${window}`;
  const noun = summary.total === 1 ? "applicant" : "applicants";
  const lead = summary.top ? ` — top: ${summary.top.firstName}` : "";
  return `Applicant summary — ${summary.total} new ${noun} ${window}${lead}`;
}

function topBlockHtml(top: SummaryCandidate): string {
  const subline = [top.currentTitle, top.company].filter(Boolean).join(" · ");
  return `
  <tr><td style="padding:0 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.accentSoft};border:1px solid ${C.accentBorder};border-radius:10px;">
      <tr><td style="padding:18px 20px;">
        <div style="font:600 11px ${FONT};letter-spacing:.08em;text-transform:uppercase;color:${C.accent};">Top candidate</div>
        <div style="font:600 20px ${FONT};color:${C.ink};margin-top:6px;">
          <a href="${esc(top.workableUrl)}" style="color:${C.ink};text-decoration:none;">${esc(top.firstName)}</a>
        </div>
        <div style="font:400 14px ${FONT};color:${C.secondary};margin-top:2px;">${esc(top.role)}${subline ? ` <span style="color:${C.muted};">· ${esc(subline)}</span>` : ""}</div>
        <div style="font:400 14px ${FONT};color:${C.ink};margin-top:10px;line-height:1.5;">${esc(top.why)}</div>
      </td></tr>
    </table>
  </td></tr>`;
}

function rowHtml(c: SummaryCandidate): string {
  const sub = [c.currentTitle, c.company].filter(Boolean).join(" · ");
  return `
  <tr><td style="padding:12px 0;border-top:1px solid ${C.hair};">
    <div style="font:600 15px ${FONT};color:${C.ink};">
      <a href="${esc(c.workableUrl)}" style="color:${C.ink};text-decoration:none;">${esc(c.fullName)}</a>
      <span style="font:400 13px ${FONT};color:${C.muted};"> — ${esc(c.role)}</span>
    </div>
    ${sub ? `<div style="font:400 13px ${FONT};color:${C.muted};margin-top:2px;">${esc(sub)}</div>` : ""}
    <div style="font:400 14px ${FONT};color:${C.secondary};margin-top:6px;line-height:1.5;">${esc(c.why)}</div>
    ${c.flag ? `<div style="font:400 13px ${FONT};color:${C.muted};margin-top:4px;">Watch: ${esc(c.flag)}</div>` : ""}
  </td></tr>`;
}

function groupHtml(group: SummaryGroup): string {
  const rows = group.candidates.map(rowHtml).join("");
  return `
  <tr><td style="padding:26px 24px 0;">
    <div style="font:600 12px ${FONT};letter-spacing:.06em;text-transform:uppercase;color:${C.secondary};">
      ${esc(group.label)} <span style="color:${C.muted};">(${group.candidates.length})</span>
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px;">${rows}</table>
  </td></tr>`;
}

export function renderSummaryHtml(summary: DailySummary): string {
  const date = new Date(summary.generatedAt).toLocaleString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
  const window = summary.windowHours === 24 ? "the last 24 hours" : `the last ${summary.windowHours} hours`;

  const body =
    summary.total === 0
      ? `<tr><td style="padding:24px;font:400 15px ${FONT};color:${C.secondary};">No new candidates applied in ${esc(window)}.</td></tr>`
      : `${summary.top ? topBlockHtml(summary.top) : ""}${summary.groups.map(groupHtml).join("")}`;

  return `<!doctype html><html><body style="margin:0;background:${C.bg};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${C.surface};border:1px solid ${C.hair};border-radius:12px;overflow:hidden;">
        <tr><td style="padding:24px 24px 4px;">
          <div style="font:600 18px ${FONT};color:${C.ink};">New applicants</div>
          <div style="font:400 13px ${FONT};color:${C.muted};margin-top:2px;">${esc(date)} · ${summary.total} ${summary.total === 1 ? "candidate" : "candidates"} in ${esc(window)}</div>
        </td></tr>
        ${body}
        <tr><td style="padding:26px 24px;font:400 12px ${FONT};color:${C.muted};border-top:1px solid ${C.hair};margin-top:24px;">
          Statuses use the triage vocabulary: Interview · Backup · Do not interview · Review blocked. Open a name to view the full read in Workable.
        </td></tr>
      </table>
    </td></tr>
  </table>
  </body></html>`;
}

export function renderSummaryText(summary: DailySummary): string {
  const window = summary.windowHours === 24 ? "the last 24 hours" : `the last ${summary.windowHours} hours`;
  if (summary.total === 0) return `New applicants\n\nNo new candidates applied in ${window}.`;

  const lines: string[] = [`New applicants — ${summary.total} in ${window}`, ""];

  if (summary.top) {
    const t = summary.top;
    const sub = [t.currentTitle, t.company].filter(Boolean).join(" · ");
    lines.push("TOP CANDIDATE");
    lines.push(`${t.firstName} — ${t.role}${sub ? ` (${sub})` : ""}`);
    lines.push(`Why: ${t.why}`);
    lines.push("");
  }

  for (const group of summary.groups) {
    lines.push(`${group.label.toUpperCase()} (${group.candidates.length})`);
    for (const c of group.candidates) {
      lines.push(`- ${c.fullName} — ${c.role}`);
      lines.push(`  Why: ${c.why}`);
      if (c.flag) lines.push(`  Watch: ${c.flag}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
