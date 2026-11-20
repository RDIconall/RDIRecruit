import { listStages, type WorkableStage } from "./client";

// Pipeline stages change rarely, but page views and stage moves ask for them
// constantly; every uncached read spends the account's shared Workable quota.
const STAGES_TTL_MS = 5 * 60_000;
const FAILED_STAGES_TTL_MS = 30_000;
const MAX_CACHED_JOBS = 200;

type Entry = { expiresAt: number; stages: Promise<WorkableStage[]> };
const cache = new Map<string, Entry>();

/**
 * Stage list for a stored job, shared across concurrent callers and reused for a
 * few minutes. A failed fetch is also remembered briefly so a Workable outage or
 * a 404 does not turn every view into another request.
 */
export function getJobStages(shortcode: string): Promise<WorkableStage[]> {
  const now = Date.now();
  const hit = cache.get(shortcode);
  if (hit && hit.expiresAt > now) return hit.stages;

  const entry: Entry = { expiresAt: now + STAGES_TTL_MS, stages: listStages(shortcode) };
  entry.stages.catch(() => {
    entry.expiresAt = Date.now() + FAILED_STAGES_TTL_MS;
  });
  cache.delete(shortcode);
  if (cache.size >= MAX_CACHED_JOBS) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(shortcode, entry);
  return entry.stages;
}
