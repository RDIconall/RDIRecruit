import type { EmailStatus, RawContact } from "./types";

function clean(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function linkedinSlug(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Stable dedupe key for a person across sources. Email wins (most reliable),
 * then LinkedIn slug, then a name|company fallback. Used by the unique index on
 * radar_contacts so re-imports merge instead of duplicating.
 */
export function dedupeKey(c: { email?: string | null; linkedinUrl?: string | null; fullName?: string | null; firstName?: string | null; lastName?: string | null; company?: string | null }): string | null {
  const email = clean(c.email)?.toLowerCase();
  if (email) return `email:${email}`;
  const slug = linkedinSlug(clean(c.linkedinUrl));
  if (slug) return `li:${slug}`;
  const name = clean(c.fullName) || [clean(c.firstName), clean(c.lastName)].filter(Boolean).join(" ");
  const company = clean(c.company);
  if (name && company) return `nc:${name.toLowerCase()}|${company.toLowerCase()}`;
  return null;
}

function splitName(full: string | null, first: string | null, last: string | null) {
  if (first || last) {
    const fn = clean(first);
    const ln = clean(last);
    return { fullName: [fn, ln].filter(Boolean).join(" ") || clean(full), firstName: fn, lastName: ln };
  }
  const f = clean(full);
  if (!f) return { fullName: null, firstName: null, lastName: null };
  const parts = f.split(/\s+/);
  return { fullName: f, firstName: parts[0] ?? null, lastName: parts.length > 1 ? parts.slice(1).join(" ") : null };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function guessEmailStatus(email: string | null, provided?: EmailStatus): EmailStatus {
  if (provided && provided !== "unknown") return provided;
  if (!email) return "unknown";
  return EMAIL_RE.test(email) ? "valid" : "risky";
}

export interface NormalizedContact {
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
  raw: Record<string, unknown>;
  dedupeKey: string | null;
}

export function normalizeContact(raw: RawContact): NormalizedContact {
  const name = splitName(raw.fullName ?? null, raw.firstName ?? null, raw.lastName ?? null);
  const email = clean(raw.email)?.toLowerCase() ?? null;
  const linkedinUrl = clean(raw.linkedinUrl);
  const base = {
    ...name,
    title: clean(raw.title),
    company: clean(raw.company),
    location: clean(raw.location),
    linkedinUrl,
    email,
    phone: clean(raw.phone),
    source: clean(raw.source) || "Manual",
    profileSummary: clean(raw.profileSummary),
    emailStatus: guessEmailStatus(email, raw.emailStatus),
    raw: raw.raw ?? {},
  };
  return { ...base, dedupeKey: dedupeKey({ ...base }) };
}
