"use client";

import { useState } from "react";
import type { EvaluationRow } from "@/lib/data/overlay";
import type { NarrativeSegment, RoAssessmentRow, ScoreInputRow } from "@/lib/types";
import { FormattedText } from "@/components/ui/formatted-text";

export function CareerSection({
  narrative,
  ro,
  scoreInputs,
  evaluations,
  chronologySummary,
}: {
  narrative: NarrativeSegment[];
  ro: RoAssessmentRow | null;
  scoreInputs: ScoreInputRow[];
  evaluations: EvaluationRow[];
  chronologySummary?: string | null;
}) {
  const roleReads = evaluations
    .filter((e) => e.kind === "role_read")
    .map((e) => e.payload as unknown as { role?: string; company?: string; read?: string; level?: string; burden?: string; quote?: string; stratum?: string });

  function readForSegment(text: string) {
    const lower = text.toLowerCase();
    return roleReads.find((r) => {
      const company = (r.company ?? "").toLowerCase();
      const role = (r.role ?? "").toLowerCase();
      return (company && lower.includes(company)) || (role && lower.includes(role));
    });
  }

  if (!narrative.length && !ro?.per_role?.length) {
    return (
      <section className="mt-10 border-t border-navy/15 pt-10">
        <p className="text-[14px] text-navy/55">
          Career timeline populates after sync and scoring. Hit Sync on the board to ingest this candidate.
        </p>
      </section>
    );
  }

  return (
    <section className="mt-10">
      <h2 className="text-base font-semibold">Career, stratum &amp; the life timeline.</h2>
      <p className="mt-1 max-w-[800px] text-[14px] leading-relaxed text-navy/62">
        Chronology + RO climb + résumé evidence — one view. Gaps are shown, not smoothed over.
      </p>
      {chronologySummary ? (
        <FormattedText
          text={chronologySummary}
          className="mt-3 max-w-[800px] border-l-2 border-orange/40 pl-3 text-[14px] leading-relaxed text-navy/75"
        />
      ) : null}

      <RoClimbChart climb={buildClimb(narrative, roleReads, ro)} />

      <div className="mt-5 space-y-0">
        {narrative.map((segment, index) => (
          <TimelineRow
            key={`${segment.span}-${index}`}
            segment={segment}
            roleRead={segment.type === "role" ? readForSegment(segment.text) : undefined}
            scoreInputs={scoreInputs}
          />
        ))}
      </div>
    </section>
  );
}

const LEVEL_MAX = 4.5;
const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5 };
const PAD = 5; // % padding on each side of the plot

type RoleRead = {
  role?: string;
  company?: string;
  read?: string;
  level?: string;
  burden?: string;
  quote?: string;
  stratum?: string;
};

/** Parse a stratum string like "IVb–a", "IIIa", "IIb" into a numeric level. */
function stratumToLevel(stratum: string | null | undefined): number | null {
  if (!stratum) return null;
  const s = stratum.trim();
  const roman = s.match(/^(IV|III|II|I|V)/);
  if (!roman) return null;
  const base = ROMAN[roman[1]] ?? null;
  if (base == null) return null;
  const sub = s.slice(roman[1].length).match(/[abc]/i);
  const offset = sub ? { a: 0.75, b: 0.5, c: 0.25 }[sub[0].toLowerCase()]! : 0.5;
  return base - 1 + offset; // e.g. IIIa ≈ 2.75
}

function levelToY(level: number): number {
  return 6 + (1 - level / LEVEL_MAX) * 84;
}

