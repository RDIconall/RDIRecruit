import "server-only";
import { env } from "../../env";
import type { RawContact, SearchCriteria } from "../types";

// Seamless.AI contact search. Seamless's public API surface varies by plan; we
// target the documented contact search endpoint and degrade gracefully. The key
// is server-side only. Endpoint is overridable via SEAMLESS_API_BASE if needed.
const SEAMLESS_BASE = process.env.SEAMLESS_API_BASE ?? "https://api.seamless.ai/v1";

interface SeamlessContact {
  fullName?: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  companyName?: string;
  company?: string;
  location?: string;
  city?: string;
  state?: string;
  linkedInUrl?: string;
  linkedinUrl?: string;
  email?: string;
  emailStatus?: string;
  phone?: string;
  phoneNumber?: string;
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
    titles: criteria.titles,
    keywords: criteria.keywords,
    companies: criteria.companies,
    locations: criteria.locations,
  };

  const res = await fetch(`${SEAMLESS_BASE}/contacts/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Seamless search failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { contacts?: SeamlessContact[]; data?: SeamlessContact[] };
  const contacts = json.contacts ?? json.data ?? [];

  return contacts.slice(0, limit).map((c) => {
    const location = c.location ?? ([c.city, c.state].filter(Boolean).join(", ") || null);
    return {
      fullName: c.fullName ?? ([c.firstName, c.lastName].filter(Boolean).join(" ") || null),
      firstName: c.firstName ?? null,
      lastName: c.lastName ?? null,
      title: c.title ?? null,
      company: c.companyName ?? c.company ?? null,
      location,
      linkedinUrl: c.linkedInUrl ?? c.linkedinUrl ?? null,
      email: c.email ?? null,
      phone: c.phone ?? c.phoneNumber ?? null,
      profileSummary: null,
      emailStatus: emailStatus(c.emailStatus),
      source: "Seamless.AI",
      raw: c as unknown as Record<string, unknown>,
    } satisfies RawContact;
  });
}
