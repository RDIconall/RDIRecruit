"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { bulkCandidateAction } from "@/app/actions/candidates";
import {
  activeTierCount,
  boardStats,
  categoryLine,
  categorySegments,
  confidenceColor,
  rubricWeightsLine,
  salaryColor,
  tierKeyFromTotal,
  TIER_META,
  trajectoryMeta,
} from "@/lib/board/format";
import { isNewCandidate } from "@/lib/data/board";
import { candidatePath, jobBoardPath } from "@/lib/routes";
import type { CategoryKey } from "@/lib/types";
import { FormattedText } from "@/components/ui/formatted-text";
import type { JobSummary } from "@/lib/jobs/service";
import type { BoardCandidate } from "@/lib/types";

function isActive(item: BoardCandidate) {
  if (item.overlay?.status === "withdrawn" || item.overlay?.status === "disqualified") return false;
  return !item.candidate.disqualified;
}

function inactiveLabel(item: BoardCandidate) {
  if (item.overlay?.status === "withdrawn") return "withdrawn";
  if (item.overlay?.status === "disqualified" || item.candidate.disqualified) return "disqualified";
  return null;
}

type LayoutMode = "ledger" | "evidence" | "tiers";
type TierFilter = "all" | "strong" | "viable" | "hold" | "low" | "new";

function splitTitle(title: string): { head: string; tail: string } {
  const comma = title.indexOf(",");
  if (comma >= 0 && comma < title.length - 1) {
    return { head: title.slice(0, comma + 1), tail: `${title.slice(comma + 1).trim()}.` };
  }
  const words = title.trim().split(/\s+/);
  if (words.length > 1) {
    return { head: words.slice(0, -1).join(" "), tail: `${words.at(-1)}.` };
  }
  return { head: title, tail: "pipeline." };
}

/** The owner column shows who acts on the candidate; opaque Clerk ids are hidden. */
function ownerLabel(assignee: string | null | undefined): string {
  if (!assignee || assignee.startsWith("user_")) return "—";
  return assignee;
}

/**
 * The job title doubles as the requisition switcher: it reads as the page heading
 * but opens a picker on click. Replaces the old standalone <select> in the header
 * so the job name appears exactly once, and the picker shows full (un-truncated)
 * names so long requisition titles stay legible.
 */