function yearsOf(span: string | null | undefined): { start: number | null; end: number | null; present: boolean } {
  const present = /present|now|current/i.test(span ?? "");
  const matches = (span?.match(/\b(19|20)\d{2}\b/g) ?? []).map(Number);
  return {
    start: matches.length ? matches[0]! : null,
    end: present ? new Date().getFullYear() : matches.length ? matches[matches.length - 1]! : null,
    present,
  };
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** A short, recognizable company label (first meaningful token). */
function shortCompany(company: string | null | undefined): string {
  if (!company) return "";
  const cleaned = company
    .replace(/\b(inc|llc|ltd|corp|corporation|company|co|university|institute|of|the|group|holdings)\b/gi, "")
    .replace(/[.,]/g, "")
    .trim();
  const word = (cleaned.split(/\s+/)[0] || company.split(/\s+/)[0] || "").trim();
  return titleCase(word.length > 12 ? word.slice(0, 12) : word);
}

/** A short role label (Sr Mgr, Prin, Dir, Tech…). */
function shortRole(role: string | null | undefined): string {
  if (!role) return "";
  const lower = role.toLowerCase();
  const map: Array<[RegExp, string]> = [
    [/principal/, "Prin"],
    [/senior|sr\.?/, "Sr"],
    [/director/, "Dir"],
    [/manager/, "Mgr"],
    [/vice president|vp/, "VP"],
    [/president/, "Pres"],
    [/associate/, "Assoc"],
    [/assistant/, "Asst"],
    [/technician|technical/, "Tech"],
    [/post.?doc/, "Postdoc"],
    [/controller/, "Controller"],
    [/analyst/, "Analyst"],
    [/coordinator/, "Coord"],
    [/engineer/, "Eng"],
  ];
  const parts: string[] = [];
  if (/senior|sr\.?/.test(lower)) parts.push("Sr");
  for (const [re, label] of map) {
    if (label === "Sr") continue;
    if (re.test(lower)) {
      parts.push(label);
      break;
    }
  }
  if (parts.length) return parts.join(" ");
  const first = role.split(/[ ,]/)[0] || role;
  return first.length > 10 ? first.slice(0, 10) : first;
}

export interface ClimbNode {
  year: number; // start year used for x position
  level: number;
  stratum: string;
  label: string;
}
export interface ClimbData {
  nodes: ClimbNode[];
  gaps: Array<{ start: number; end: number }>;
  edu: { year: number; label: string } | null;
  minYear: number;
  maxYear: number;
  ticks: number[];
  timeScaled: boolean;
}

/**
 * Build the time-scaled RO climb: dated roles joined to their stratum reads,
 * positioned by year on the X axis and stratum on the Y axis — matching the
 * life-timeline chart in the spec.
 */
function buildClimb(
  narrative: NarrativeSegment[],
  roleReads: RoleRead[],
  ro: RoAssessmentRow | null,
): ClimbData | null {
  const matchRead = (text: string): RoleRead | undefined => {
    const lower = text.toLowerCase();
    return roleReads.find((r) => {
      const company = (r.company ?? "").toLowerCase();
      const role = (r.role ?? "").toLowerCase();
      return (company && lower.includes(company)) || (role && lower.includes(role));
    });
  };

  const roleSegs = narrative.filter((s) => s.type === "role");
  const nodes: ClimbNode[] = [];
  for (const seg of roleSegs) {
    const { start, end } = yearsOf(seg.span);
    const read = matchRead(seg.text);
    const stratum = read?.stratum ?? null;
    const level = stratumToLevel(stratum);
    if (level == null || start == null) continue;
    // Prefer the clean role/company fields; fall back to "Role at Company" text.
    let company = read?.company ?? null;
    let role = read?.role ?? null;
    if (!company && seg.text.includes(" at ")) {
      const [r, c] = seg.text.split(" at ");
      role = role ?? r ?? null;
      company = c ?? null;
    }
    const label = [shortCompany(company), shortRole(role)].filter(Boolean).join(" · ") || seg.text.slice(0, 16);
    nodes.push({ year: start, level, stratum: stratum!, label });
    void end;
  }

  // Need at least 2 dated, stratum'd roles for a time-scaled climb.
  if (nodes.length < 2) {
    // Fall back to index-based from ro.per_role so the chart still renders.
    const roles = (ro?.per_role ?? [])
      .map((r) => ({ ...r, level: stratumToLevel(r.stratum) }))
      .filter((r): r is typeof r & { level: number } => r.level != null);
    if (roles.length < 2) return null;
    const span = roles.length - 1;
    const flat: ClimbNode[] = roles.map((r, i) => ({
      year: i, // pseudo-year (index)
      level: r.level,
      stratum: r.stratum,
      label: [shortCompany(r.company), shortRole(r.role)].filter(Boolean).join(" · "),
    }));
    return {
      nodes: flat,
      gaps: [],
      edu: null,
      minYear: 0,
      maxYear: span,
      ticks: [0, span],
      timeScaled: false,
    };
  }

  nodes.sort((a, b) => a.year - b.year);

  // Gaps with real spans.
  const gaps: Array<{ start: number; end: number }> = [];
  for (const seg of narrative) {
    if (seg.type !== "gap") continue;
    const { start, end } = yearsOf(seg.span);
    if (start != null && end != null && end >= start) gaps.push({ start, end });
  }

  // Education marker (latest degree year).
  const eduSeg = narrative.find((s) => s.type === "education");
  const eduYear = eduSeg ? yearsOf(eduSeg.span).end ?? yearsOf(eduSeg.span).start : null;
  const eduLabelBase = eduSeg?.text.match(/ph\.?d|m\.?b\.?a|m\.?s|b\.?s|b\.?a|master|bachelor|doctor/i)?.[0];
  const edu = eduYear ? { year: eduYear, label: `${eduLabelBase ? titleCase(eduLabelBase) : "Degree"} ${eduYear}` } : null;

  const years = [
    ...nodes.map((n) => n.year),
    ...gaps.flatMap((g) => [g.start, g.end]),
    ...(eduYear ? [eduYear] : []),
  ];
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years, ...nodes.map((n) => n.year));

  // Decade ticks across the range, always including the endpoints.
  const ticks: number[] = [minYear];
  for (let y = Math.ceil(minYear / 10) * 10; y < maxYear; y += 10) {
    if (y > minYear) ticks.push(y);
  }
  if (maxYear !== minYear) ticks.push(maxYear);

  return { nodes, gaps, edu, minYear, maxYear, ticks, timeScaled: true };
}

