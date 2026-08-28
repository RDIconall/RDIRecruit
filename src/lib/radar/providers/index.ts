import "server-only";
import { hasApollo, hasSeamless } from "../../env";
import type { EnrichedContactDetails, RawContact, SearchCriteria } from "../types";
import { enrichApollo, searchApollo } from "./apollo";
import { enrichSeamless, searchSeamless } from "./seamless";

export { splitLocationTerms } from "./locations";

export interface ProviderResult {
  provider: string;
  configured: boolean;
  contacts: RawContact[];
  error?: string;
}

export interface ProviderStatus {
  seamless: boolean;
  apollo: boolean;
  any: boolean;
}

export function providerStatus(): ProviderStatus {
  const seamless = hasSeamless();
  const apollo = hasApollo();
  return { seamless, apollo, any: seamless || apollo };
}

/**
 * Query every configured people/contact provider for a search and return the
 * combined raw contacts. Each provider is independent and resilient: a missing
 * key or a failed call yields an empty list (with a flag), never a throw — so a
 * partial outage still returns whatever did come back.
 */
export async function runProviders(
  criteria: SearchCriteria,
  opts: { limit?: number } = {},
): Promise<{ results: ProviderResult[]; contacts: RawContact[] }> {
  const limit = opts.limit ?? 50;
  const results = await Promise.all([
    safe("Seamless.AI", hasSeamless(), () => searchSeamless(criteria, limit)),
    safe("Apollo", hasApollo(), () => searchApollo(criteria, limit)),
  ]);
  const contacts = results.flatMap((r) => r.contacts);
  return { results, contacts };
}

async function safe(
  provider: string,
  configured: boolean,
  fn: () => Promise<RawContact[]>,
): Promise<ProviderResult> {
  if (!configured) return { provider, configured: false, contacts: [] };
  try {
    const contacts = await fn();
    return { provider, configured: true, contacts };
  } catch (error) {
    return {
      provider,
      configured: true,
      contacts: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Which provider owns a stored contact, read off the `source` we recorded. */
export function providerOf(source: string | null | undefined): "seamless" | "apollo" | null {
  const s = (source ?? "").toLowerCase();
  if (s.includes("seamless")) return "seamless";
  if (s.includes("apollo")) return "apollo";
  return null;
}

export interface EnrichmentOutcome {
  details: EnrichedContactDetails[];
  errors: { provider: string; message: string }[];
}

/**
 * Run each provider's enrichment call for the refs that belong to it. Both
 * providers charge credits here, which is why this is a separate step from
 * search rather than part of it.
 */
export async function runEnrichment(targets: {
  seamless: string[];
  apollo: string[];
}): Promise<EnrichmentOutcome> {
  const details: EnrichedContactDetails[] = [];
  const errors: { provider: string; message: string }[] = [];

  if (hasSeamless() && targets.seamless.length) {
    try {
      details.push(...(await enrichSeamless(targets.seamless)));
    } catch (error) {
      errors.push({
        provider: "Seamless.AI",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (hasApollo() && targets.apollo.length) {
    try {
      details.push(...(await enrichApollo(targets.apollo)));
    } catch (error) {
      errors.push({
        provider: "Apollo",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { details, errors };
}
