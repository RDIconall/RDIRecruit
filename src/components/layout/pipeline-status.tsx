import { getPipelineStatus } from "@/lib/status/pipeline-status";

/** "Where things stand" bar: Workable sync gap · Claude review · fit mix. */
export async function PipelineStatus({ jobShortcode }: { jobShortcode?: string | null }) {
  const status = await getPipelineStatus(jobShortcode);
  if (!status.configured) return null;

  const freshMins = status.lastSync
    ? (Date.now() - new Date(status.lastSync).getTime()) / 60000
    : Infinity;
  const dot = freshMins < 15 ? "bg-emerald-500" : freshMins < 120 ? "bg-amber-500" : "bg-navy/30";

  return (
    <div className="mx-auto max-w-[1320px] px-6 pt-5">
      <div className="grid gap-x-8 gap-y-4 rounded-xl border border-navy/10 bg-white px-5 py-4 md:grid-cols-3">
        {/* 1 — Workable sync */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${dot}`} />
            <span className="text-[13px] font-semibold uppercase tracking-wide text-navy/55">
              Workable sync
            </span>
          </div>
          <div className="text-[15px]">
            {status.lastSyncLabel ? `Synced ${status.lastSyncLabel}` : "No sync yet"}
          </div>
          <div className="text-[13px] text-navy/60">
            {status.candidates} cached
            {status.notPulled > 0 ? (
              <>
                {" · "}
                <span className="font-medium text-amber-600">{status.notPulled} not pulled</span>
              </>
            ) : (
              <span className="text-navy/45"> · all pulled</span>
            )}
          </div>
        </div>

        {/* 2 — Claude review */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-semibold uppercase tracking-wide text-navy/55">
              Claude review
            </span>
            <span className="font-mono text-[13px] text-navy/60">
              {status.reviewed}/{status.candidates}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-navy/10">
            <div
              className="h-full rounded-full bg-orange transition-all"
              style={{ width: `${status.reviewedPct}%` }}
            />
          </div>
          <div className="flex flex-wrap gap-x-3 text-[13px] text-navy/60">
            {status.pending > 0 ? (
              <span>
                <span className="font-mono font-medium text-navy/80">{status.pending}</span> to review
              </span>
            ) : (
              <span className="text-emerald-600">all reviewed</span>
            )}
            {status.stale > 0 ? (
              <span title="Scored before the latest rubric/method change — re-reads on next sync">
                <span className="font-mono font-medium text-amber-600">{status.stale}</span> stale
              </span>
            ) : null}
            {status.overrides > 0 ? (
              <span title="Reviewer-locked scores — protected from auto re-scoring">
                <span className="font-mono font-medium text-navy/80">{status.overrides}</span> locked
              </span>
            ) : null}
          </div>
        </div>

        {/* 3 — Fit mix */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-semibold uppercase tracking-wide text-navy/55">
            Fit mix
          </span>
          <div className="flex items-center gap-4">
            <FitStat label="Strong" value={status.strong} color="#15803d" hint="≥ 85" />
            <FitStat label="Medium" value={status.medium} color="#b45309" hint="55–84" />
            <FitStat label="Pass" value={status.pass} color="#b91c1c" hint="< 55" />
          </div>
          {status.reviewed > 0 ? (
            <div className="flex h-2 overflow-hidden rounded-full bg-navy/10">
              <Seg value={status.strong} total={status.reviewed} color="#15803d" />
              <Seg value={status.medium} total={status.reviewed} color="#d97706" />
              <Seg value={status.pass} total={status.reviewed} color="#dc2626" />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FitStat({
  label,
  value,
  color,
  hint,
}: {
  label: string;
  value: number;
  color: string;
  hint: string;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="font-mono text-[18px] font-semibold leading-none" style={{ color }}>
        {value}
      </span>
      <span className="text-[13px] text-navy/65">{label}</span>
      <span className="font-mono text-[11px] text-navy/35">{hint}</span>
    </div>
  );
}

function Seg({ value, total, color }: { value: number; total: number; color: string }) {
  if (value <= 0) return null;
  return <div className="h-full" style={{ width: `${(value / total) * 100}%`, background: color }} />;
}