/** Smooth Catmull-Rom path through the points (percent coords). */
function smoothPath(pts: Array<{ x: number; y: number }>): string {
  if (pts.length < 2) return "";
  if (pts.length === 2) return `M${pts[0]!.x},${pts[0]!.y} L${pts[1]!.x},${pts[1]!.y}`;
  let d = `M${pts[0]!.x.toFixed(2)},${pts[0]!.y.toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
  }
  return d;
}

function RoClimbChart({ climb }: { climb: ClimbData | null }) {
  if (!climb) return null;
  const { nodes, gaps, edu, minYear, maxYear, ticks, timeScaled } = climb;

  const xPct = (year: number) =>
    maxYear === minYear ? 50 : PAD + ((year - minYear) / (maxYear - minYear)) * (100 - 2 * PAD);

  const points = nodes.map((n) => ({ x: xPct(n.year), y: levelToY(n.level) }));
  const path = smoothPath(points);
  const bands = [4, 3, 2, 1].map((lvl) => ({
    y: levelToY(lvl),
    label: ["", "I", "II", "III", "IV"][lvl] ?? "",
  }));

  return (
    <div className="mt-6 grid max-w-[820px] grid-cols-[26px_1fr] gap-2">
      <div className="relative h-[200px]">
        {bands.map((b) => (
          <div
            key={b.label}
            className="absolute right-0 -translate-y-1/2 font-mono text-[11px] text-navy/45"
            style={{ top: `${b.y}%` }}
          >
            {b.label}
          </div>
        ))}
      </div>
      <div className="relative h-[200px] border-b border-l border-navy/15">
        {bands.map((b) => (
          <div
            key={b.label}
            className="absolute right-0 left-0 border-t border-navy/[0.07]"
            style={{ top: `${b.y}%` }}
          />
        ))}

        {/* Gap bands */}
        {timeScaled &&
          gaps.map((g, i) => {
            const left = xPct(g.start);
            const width = Math.max(0.8, xPct(g.end) - left);
            return (
              <div
                key={`gap-${i}`}
                className="absolute top-0 bottom-0 border-x border-dashed border-orange/55 bg-orange/[0.07]"
                style={{ left: `${left}%`, width: `${width}%` }}
              >
                <div className="absolute top-1 left-1/2 -translate-x-1/2 font-mono text-[10px] whitespace-nowrap text-orange">
                  gap
                </div>
              </div>
            );
          })}

        {/* Education marker */}
        {timeScaled && edu ? (
          <div
            className="absolute top-0 bottom-0 border-l border-dashed border-navy/25"
            style={{ left: `${xPct(edu.year)}%` }}
          >
            <div className="absolute top-1 left-1 font-mono text-[10px] whitespace-nowrap text-navy/45">
              {edu.label}
            </div>
          </div>
        ) : null}

        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full overflow-visible"
        >
          <path
            d={path}
            fill="none"
            stroke="#162335"
            strokeWidth={1.6}
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>

        {nodes.map((n, i) => {
          const x = xPct(n.year);
          const y = levelToY(n.level);
          const anchor = x < 12 ? "left" : x > 88 ? "right" : "center";
          return (
            <div key={`dot-${i}`}>
              <div
                className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] border-cream bg-navy"
                style={{ left: `${x}%`, top: `${y}%` }}
                title={`${n.label} — ${n.stratum}`}
              />
              <div
                className="absolute whitespace-nowrap font-mono text-[10px] text-navy/65"
                style={{
                  left: `${x}%`,
                  top: `${y}%`,
                  transform: `translate(${anchor === "left" ? "0" : anchor === "right" ? "-100%" : "-50%"}, ${i % 2 === 0 ? "-210%" : "-360%"})`,
                }}
              >
                {n.label}
              </div>
            </div>
          );
        })}
      </div>

      {/* X axis: year ticks (beginning → end) */}
      <div />
      <div className="relative h-4">
        {timeScaled ? (
          ticks.map((t) => (
            <div
              key={t}
              className="absolute top-0 -translate-x-1/2 font-mono text-[10px] text-navy/45"
              style={{ left: `${xPct(t)}%` }}
            >
              <span className="absolute -top-1 left-1/2 h-1.5 w-px -translate-x-1/2 bg-navy/20" />
              {t}
            </div>
          ))
        ) : (
          <>
            <span className="absolute left-[5%] -translate-x-1/2 font-mono text-[10px] text-navy/45">
              first role
            </span>
            <span className="absolute left-[95%] -translate-x-1/2 font-mono text-[10px] text-navy/45">
              now
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function TimelineRow({
  segment,
  roleRead,
  scoreInputs,
}: {
  segment: NarrativeSegment;
  roleRead?: { read?: string; level?: string; burden?: string; quote?: string; stratum?: string };
  scoreInputs: ScoreInputRow[];
}) {
  const [open, setOpen] = useState(false);
  const isGap = segment.type === "gap";

  if (isGap) {
    return (
      <div className="grid grid-cols-[92px_20px_1fr]">
        <div />
        <div className="relative">
          <div className="absolute top-0 bottom-0 left-1 border-l-2 border-dotted border-orange/60" />
          <div className="absolute top-3 -left-px h-[13px] w-[13px] rounded-full border-2 border-orange bg-cream" />
        </div>
        <div className="py-2.5 pl-3 pb-8">
          <div className="flex max-w-[600px] items-center gap-3 border border-orange/30 bg-orange/[0.07] px-3.5 py-2.5">
            <span className="text-[14px] font-bold whitespace-nowrap text-orange">Gap</span>
            <span className="text-xs leading-snug text-navy/72">{segment.text}</span>
          </div>
        </div>
      </div>
    );
  }

  const quote = roleRead?.quote ?? scoreInputs.find((i) => i.quote)?.quote;

  return (
    <div className="grid grid-cols-[92px_20px_1fr]">
      <div className="pr-3.5 pt-px text-right">
        <div className="font-mono text-xs whitespace-nowrap text-navy/78">{segment.span}</div>
      </div>
      <div className="relative">
        <div className="absolute top-0 bottom-0 left-[5px] w-px bg-navy/15" />
        <div className="absolute top-1 left-0 h-[11px] w-[11px] rounded-full border-2 border-cream bg-navy shadow-[0_0_0_1px_rgba(22,35,53,0.2)]" />
      </div>
      <div className="min-w-0 pb-[26px] pl-3">
        <div className="flex items-baseline justify-between gap-3">
          <div className="text-sm font-semibold">{segment.text}</div>
          {roleRead?.stratum && roleRead.stratum !== "—" ? (
            <div className="shrink-0 font-mono text-[12px] whitespace-nowrap text-navy/55">
              stratum {roleRead.stratum}
            </div>
          ) : null}
        </div>
        {roleRead?.read ? (
          <p className="mt-2 text-[14px] leading-relaxed text-navy/85">
            {roleRead.read}
            {roleRead.level ? (
              <span className="font-mono text-[12px] text-navy/50">
                {" "}
                · level {roleRead.level} · {roleRead.burden}
              </span>
            ) : null}
          </p>
        ) : null}
        {quote ? (
          <>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="mt-2 font-mono text-[12px] text-orange"
            >
              {open ? "Hide source" : "Show source"}
            </button>
            {open ? (
              <div className="mt-2 border-l-2 border-navy/15 bg-navy/[0.025] px-3 py-2.5 text-xs leading-relaxed text-navy/72">
                <span className="font-mono text-[10px] text-navy/40">from the résumé&nbsp;&nbsp;</span>
                <span className="border-b border-orange/45 bg-orange/[0.14] px-0.5">{quote}</span>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
