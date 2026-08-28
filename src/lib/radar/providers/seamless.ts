import "server-only";
import { env } from "../../env";
import type { EnrichedContactDetails, RawContact, SearchCriteria } from "../types";
import { splitLocationTerms } from "./locations";

// Seamless.AI public client API. Auth is an API key in a `Token` header.
//
// IMPORTANT — this is a THREE-step API, not one call:
//   1. POST /search/contacts        → records with a `searchResultId`, NO email
//   2. POST /contacts/research      → 202 + `requestIds` (async, spends credits)
//   3. GET  /contacts/research/poll → `status: done` carries the contact details
// Search alone can never yield an email address, so `searchSeamless` returns the
// `searchResultId` as `providerRef` and `enrichSeamless` completes steps 2 and 3.
// Docs: https://docs.seamless.ai/authenticate-and-make-your-first-request
const SEAMLESS_BASE = process.env.SEAMLESS_API_BASE ?? "https://api.seamless.ai/api/client/v1";

/** Search results carry identity + employment only — never contact details. */
interface SeamlessSearchContact {
  searchResultId?: string;
  name?: string;
  firstName?: string;
  middleName?: string;
  lastName?: string;
  title?: string;
  seniority?: string;
  department?: string;
  company?: string;
  domain?: string;
  city?: string;
  state?: string;
  country?: string;
  liUrl?: string;
  timeAtRole?: string;
  timeAtCompany?: string;
  industries?: string[];
}

/** The researched record from the poll endpoint — this is where email lives. */
interface SeamlessResearchedContact {
  apiResearchId?: string;
  emails?: string;
  email?: string;
  phones?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  linkedInProfileUrl?: string;
  liUrl?: string;
}

interface SeamlessPollRow {
  requestId?: string;
  status?: "researching" | "done" | "missing" | "error" | "duplicate";
  message?: string;
  contact?: SeamlessResearchedContact;
}

function headers(apiKey: string): Record<string, string> {
  return { "Content-Type": "application/json", Token: apiKey };
}

/** Seamless returns comma-joined multi-values; take the first non-empty one. */
function firstOf(value: string | undefined): string | null {
  if (!value) return null;
  const first = value
    .split(",")
    .map((v) => v.trim())
    .find(Boolean);
  return first ?? null;
}

function profileSummaryFor(c: SeamlessSearchContact): string | null {
  return (
    [
      c.seniority,
      c.department,
      c.timeAtRole ? `${c.timeAtRole} in role` : null,
      c.timeAtCompany ? `${c.timeAtCompany} at company` : null,
      c.industries?.length ? c.industries.slice(0, 3).join(", ") : null,
    ]
      .filter(Boolean)
      .join(" · ") || null
  );
}

/**
 * Step 1: find candidate records. Returns identity + employment and a
 * `providerRef`; callers must run `enrichSeamless` to get an email.
 *
 * `locationType` is set to "contact" so we match where the PERSON lives, not
 * where their employer is headquartered — the default "bothOR" would return
 * someone living anywhere whose company happens to have an LA office, which is
 * useless for an on-site seat.
 */