function JobTitleSwitcher({
  jobs,
  activeShortcode,
  title,
}: {
  jobs: JobSummary[];
  activeShortcode: string;
  title: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const switchable = jobs.length > 1;
  const { head, tail } = splitTitle(title);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function pick(shortcode: string) {
    setOpen(false);
    if (shortcode === activeShortcode) return;
    router.push(jobBoardPath(shortcode));
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => switchable && setOpen((v) => !v)}
        aria-haspopup={switchable ? "listbox" : undefined}
        aria-expanded={switchable ? open : undefined}
        className={`group flex max-w-full items-center gap-2.5 text-left ${
          switchable ? "cursor-pointer" : "cursor-default"
        }`}
      >
        <h1 className="text-[30px] leading-[1.05] font-semibold tracking-tight">
          {head}{" "}
          <span className="font-serif italic font-normal text-orange">{tail}</span>
        </h1>
        {switchable ? (
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            className={`mt-1 shrink-0 text-navy/35 transition-transform group-hover:text-navy/70 ${
              open ? "rotate-180" : ""
            }`}
            aria-hidden="true"
          >
            <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : null}
      </button>

      {open && switchable ? (
        <div
          role="listbox"
          className="absolute left-0 top-[calc(100%+8px)] z-50 w-[clamp(280px,32vw,440px)] overflow-hidden rounded-xl border border-navy/15 bg-white py-1.5 shadow-[0_18px_44px_-18px_rgba(22,35,53,0.45)]"
        >
          <div className="px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-wide text-navy/40">
            Switch requisition
          </div>
          {jobs.map((job) => {
            const active = job.shortcode === activeShortcode;
            const meta = [job.department, job.location].filter(Boolean).join(" · ");
            return (
              <button
                key={job.shortcode}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => pick(job.shortcode)}
                className={`flex w-full items-start gap-2.5 px-3.5 py-2 text-left transition hover:bg-cream ${
                  active ? "bg-cream/60" : ""
                }`}
              >
                <span
                  className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                    active ? "bg-orange" : "bg-transparent"
                  }`}
                />
                <span className="min-w-0">
                  <span className={`block text-[14px] leading-snug ${active ? "font-semibold text-navy" : "text-navy/85"}`}>
                    {job.title}
                  </span>
                  {meta ? <span className="mt-0.5 block text-[12px] text-navy/50">{meta}</span> : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function BoardClient({
  items,
  jobs = [],
  jobShortcode,
  jobTitle,
  seatStratum = "IIb–IIa",
  boardSummary,
  initialTier,
  rubricWeights,
}: {
  items: BoardCandidate[];
  jobs?: JobSummary[];
  jobShortcode: string;
  jobTitle: string;
  seatStratum?: string;
  boardSummary?: string | null;
  initialTier?: string;
  rubricWeights?: Record<CategoryKey, number>;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [layout, setLayout] = useState<LayoutMode>("ledger");
  const [tier, setTier] = useState<TierFilter>((initialTier as TierFilter) ?? "all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();

  const stats = useMemo(() => boardStats(items), [items]);

  const ranked = useMemo(
    () => [...items].sort((a, b) => (b.score?.total ?? -1) - (a.score?.total ?? -1)),
    [items],
  );

  const visible = useMemo(() => {
    let list = ranked;
    if (tier === "new") {
      list = list.filter((c) => isNewCandidate(c.candidate.created_at) && isActive(c));
    } else if (tier !== "all") {
      list = list.filter((c) => tierKeyFromTotal(c.score?.total) === tier && isActive(c));
    }
    return list;
  }, [ranked, tier]);

  function setTierFilter(next: TierFilter) {
    setTier(next);
    const params = new URLSearchParams(searchParams.toString());
    params.set("job", jobShortcode);
    if (next === "all") params.delete("tier");
    else params.set("tier", next);
    const path = next === "all" ? jobBoardPath(jobShortcode) : jobBoardPath(jobShortcode, next);
    router.replace(path);
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function runBulk(action: "advance" | "hold" | "deny") {
    startTransition(async () => {
      await bulkCandidateAction({ jobShortcode, candidateIds: [...selected], action });
      setSelected(new Set());
      router.refresh();
    });
  }

  const chips: Array<{ key: TierFilter; label: string; count: number }> = [
    { key: "all", label: "All", count: stats.active },
    { key: "strong", label: "Strong", count: stats.strong },
    { key: "viable", label: "Consider", count: activeTierCount(items, "viable") },
    { key: "hold", label: "Hold", count: activeTierCount(items, "hold") },
    { key: "low", label: "Deny", count: activeTierCount(items, "low") },
    { key: "new", label: "New", count: stats.new },
  ];

  return (
    <div className="mx-auto max-w-[1320px] px-6 pb-20 pt-8">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-5">
        <div className="min-w-0">
          <JobTitleSwitcher jobs={jobs} activeShortcode={jobShortcode} title={jobTitle} />
          <p className="mt-2 flex flex-wrap items-center gap-3.5 font-mono text-xs text-navy/70">
            <span>{jobShortcode}</span>
            <span className="text-navy/25">·</span>
            <span>{stats.active} live</span>
            <span className="text-navy/25">·</span>
            <span className="text-emerald-700">{stats.strong} strong</span>
            <span className="text-navy/25">·</span>
            <span className="text-orange">{stats.new} new</span>
            {stats.out > 0 ? (
              <>
                <span className="text-navy/25">·</span>
                <span className="text-navy/50">{stats.out} out</span>
              </>
            ) : null}
            <span className="text-navy/25">·</span>
            <span>seat {seatStratum}</span>
          </p>
        </div>
        {rubricWeights ? (
          <p className="text-right text-xs text-navy/55">{rubricWeightsLine(rubricWeights)}</p>
        ) : null}
      </div>

      <div className="mt-6 border-l-2 border-navy pl-4">
        {boardSummary ? (
          <FormattedText
            text={boardSummary}
            className="max-w-[820px] text-sm leading-relaxed text-navy/82"
          />
        ) : (
          <p className="max-w-[820px] text-sm leading-relaxed text-navy/82">
            Ranked by fit score. Strong candidates surface to the top; use tier filters and bulk
            actions to move the pipeline in Workable.
          </p>
        )}
      </div>

      <div className="mt-7 flex flex-wrap items-center justify-between gap-4 border-b border-navy/15 pb-3">
        <div className="flex flex-wrap items-center gap-4">
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={() => setTierFilter(chip.key)}
              className="flex items-center gap-1.5 border-b-2 pb-1 text-[14px] font-medium transition"
              style={{
                color: tier === chip.key ? "#162335" : "rgba(22,35,53,0.55)",
                borderColor: tier === chip.key ? "#162335" : "transparent",
              }}
            >
              {chip.label}
              <span className="font-mono text-[12px] opacity-50">{chip.count}</span>
            </button>
          ))}
        </div>
        <div className="flex overflow-hidden rounded-md border border-navy/18">
          {(["ledger", "evidence", "tiers"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setLayout(mode)}
              className="px-3 py-1.5 text-xs font-medium capitalize"
              style={{
                background: layout === mode ? "#162335" : "#fff",
                color: layout === mode ? "#FAFAF7" : "rgba(22,35,53,0.7)",
                borderLeft: mode !== "ledger" ? "1px solid rgba(22,35,53,0.18)" : undefined,
              }}
            >
              {mode === "ledger" ? "Ledger" : mode === "evidence" ? "Evidence" : "Tiers"}
            </button>
          ))}
        </div>
      </div>

      {selected.size > 0 ? (
        <div className="mt-3.5 flex items-center gap-3.5 rounded-md bg-navy px-4 py-2.5 text-cream">
          <span className="font-mono text-xs">{selected.size} selected</span>
          <div className="h-[18px] w-px bg-cream/25" />
          <BulkBtn disabled={pending} onClick={() => runBulk("advance")} primary>
            Advance to async
          </BulkBtn>
          <BulkBtn disabled={pending} onClick={() => runBulk("hold")}>
            Hold
          </BulkBtn>
          <BulkBtn disabled={pending} onClick={() => runBulk("deny")}>
            Disqualify
          </BulkBtn>
          <div className="flex-1" />
          <button type="button" onClick={() => setSelected(new Set())} className="text-xs text-cream/60">
            Clear
          </button>
        </div>
      ) : null}

      {layout === "ledger" ? (
        <LedgerLayout items={visible} jobShortcode={jobShortcode} selected={selected} onToggle={toggle} seatStratum={seatStratum} />
      ) : null}
      {layout === "evidence" ? (
        <EvidenceLayout items={visible} jobShortcode={jobShortcode} selected={selected} onToggle={toggle} />
      ) : null}
      {layout === "tiers" ? <TiersLayout items={visible} jobShortcode={jobShortcode} /> : null}
    </div>
  );
}

function LedgerLayout({
  items,
  jobShortcode,
  selected,
  onToggle,
  seatStratum,
}: {
  items: BoardCandidate[];
  jobShortcode: string;
  selected: Set<string>;
  onToggle: (id: string) => void;
  seatStratum: string;
}) {
  return (
    <div className="mt-4 min-w-[900px] overflow-x-auto pb-1">
      <div className="grid grid-cols-[26px_28px_minmax(190px,1.4fr)_80px_132px_106px_112px_116px_56px] gap-0 border-b border-navy/15 px-2 pb-2.5 text-[12px] text-navy/45">
        <div />
        <div>#</div>
        <div>Candidate</div>
        <div>Fit</div>
        <div>RO stratum</div>
        <div>Salary value</div>
        <div>Confidence</div>
        <div>Stage</div>
        <div>Owner</div>
      </div>
      {items.map((item, index) => (
        <BoardRow
          key={item.candidate.workable_id}
          item={item}
          rank={index + 1}
          jobShortcode={jobShortcode}
          selected={selected.has(item.candidate.workable_id)}
          onToggle={() => onToggle(item.candidate.workable_id)}
          seatStratum={seatStratum}
        />
      ))}
    </div>
  );
}

function BoardRow({
  item,
  rank,
  jobShortcode,
  selected,
  onToggle,
  seatStratum,
}: {
  item: BoardCandidate;
  rank: number;
  jobShortcode: string;
  selected: boolean;
  onToggle: () => void;
  seatStratum: string;
}) {
  const id = item.candidate.workable_id;
  const traj = trajectoryMeta(item.ro?.trajectory ?? undefined);
  const segments = categorySegments(item.score?.category_scores);
  const isNew = isNewCandidate(item.candidate.created_at);
  const inactive = inactiveLabel(item);

  return (
    <Link
      href={candidatePath(jobShortcode, id)}
      className="grid grid-cols-[26px_28px_minmax(190px,1.4fr)_80px_132px_106px_112px_116px_56px] items-center gap-0 border-b border-navy/10 px-2 py-3 hover:bg-white"
      style={{
        background: selected ? "rgba(231,68,36,0.05)" : "transparent",
        opacity: inactive ? 0.45 : 1,
      }}
    >
      <div onClick={(e) => e.preventDefault()}>
        <input type="checkbox" checked={selected} onChange={onToggle} className="accent-orange" />
      </div>
      <div className="font-mono text-[14px] text-navy/45">{rank}</div>
      <div className="min-w-0 pr-3">
        <div className="flex items-center gap-1.5">
          <span className={`text-[14px] font-semibold ${inactive ? "line-through" : ""}`}>{item.candidate.name}</span>
          {isNew && isActive(item) ? <span className="font-mono text-[10px] text-orange">· new</span> : null}
        </div>
        <div className="truncate text-[12px] text-navy/55">{item.candidate.location}</div>
      </div>
      <div>
        <div className="font-mono text-xl font-medium leading-none">{item.score?.total ?? "—"}</div>
        <div className="mt-1 flex h-[5px] w-[72px] overflow-hidden bg-navy/7">
          {segments.map((seg) => (
            <div key={seg.key} style={{ width: seg.width, background: seg.bg }} className="h-full" />
          ))}
        </div>
      </div>
      <div className="text-[14px]">
        <span className="font-mono font-medium">{item.ro?.current_capability ?? "—"}</span>
        <span className="font-mono text-[12px] text-navy/40"> /{seatStratum}</span>
        <div className="text-[12px]" style={{ color: traj.color }}>
          {traj.arrow} {item.ro?.trajectory?.replace(/-/g, " ") ?? "—"}
        </div>
      </div>
      <div className="text-[14px]" style={{ color: salaryColor(item.score?.salary_value) }}>
        {item.score?.salary_value ?? "unstated"}
        {item.ask ? <div className="mt-0.5 font-mono text-[12px] text-navy/45">{item.ask}</div> : null}
      </div>
      <div className="text-xs" style={{ color: confidenceColor(item.score?.confidence) }}>
        {item.score?.confidence ?? "—"}
      </div>
      <div className="text-xs text-navy/82">{inactive ?? item.candidate.stage}</div>
      <div className="text-xs text-navy/55">{ownerLabel(item.assignee)}</div>
    </Link>
  );
}

function EvidenceLayout({
  items,
  jobShortcode,
  selected,
  onToggle,
}: {
  items: BoardCandidate[];
  jobShortcode: string;
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="mt-2">
      {items.map((item, index) => {
        const id = item.candidate.workable_id;
        const tier = TIER_META[tierKeyFromTotal(item.score?.total)];
        const traj = trajectoryMeta(item.ro?.trajectory ?? undefined);
        const headline = (item.candidate.raw as { headline?: string } | null)?.headline ?? null;
        const roleLine = [headline, item.candidate.location].filter(Boolean).join(" · ");
        const inactive = inactiveLabel(item);
        return (
          <Link
            key={id}
            href={candidatePath(jobShortcode, id)}
            className="grid grid-cols-[24px_96px_1fr_220px] items-center gap-[18px] border-b border-navy/10 px-2 py-[18px] hover:bg-white"
            style={{ opacity: inactive ? 0.45 : 1 }}
          >
            <div onClick={(e) => e.preventDefault()}>
              <input
                type="checkbox"
                checked={selected.has(id)}
                onChange={() => onToggle(id)}
                className="accent-orange"
              />
            </div>
            <div>
              <div className="font-mono text-4xl font-medium leading-[0.9] tracking-tight">
                {item.score?.total ?? "—"}
              </div>
              <div className="mt-1.5 text-[12px] font-semibold" style={{ color: tier.color }}>
                {tier.label}
              </div>
              <div className="font-mono text-[10px] text-navy/40">#{index + 1}</div>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className={`text-[15px] font-semibold ${inactive ? "line-through" : ""}`}>
                  {item.candidate.name}
                </span>
                <span className="text-xs text-navy/55">{roleLine || item.candidate.location}</span>
              </div>
              {item.why ? (
                <p className="mt-1.5 max-w-[560px] text-[14px] leading-relaxed text-navy/70">{item.why}</p>
              ) : null}
              <div className="mt-2.5 flex h-[7px] max-w-[480px] overflow-hidden bg-navy/7">
                {categorySegments(item.score?.category_scores).map((seg) => (
                  <div key={seg.key} style={{ width: seg.width, background: seg.bg }} className="h-full" />
                ))}
              </div>
              <div className="mt-1.5 font-mono text-[10px] text-navy/45">
                {categoryLine(item.score?.category_scores)}
              </div>
            </div>
            <div className="flex flex-col gap-1.5 text-right text-xs text-navy/70">
              <div>
                <span className="text-navy/45">RO </span>
                <span className="font-mono font-medium">{item.ro?.current_capability ?? "—"}</span>{" "}
                <span style={{ color: traj.color }}>{traj.arrow}</span>
              </div>
              <div style={{ color: salaryColor(item.score?.salary_value) }}>
                {item.score?.salary_value ?? "unstated"}
                {item.ask ? <span className="font-mono text-[12px] text-navy/45"> {item.ask}</span> : null}
              </div>
              <div style={{ color: confidenceColor(item.score?.confidence) }}>
                {item.score?.confidence ?? "—"}
              </div>
              <div>{inactive ?? item.candidate.stage}</div>
              <div className="font-mono text-[12px] text-navy/45">
                {item.sources ?? 0} source{(item.sources ?? 0) === 1 ? "" : "s"} · {ownerLabel(item.assignee)}
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

function TiersLayout({ items, jobShortcode }: { items: BoardCandidate[]; jobShortcode: string }) {
  const groups = (["strong", "viable", "hold", "low"] as const).map((key) => {
    const groupItems = items.filter((i) => tierKeyFromTotal(i.score?.total) === key);
    const avg =
      groupItems.length > 0
        ? Math.round(
            groupItems.reduce((sum, i) => sum + (i.score?.total ?? 0), 0) / groupItems.length,
          )
        : 0;
    return { key, items: groupItems, avg, meta: TIER_META[key] };
  });

  return (
    <div className="mt-2.5">
      {groups.map((group) =>
        group.items.length ? (
          <div key={group.key} className="mt-5">
            <div
              className="flex items-center gap-2.5 border-b pb-2"
              style={{ borderColor: group.meta.color }}
            >
              <span className="text-sm font-semibold" style={{ color: group.meta.color }}>
                {group.meta.label}
              </span>
              <span className="font-mono text-[12px] text-navy/45">
                {group.items.length} · avg {group.avg}
              </span>
              <span className="flex-1" />
              <span className="text-[12px] text-navy/50">{group.meta.note}</span>
            </div>
            {group.items.map((item) => {
              const inactive = inactiveLabel(item);
              return (
              <Link
                key={item.candidate.workable_id}
                href={candidatePath(jobShortcode, item.candidate.workable_id)}
                className="grid grid-cols-[1fr_58px_160px_130px_116px] items-center gap-3.5 border-b border-navy/8 px-2 py-2.5 hover:bg-white"
                style={{ opacity: inactive ? 0.45 : 1 }}
              >
                <div className="min-w-0 truncate">
                  <span className={`text-[14px] font-semibold ${inactive ? "line-through" : ""}`}>
                    {item.candidate.name}
                  </span>
                  <span className="ml-2 text-[11px] text-navy/55">{item.candidate.location}</span>
                </div>
                <div className="font-mono text-lg font-medium">{item.score?.total ?? "—"}</div>
                <div className="text-xs">
                  <span className="font-mono">{item.ro?.current_capability ?? "—"}</span>{" "}
                  <span style={{ color: trajectoryMeta(item.ro?.trajectory ?? undefined).color }}>
                    {trajectoryMeta(item.ro?.trajectory ?? undefined).arrow}{" "}
                    {item.ro?.trajectory?.replace(/-/g, " ") ?? ""}
                  </span>
                </div>
                <div className="text-xs" style={{ color: salaryColor(item.score?.salary_value) }}>
                  {item.score?.salary_value ?? "unstated"}
                </div>
                <div className="text-xs text-navy/82">{inactive ?? item.candidate.stage}</div>
              </Link>
              );
            })}
          </div>
        ) : null,
      )}
    </div>
  );
}

function BulkBtn({
  children,
  onClick,
  disabled,
  primary,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={
        primary
          ? "rounded-full bg-orange px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          : "rounded-full border border-cream/35 px-3.5 py-1.5 text-xs text-cream disabled:opacity-50"
      }
    >
      {children}
    </button>
  );
}
