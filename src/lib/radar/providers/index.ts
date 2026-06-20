import "server-only";
import { hasApollo, hasSeamless } from "../../env";
import type { RawContact, SearchCriteria } from "../types";
import { searchApollo } from "./apollo";
import { searchSeamless } from "./seamless";

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