export async function searchSeamless(criteria: SearchCriteria, limit: number): Promise<RawContact[]> {
  const apiKey = env.SEAMLESS_API_KEY;
  if (!apiKey) return [];

  const body: Record<string, unknown> = {
    limit: Math.min(100, Math.max(1, limit)),
    locationType: "contact",
  };
  if (criteria.titles.length) body.jobTitle = criteria.titles.slice(0, 10);
  if (criteria.keywords.length) body.contactKeyword = criteria.keywords.slice(0, 10);
  if (criteria.companies.length) {
    body.companyName = criteria.companies.slice(0, 100);
    body.companyNameSearchType = "related";
  }

  // Seamless has no city filter — only state, country, and zip. Sending a city
  // name in `contactCountry` (the previous behaviour) matches nothing.
  const loc = splitLocationTerms(criteria.locations);
  if (loc.countries.length) body.contactCountry = loc.countries.slice(0, 10);
  if (loc.states.length) body.contactState = loc.states.slice(0, 10);
  if (loc.zips.length) body.contactZipCode = loc.zips.slice(0, 10);

  const res = await fetch(`${SEAMLESS_BASE}/search/contacts`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Seamless search failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { data?: SeamlessSearchContact[]; contacts?: SeamlessSearchContact[] };
  const contacts = json.data ?? json.contacts ?? [];

  return contacts.slice(0, limit).map((c) => {
    const location = [c.city, c.state, c.country].filter(Boolean).join(", ") || null;
    return {
      fullName: c.name ?? ([c.firstName, c.lastName].filter(Boolean).join(" ") || null),
      firstName: c.firstName ?? null,
      lastName: c.lastName ?? null,
      title: c.title ?? null,
      company: c.company ?? null,
      location,
      linkedinUrl: c.liUrl ?? null,
      // Search never returns contact details; enrichment fills these in.
      email: null,
      phone: null,
      profileSummary: profileSummaryFor(c),
      emailStatus: "unknown",
      source: "Seamless.AI",
      providerRef: c.searchResultId ?? null,
      raw: c as unknown as Record<string, unknown>,
    } satisfies RawContact;
  });
}

/**
 * Steps 2 and 3: submit the refs for research, then poll until each one is
 * terminal. Spends Seamless research credits, so callers must gate this behind
 * an explicit action rather than running it on every search.
 */
export async function enrichSeamless(
  providerRefs: string[],
  opts: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<EnrichedContactDetails[]> {
  const apiKey = env.SEAMLESS_API_KEY;
  const refs = providerRefs.filter(Boolean).slice(0, 100);
  if (!apiKey || !refs.length) return [];

  const submitted = await fetch(`${SEAMLESS_BASE}/contacts/research`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify({ searchResultIds: refs }),
  });
  if (!submitted.ok) {
    throw new Error(`Seamless research failed: ${submitted.status} ${submitted.statusText}`);
  }
  const { requestIds } = (await submitted.json()) as { requestIds?: string[] };
  const pending = (requestIds ?? []).filter(Boolean);
  if (!pending.length) return [];

  // The request ids come back positionally, so pair them with the refs we sent.
  const refByRequestId = new Map(pending.map((id, idx) => [id, refs[idx] ?? id]));

  const timeoutMs = opts.timeoutMs ?? 45_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 3_000;
  const startedAt = Date.now();
  const outstanding = new Set(pending);
  const details: EnrichedContactDetails[] = [];

  while (outstanding.size && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    const query = new URLSearchParams({ requestIds: Array.from(outstanding).join(",") });
    const polled = await fetch(`${SEAMLESS_BASE}/contacts/research/poll?${query}`, {
      headers: { Token: apiKey },
    });
    if (!polled.ok) {
      throw new Error(`Seamless poll failed: ${polled.status} ${polled.statusText}`);
    }
    const { data } = (await polled.json()) as { data?: SeamlessPollRow[] };

    for (const row of data ?? []) {
      const requestId = row.requestId;
      if (!requestId || !outstanding.has(requestId)) continue;
      if (row.status === "researching") continue;

      outstanding.delete(requestId);
      const providerRef = refByRequestId.get(requestId);
      // "missing" and "error" are terminal with no payload — stop waiting on them.
      if (!providerRef || !row.contact) continue;

      const email = firstOf(row.contact.emails ?? row.contact.email ?? undefined);
      details.push({
        providerRef,
        email,
        phone: firstOf(row.contact.phones ?? row.contact.phone ?? undefined),
        fullName: row.contact.name ?? null,
        firstName: row.contact.firstName ?? null,
        lastName: row.contact.lastName ?? null,
        linkedinUrl: row.contact.linkedInProfileUrl ?? row.contact.liUrl ?? null,
        emailStatus: email ? "valid" : "unknown",
        raw: row.contact as unknown as Record<string, unknown>,
      });
    }
  }

  return details;
}
