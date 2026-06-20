import "server-only";
import { hasAnthropic, hasSupabase } from "../env";
import { providerStatus } from "./providers";
import { getActiveScorecard, listSearches, loadContacts } from "./store";
import type { Pipeline, RadarContact, RadarSearch } from "./types";

export interface RadarData {
  pipeline: Pipeline;
  configured: boolean; // Supabase configured (the app needs it to persist)
  hasLlm: boolean;
  providers: { seamless: boolean; apollo: boolean; any: boolean };
  searches: RadarSearch[];
  contacts: RadarContact[];
  scorecard: { name: string; content: string };
  searchId: string | null;
}

export async function loadRadar(opts: {
  pipeline: Pipeline;
  searchId?: string | null;
}): Promise<RadarData> {
  const base: Omit<RadarData, "searches" | "contacts" | "scorecard"> = {
    pipeline: opts.pipeline,
    configured: hasSupabase(),
    hasLlm: hasAnthropic(),
    providers: providerStatus(),
    searchId: opts.searchId ?? null,
  };

  if (!base.configured) {
    return {
      ...base,
      searches: [],
      contacts: [],
      scorecard: { name: "RDI scorecard", content: "" },
    };
  }

  const [searches, contacts, scorecard] = await Promise.all([
    listSearches(opts.pipeline),
    loadContacts({ pipeline: opts.pipeline, searchId: opts.searchId ?? null }),
    getActiveScorecard(opts.pipeline),
  ]);

  return { ...base, searches, contacts, scorecard };
}
