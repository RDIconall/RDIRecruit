import "server-only";
import { env } from "../../env";
import type { RawContact, SearchCriteria } from "../types";

// Apollo People Search (https://docs.apollo.io/). We use the documented
// people search + mixed_people/search endpoint. The key is read server-side
// only; results are normalized into RawContact for the shared pipeline.
const APOLLO_BASE = "https://api.apollo.io/api/v1";

interface ApolloPerson {
  name?: string;
  first_name?: string;
  last_name?: string;
  title?: string;
  linkedin_url?: string;
  email?: string;
  email_status?: string;
  city?: string;
  state?: string;
  country?: string;
  headline?: string;
  organization?: { name?: string };
  account?: { name?: string };
}

function emailStatus(s?: string): RawContact["emailStatus"] {
  switch ((s ?? "").toLowerCase()) {
    case "verified":
      return "valid";
    case "guessed":
    case "unavailable":
      return "risky";
    default:
      return "unknown";
  }
}

export async function searchApollo(criteria: SearchCriteria, limit: number): Promise<RawContact[]> {
  const apiKey = env.APOLLO_API_KEY;
  if (!apiKey) return [];

  const perPage = Math.min(100, Math.max(1, limit));
  const body: Record<string, unknown> = {
    page: 1,
    per_page: perPage,
  };
  if (criteria.titles.length) body.person_titles = criteria.titles;
  if (criteria.locations.length) body.person_locations = criteria.locations;
  if (criteria.companies.length) body.q_organization_names = criteria.companies;
  if (criteria.keywords.length) body.q_keywords = criteria.keywords.join(" ");

  const res = await fetch(`${APOLLO_BASE}/mixed_people/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Apollo search failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { people?: ApolloPerson[]; contacts?: ApolloPerson[] };
  const people = [...(json.people ?? []), ...(json.contacts ?? [])];

  return people.slice(0, limit).map((p) => {
    const location = [p.city, p.state, p.country].filter(Boolean).join(", ") || null;
    return {
      fullName: p.name ?? ([p.first_name, p.last_name].filter(Boolean).join(" ") || null),
      firstName: p.first_name ?? null,
      lastName: p.last_name ?? null,
      title: p.title ?? null,
      company: p.organization?.name ?? p.account?.name ?? null,
      location,
      linkedinUrl: p.linkedin_url ?? null,
      email: p.email ?? null,
      phone: null,
      profileSummary: p.headline ?? null,
      emailStatus: emailStatus(p.email_status),
      source: "Apollo",
      raw: p as unknown as Record<string, unknown>,
    } satisfies RawContact;
  });
}
