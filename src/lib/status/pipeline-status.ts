import { hasSupabase } from "../env";
import { getServiceSupabase } from "../supabase/server";
import { readSyncState } from "../sync/sync-state";
import { getEffectiveEpoch } from "../calibration/service";

export interface PipelineStatus {
  configured: boolean;
  scope: string; // job shortcode or "all"
  candidates: number; // cached in Supabase
  notPulled: number; // in Workable but not yet mirrored (from last full reconcile)
  reviewed: number; // candidates with at least one score
  pending: number; // candidates with no score yet
  stale: number; // scored before the active rubric/method epoch (queued to re-read)
  overrides: number; // reviewer-locked scores
  reviewedPct: number; // 0..100
  // Fit mix across reviewed candidates.
  strong: number; // total >= 85
  medium: number; // 55..84
  pass: number; // < 55
  lastSync: string | null; // ISO — most recent sync activity
  lastSyncLabel: string | null; // human "4m ago"
  syncSource: string | null; // which signal was most recent
}

function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

/**
 * A snapshot of where the pipeline stands: how fresh the Workable→Supabase sync is,
 * and how much of the pool Claude has reviewed (with what's stale / still pending).
 * Scoped to a job when given, else across all candidates.
 */
export async function getPipelineStatus(jobShortcode?: string | null): Promise<PipelineStatus> {
  const empty: PipelineStatus = {
    configured: false,
    scope: jobShortcode ?? "all",
    candidates: 0,
    notPulled: 0,
    reviewed: 0,
    pending: 0,
    stale: 0,
    overrides: 0,
    reviewedPct: 0,
    strong: 0,
    medium: 0,
    pass: 0,
    lastSync: null,
    lastSyncLabel: null,
    syncSource: null,
  };
  if (!hasSupabase()) return empty;

  const supabase = getServiceSupabase();

  // Candidate ids in scope.
  let candidateQuery = supabase.from("candidates").select("workable_id");
  if (jobShortcode) candidateQuery = candidateQuery.eq("job_shortcode", jobShortcode);
  const { data: candidateRows } = await candidateQuery;
  const candidateIds = (candidateRows ?? []).map((r) => r.workable_id as string);
  const candidates = candidateIds.length;

  // Latest score per candidate (created_at + model_version + total) for the scoped ids.
  const latest = new Map<string, { at: string; model: string | null; total: number | null }>();
  if (candidates) {
    // Chunk the IN clause to stay well under URL limits.
    for (let i = 0; i < candidateIds.length; i += 500) {
      const chunk = candidateIds.slice(i, i + 500);
      const { data: scoreRows } = await supabase
        .from("scores")
        .select("candidate_id, created_at, model_version, total")
        .in("candidate_id", chunk)
        .order("created_at", { ascending: false });
      for (const row of scoreRows ?? []) {
        const id = row.candidate_id as string;
        if (!latest.has(id)) {
          latest.set(id, {
            at: row.created_at as string,
            model: (row.model_version as string | null) ?? null,
            total: (row.total as number | null) ?? null,
          });
        }
      }
    }
  }

  const reviewed = latest.size;
  const pending = Math.max(0, candidates - reviewed);
  let overrides = 0;
  let strong = 0;
  let medium = 0;
  let pass = 0;
  for (const v of latest.values()) {
    if (v.model === "reviewer-override") overrides += 1;
    if (v.total == null) continue;
    if (v.total >= 85) strong += 1;
    else if (v.total >= 55) medium += 1;
    else pass += 1;
  }

  // Not-pulled: Workable's recorded total minus what we have cached (last reconcile).
  let notPulled = 0;
  if (jobShortcode) {
    const wb = await readSyncState<{ count: number | null }>(`workable_total:${jobShortcode}`, {
      count: null,
    });
    if (wb.count != null) notPulled = Math.max(0, wb.count - candidates);
  }

  // Stale = scored before the active epoch (and not a reviewer override).
  const epoch = jobShortcode ? await getEffectiveEpoch(jobShortcode) : await globalEpoch();
  let stale = 0;
  if (epoch) {
    const epochMs = new Date(epoch).getTime();
    for (const v of latest.values()) {
      if (v.model === "reviewer-override") continue;
      if (new Date(v.at).getTime() < epochMs) stale += 1;
    }
  }

  // Sync freshness — newest of the incremental / delta-scan signals.
  const [incremental, delta] = await Promise.all([
    readSyncState<{ at: string | null }>("last_incremental", { at: null }),
    readSyncState<{ at: string | null }>("last_delta_scan", { at: null }),
  ]);
  const signals: Array<{ at: string | null; source: string }> = [
    { at: incremental.at, source: "incremental sync" },
    { at: delta.at, source: "delta scan" },
  ];
  const newest = signals
    .filter((s) => s.at)
    .sort((a, b) => new Date(b.at!).getTime() - new Date(a.at!).getTime())[0];

  return {
    configured: true,
    scope: jobShortcode ?? "all",
    candidates,
    notPulled,
    reviewed,
    pending,
    stale,
    overrides,
    reviewedPct: candidates ? Math.round((reviewed / candidates) * 100) : 0,
    strong,
    medium,
    pass,
    lastSync: newest?.at ?? null,
    lastSyncLabel: relativeTime(newest?.at ?? null),
    syncSource: newest?.source ?? null,
  };
}

async function globalEpoch(): Promise<string | null> {
  const state = await readSyncState<{ at: string | null }>("scoring_epoch:global", { at: null });
  return state.at;
}
