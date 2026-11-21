import { mock } from "node:test";
import { MemorySupabase } from "./memory-supabase";

export const memory = new MemorySupabase();

let installed = false;

export function installMocks(): void {
  if (installed) return;
  installed = true;
  mock.module("server-only", { namedExports: {} });
  mock.module("@/lib/supabase/server", {
    namedExports: {
      getServiceSupabase: () => memory,
      getAnonSupabase: () => memory,
    },
  });
}

export type IngestApp = Awaited<ReturnType<typeof loadIngestApp>>;

export async function loadIngestApp() {
  installMocks();
  const fireflies = await import("@/app/api/ingest/fireflies/route");
  const videoask = await import("@/app/api/hooks/videoask/route");
  const triage = await import("@/lib/triage/load");
  const middlewareMod = await import("@/middleware");
  return {
    postFireflies: fireflies.POST,
    postVideoask: videoask.POST,
    loadTriagePool: triage.loadTriagePool,
    loadOneCandidate: triage.loadOneCandidate,
    middleware: middlewareMod.default,
  };
}
