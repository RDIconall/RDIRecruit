import "server-only";
import { env } from "../../env";
import type { RawContact, SearchCriteria } from "../types";

// Seamless.AI contact search. API-key auth uses the `Token` header against the
// public client API; OAuth uses Bearer, but this app stores an API key.
const SEAMLESS_BASE = process.env.SEAMLESS_API_BASE ?? "https://api.seamless.ai/api/client/v1";

interface SeamlessContact {
  name?: string;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  seniority?: string;
  department?: string;
  companyName?: string;
  company?: string;
  companyDomain?: string;
  location?: string;
  city?: string;
  state?: string;
  country?: string;
  liUrl?: string;
  linkedInUrl?: string;
  linkedinUrl?: string;
  email?: string;
  emailStatus?: string;
  email_status?: string;
  phone?: string;
  phoneNumber?: string;
  searchResultId?: string;
}

function emailStatus(s?: string): RawContact["emailStatus"] {
  const v = (s ?? "").toLowerCase();
  if (v.includes("valid") || v.includes("verified")) return "valid";
  if (v.includes("risk") || v.includes("catchall")) return "risky";
  if (v.includes("invalid") || v.includes("bounce")) return "invalid";
  return "unknown";
}

export async function searchSeamless(criteria: SearchCriteria, limit: number): Promise<RawContact[]> {
  const apiKey = env.SEAMLESS_API_KEY;
  if (!apiKey) return [];

  const body: Record<string, unknown> = {
    limit: Math.min(100, Math.max(1, limit)),
    locationType: "bothOR",
  };
  if (criteria.titles.length) body.jobTitle = criteria.titles.slice(0, 10);
  if (criteria.keywords.length) body.contactKeyword = criteria.keywords.slice(0, 10);
  if (criteria.companies.length) {
    body.companyName = criteria.companies.slice(0, 100);
    body.companyNameSearchType = "related";
  }
  if (criteria.locations.length) body.contactCountry = criteria.locations;

  const res = await fetch(`${SEAMLESS_BASE}/search/contacts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Token: apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Seamless search failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { contacts?: SeamlessContact[]; data?: SeamlessContact[] };
  const contacts = json.contacts ?? json.data ?? [];

  return contacts.slice(0, limit).map((c) => {
    const location = c.location ?? ([c.city, c.state, c.country].filter(Boolean).join(", ") || null);
    return {
      fullName: c.fullName ?? c.name ?? ([c.firstName, c.lastName].filter(Boolean).join(" ") || null),
      firstName: c.firstName ?? null,
      lastName: c.lastName ?? null,
      title: c.title ?? null,
      company: c.companyName ?? c.company ?? null,
      location,
      linkedinUrl: c.liUrl ?? c.linkedInUrl ?? c.linkedinUrl ?? null,
      email: c.email ?? null,
      phone: c.phone ?? c.phoneNumber ?? null,
      profileSummary: [c.seniority, c.department].filter(Boolean).join(" - ") || null,
      emailStatus: emailStatus(c.emailStatus ?? c.email_status),
      source: "Seamless.AI",
      raw: c as unknown as Record<string, unknown>,
    } satisfies RawContact;
  });
}
