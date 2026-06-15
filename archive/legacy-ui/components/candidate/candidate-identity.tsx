import {
  confidenceColor,
  formatTierLabel,
  investCopy,
  parseSalaryAskFromText,
  salaryColor,
  tierKeyFromTotal,
  TIER_META,
  trajectoryMeta,
} from "@/lib/board/format";
import type { CandidateOverlayRow, RoAssessmentRow, ScoreRow } from "@/lib/types";
import { FormattedText } from "@/components/ui/formatted-text";

export function CandidateIdentity({
  name,
  roleLine,
  companyLine,
  location,
  score,
  ro,
  seatStratum,
  ask,
}: {
  name: string;
  roleLine: string;
  companyLine: string;
  location: string | null;
  score: ScoreRow | null;
  ro: RoAssessmentRow | null;
  seatStratum: string;
  ask?: string | null;
}) {
  const tier = TIER_META[tierKeyFromTotal(score?.total)];
  const traj = trajectoryMeta(ro?.trajectory ?? undefined);

  return (
    <div className="flex flex-wrap items-start justify-between gap-8">
      <div className="min-w-0">
        <h1 className="text-[28px] font-semibold tracking-tight">{name}</h1>
        <p className="mt-1 text-sm text-navy/70">
          {roleLine} · <span className="font-serif text-base italic">{companyLine}</span>
        </p>
        <div className="mt-3 flex flex-wrap gap-x-3.5 gap-y-1 font-mono text-[12px] text-navy/60">
          <span>
            RO <span className="font-medium text-navy">{ro?.current_capability ?? "—"}</span> / seat{" "}
            {seatStratum}
          </span>
          <span className="text-navy/25">·</span>
          <span style={{ color: traj.color }}>
            {traj.arrow} {ro?.trajectory?.replace(/-/g, " ") ?? "—"}
          </span>
          <span className="text-navy/25">·</span>
          <span>basis: {ro?.basis ?? "—"}</span>
          <span className="text-navy/25">·</span>
          <span>{location ?? "—"}</span>
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="font-mono text-[46px] font-medium leading-[0.9] tracking-tight">
          {score?.total ?? "—"}
        </div>
        <div className="mt-1.5 text-xs font-semibold" style={{ color: tier.color }}>
          {formatTierLabel(score?.total)}
        </div>
        <div className="mt-0.5 text-xs" style={{ color: confidenceColor(score?.confidence) }}>
          confidence: {score?.confidence ?? "—"}
        </div>
        <div className="mt-0.5 text-xs" style={{ color: salaryColor(score?.salary_value) }}>
          {score?.salary_value ?? "unstated"}
          {ask ? <span className="font-mono text-navy/55"> · {ask}</span> : null}
        </div>
      </div>
    </div>
  );
}

export function InvestmentPanel({
  score,
  overlay,
  rank,
  poolLine,
  poolStats,
  salaryHint,
  candidateName,
  summary,
  active = true,
  statusLabel,
}: {
  score: ScoreRow | null;
  overlay: CandidateOverlayRow | null;
  rank: number;
  poolLine: string;
  poolStats?: { active: number; owners: number };
  salaryHint?: string | null;
  candidateName?: string | null;
  summary?: string | null;
  active?: boolean;
  statusLabel?: string;
}) {
  const salaryAsk = parseSalaryAskFromText(salaryHint, overlay?.salary_vector);
  const invest = investCopy({
    complement: overlay?.complement,
    removes: overlay?.complement_removes,
    vector: overlay?.salary_vector,
    rank,
    name: candidateName,
    ask: salaryAsk,
    active,
    statusLabel,
    pool: poolStats,
  });

  return (
    <div className="mt-[22px] grid border border-navy/12 border-t-2 border-t-navy md:grid-cols-[1fr_218px]">
      <div className="min-w-0 p-5">
        <div className="text-[15px] font-semibold">{invest.head}</div>
        <FormattedText
          text={invest.text}
          className="mt-2 text-[14px] leading-relaxed text-navy/82"
        />
        {summary ? (
          <FormattedText
            text={summary}
            className="mt-2.5 max-w-[640px] text-[14px] leading-relaxed text-navy/70"
          />
        ) : null}
        {poolLine ? (
          <p className="mt-3 font-mono text-[12px] text-navy/50">Pool · {poolLine}</p>
        ) : null}
      </div>
      <div className="border-t border-navy/12 bg-navy/[0.02] p-5 md:border-t-0 md:border-l">
        <div className="text-[12px] text-navy/55">Target salary</div>
        <div className="mt-1 font-mono text-[34px] font-semibold leading-none tracking-tight">
          {salaryAsk ?? "—"}
        </div>
        <div className="mt-1 text-xs" style={{ color: salaryColor(score?.salary_value) }}>
          {score?.salary_value ?? "unstated"}
        </div>
        {overlay?.salary_vector ? (
          <p className="mt-2 text-xs leading-snug text-navy/70">{overlay.salary_vector}</p>
        ) : null}
      </div>
    </div>
  );
}
