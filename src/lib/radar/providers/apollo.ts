import "server-only";
import { env } from "../../env";
import type { EnrichedContactDetails, RawContact, SearchCriteria } from "../types";

// Apollo People Search + People Enrichment (https://docs.apollo.io/).
//
// IMPORTANT — search and contact details are two different endpoints:
//   - POST /mixed_people/api_search is the API-key search endpoint. It costs no
//     credits and DELIBERATELY returns no email and no phone. It also returns
//     `last_name_obfuscated` rather than a real surname.
//   - POST /people/bulk_match enriches up to 10 people per call, keyed on the
//     person `id` from search, and is what actually yields an email address.
// So `searchApollo` carries the person id through as `providerRef`, and
// `enrichApollo` completes the second call.
const APOLLO_BASE = "https://api.apollo.io/api/v1";

/** Search results: identity + employment availability flags, never contact details. */
interface ApolloSearchPerson {
  id?: string;
  name?: string;
  first_name?: string;
  last_name_obfuscated?: string;
  title?: string;
  linkedin_url?: string;
  city?: string;
  state?: string;
  country?: string;
  headline?: string;
  seniority?: string;
  has_email?: boolean;
  has_direct_phone?: boolean;
  organization?: { name?: string };
  account?: { name?: string };
}

/** Enrichment results: the full person record, including email. */
interface ApolloEnrichedPerson {
  id?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  email_status?: string;
  linkedin_url?: string;
  phone_numbers?: { raw_number?: string; sanitized_number?: string }[];
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

function headers(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
    "x-api-key": apiKey,
  };
}

/**
 * Step 1: find people. Returns identity + a `providerRef`; callers must run
 * `enrichApollo` to get an email.
 *
 * Surnames come back obfuscated from this endpoint, so we deliberately do NOT
 * build a `fullName` out of first + obfuscated last — a half-real name would
 * poison the dedupe key and merge different people together.
 */
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

  const res = await fetch(`${APOLLO_BASE}/mixed_people/api_search`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Apollo search failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { people?: ApolloSearchPerson[]; contacts?: ApolloSearchPerson[] };
  const people = [...(json.people ?? []), ...(json.contacts ?? [])];

  return people.slice(0, limit).map((p) => {
    const location = [p.city, p.state, p.country].filter(Boolean).join(", ") || null;
    return {
      // `name` is present and real when Apollo has it; the obfuscated surname is
      // never used to synthesise one.
      fullName: p.name ?? null,
      firstName: p.first_name ?? null,
      lastName: null,
      title: p.title ?? null,
      company: p.organization?.name ?? p.account?.name ?? null,
      location,
      linkedinUrl: p.linkedin_url ?? null,
      email: null,
      phone: null,
      profileSummary: [p.headline, p.seniority].filter(Boolean).join(" · ") || null,
      emailStatus: "unknown",
      source: "Apollo",
      providerRef: p.id ?? null,
      hasEmail: Boolean(p.has_email),
      raw: p as unknown as Record<string, unknown>,
    } satisfies RawContact;
  });
}

/**
 * Step 2: enrich people by id, ten at a time (the documented bulk limit).
 * Consumes Apollo credits, so callers must gate this behind an explicit action.
 */
export async function enrichApollo(providerRefs: string[]): Promise<EnrichedContactDetails[]> {
  const apiKey = env.APOLLO_API_KEY;
  const refs = providerRefs.filter(Boolean);
  if (!apiKey || !refs.length) return [];

  const details: EnrichedContactDetails[] = [];

  for (let i = 0; i < refs.length; i += 10) {
    const batch = refs.slice(i, i + 10);
    const res = await fetch(`${APOLLO_BASE}/people/bulk_match`, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify({
        reveal_personal_emails: true,
        details: batch.map((id) => ({ id })),
      }),
    });
    if (!res.ok) {
      throw new Error(`Apollo enrichment failed: ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as { matches?: (ApolloEnrichedPerson | null)[] };

    // Matches come back positionally, including nulls for records Apollo could
    // not resolve, so pair by index rather than trusting the returned id.
    (json.matches ?? []).forEach((match, idx) => {
      const providerRef = batch[idx];
      if (!providerRef || !match) return;
      const phone = match.phone_numbers?.find((p) => p.sanitized_number || p.raw_number);
      details.push({
        providerRef,
        email: match.email ?? null,
        phone: phone?.sanitized_number ?? phone?.raw_number ?? null,
        fullName: match.name ?? null,
        firstName: match.first_name ?? null,
        lastName: match.last_name ?? null,
        linkedinUrl: match.linkedin_url ?? null,
        emailStatus: emailStatus(match.email_status),
        raw: match as unknown as Record<string, unknown>,
      });
    });
  }

  return details;
}
