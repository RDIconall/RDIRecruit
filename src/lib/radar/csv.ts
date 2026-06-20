import type { RadarContact, RawContact } from "./types";

/**
 * Minimal RFC-4180-ish CSV parser: handles quoted fields, escaped quotes (""),
 * and CRLF/CR/LF line endings. Avoids adding a dependency for a small, known
 * shape (exported recruiter/Sales-Nav/Clay lists).
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const s = text.replace(/^\uFEFF/, ""); // strip BOM
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\r") { if (s[i + 1] === "\n") i++; row.push(field); rows.push(row); field = ""; row = []; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); field = ""; row = []; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim().length));
}

// Header aliases → canonical field. Lowercased, non-alphanumerics stripped.
const FIELD_ALIASES: Record<string, string[]> = {
  fullName: ["name", "fullname", "contactname"],
  firstName: ["firstname", "first", "givenname"],
  lastName: ["lastname", "last", "surname", "familyname"],
  title: ["title", "jobtitle", "position", "currenttitle", "headline"],
  company: ["company", "companyname", "currentcompany", "organization", "employer", "account"],
  location: ["location", "city", "geo", "region", "addresslocation", "locationname"],
  linkedinUrl: ["linkedin", "linkedinurl", "linkedinprofile", "profileurl", "personlinkedinurl", "liurl"],
  email: ["email", "emailaddress", "workemail", "personalemail", "email1"],
  phone: ["phone", "phonenumber", "mobile", "mobilephone", "directphone", "workphone"],
  profileSummary: ["summary", "about", "bio", "notes", "description", "profilesummary"],
};

function norm(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function buildHeaderMap(header: string[]): Record<number, string> {
  const map: Record<number, string> = {};
  header.forEach((h, idx) => {
    const n = norm(h);
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      if (aliases.includes(n)) { map[idx] = field; return; }
    }
  });
  return map;
}

/**
 * Turn raw CSV text into RawContact rows. `source` records provenance (e.g.
 * "CSV: Sales Navigator"). Rows with no name and no email/linkedin are dropped.
 */
export function csvToRawContacts(text: string, source: string): RawContact[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const header = rows[0];
  const map = buildHeaderMap(header);
  const out: RawContact[] = [];
  for (const r of rows.slice(1)) {
    const rec: Record<string, string> = {};
    const raw: Record<string, unknown> = {};
    r.forEach((val, idx) => {
      const field = map[idx];
      const v = val.trim();
      if (field) rec[field] = v;
      if (header[idx]) raw[header[idx]] = v;
    });
    const hasName = rec.fullName || rec.firstName || rec.lastName;
    const hasContact = rec.email || rec.linkedinUrl;
    if (!hasName && !hasContact) continue;
    out.push({
      fullName: rec.fullName ?? null,
      firstName: rec.firstName ?? null,
      lastName: rec.lastName ?? null,
      title: rec.title ?? null,
      company: rec.company ?? null,
      location: rec.location ?? null,
      linkedinUrl: rec.linkedinUrl ?? null,
      email: rec.email ?? null,
      phone: rec.phone ?? null,
      profileSummary: rec.profileSummary ?? null,
      source,
      raw,
    });
  }
  return out;
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const EXPORT_COLUMNS: { header: string; get: (c: RadarContact) => unknown }[] = [
  { header: "Name", get: (c) => c.fullName },
  { header: "Title", get: (c) => c.title },
  { header: "Company", get: (c) => c.company },
  { header: "Location", get: (c) => c.location },
  { header: "LinkedIn", get: (c) => c.linkedinUrl },
  { header: "Email", get: (c) => c.email },
  { header: "Email status", get: (c) => c.emailStatus },
  { header: "Phone", get: (c) => c.phone },
  { header: "Source", get: (c) => c.source },
  { header: "Pipeline", get: (c) => c.pipeline.join("; ") },
  { header: "Owner", get: (c) => c.owner },
  { header: "Consent", get: (c) => c.consentStatus },
  { header: "Opted out", get: (c) => (c.optOut ? "yes" : "no") },
  { header: "Score", get: (c) => c.score?.overall ?? "" },
  { header: "Recommendation", get: (c) => c.score?.recommendation ?? "" },
  { header: "Strongest signal", get: (c) => c.score?.strongestSignal ?? "" },
  { header: "Biggest concern", get: (c) => c.score?.biggestConcern ?? "" },
  { header: "Next action", get: (c) => c.score?.nextAction ?? "" },
  { header: "Summary", get: (c) => c.score?.summary ?? "" },
  { header: "Outreach status", get: (c) => c.outreach?.[0]?.status ?? "" },
  { header: "Last contact", get: (c) => c.outreach?.[0]?.lastContactDate ?? "" },
  { header: "Next follow-up", get: (c) => c.outreach?.[0]?.nextFollowUpDate ?? "" },
  { header: "Response", get: (c) => c.outreach?.[0]?.response ?? "" },
];

export function contactsToCsv(contacts: RadarContact[]): string {
  const head = EXPORT_COLUMNS.map((c) => csvCell(c.header)).join(",");
  const lines = contacts.map((c) => EXPORT_COLUMNS.map((col) => csvCell(col.get(c))).join(","));
  return [head, ...lines].join("\r\n");
}
