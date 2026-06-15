"use client";

import { CSSProperties, useState } from "react";
import { FONTS, DM, REV, askColor, askTierLabel } from "@/lib/triage/theme";
import type { CutGroup, Decision } from "@/lib/triage/types";
import type { WorkspaceApi } from "./use-workspace";
import { useTriageData } from "./context";

const mono = (extra: CSSProperties = {}): CSSProperties => ({ fontFamily: FONTS.mono, ...extra });
const ink = (a: number) => `rgba(22,35,53,${a})`;

interface Props {
  wsApi: WorkspaceApi;
  filter: string;
  setFilter: (f: string) => void;
  openCandidate: (id: string) => void;
  openDeep: (id: string) => void;
}

const CUT_DEFS: { key: CutGroup; title: string }[] = [
  { key: "care", title: "Application-care failures" },
  { key: "evidence", title: "Evidence failures" },
  { key: "pattern", title: "Career-pattern failures" },
  { key: "mismatch", title: "Role mismatch" },
  // #1: appears only when populated — human/overlay cuts without a material-integrity gate.
  { key: "human", title: "Human signal failures" },
];

export function PoolScreen({ wsApi, filter, setFilter, openCandidate, openDeep }: Props) {
  const { candidates: CANDIDATES, meta } = useTriageData();
  const { ws, bulkDq, openCount, toggleDq } = wsApi;
  const dq = ws.dq;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggleExpand = (id: string) => setExpanded((e) => ({ ...e, [id]: !e[id] }));

  const byDec = (d: Decision) => CANDIDATES.filter((c) => c.decision === d);
  const nInterview = byDec("interview").length;
  const nShort = byDec("short").length;
  const nVerify = byDec("verify").length;
  const nHold = byDec("hold").length;
  const nBlocked = byDec("blocked").length;
  const nCut = byDec("cut").length;
  const nWorth = nInterview + nShort + nVerify;
  const total = CANDIDATES.length;
  const nDq = Object.keys(dq).filter((k) => dq[k]).length;
  const cutRemaining = nCut - nDq;

  const counts = [
    { label: "To cut now", value: nCut, color: "#9E3B28" },
    { label: "Strong interview", value: nInterview, color: "#E74424" },
    { label: "Worth screening", value: nShort + nVerify, color: "#162335" },
    { label: "Hold", value: nHold, color: "rgba(22,35,53,0.6)" },
    { label: "Review blocked", value: nBlocked, color: "#E74424" },
  ];

  const cuts = CANDIDATES.filter((c) => c.decision === "cut");
  const cutGroups = CUT_DEFS.map((g) => ({
    title: g.title,
    items: cuts.filter((c) => c.cutGroup === g.key),
  })).filter((g) => g.items.length);

  let rows = CANDIDATES.filter((c) => c.decision !== "cut");
  if (filter !== "all") rows = CANDIDATES.filter((c) => c.decision === filter);
  rows = [...rows].sort((a, b) => a.rank - b.rank);

  const chipDefs = [
    { key: "all", label: "All", count: CANDIDATES.filter((c) => c.decision !== "cut").length },
    { key: "interview", label: "Interview", count: nInterview },
    { key: "short", label: "Short screen", count: nShort },
    { key: "verify", label: "Verify", count: nVerify },
    { key: "hold", label: "Hold", count: nHold + nBlocked },
  ];

  const tableCols = "34px minmax(168px,1fr) 138px 152px minmax(190px,1.3fr) 150px minmax(150px,1fr) 132px";

  return (
    <div style={{ maxWidth: 1560, margin: "0 auto", padding: "34px 28px 96px" }}>
      {/* header */}
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 24, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 42, fontWeight: 500, letterSpacing: "-0.035em", lineHeight: 0.98 }}>
            {meta.title}{" "}
            <span style={{ fontFamily: FONTS.serif, fontStyle: "italic", fontWeight: 400, color: "#E74424", letterSpacing: "-0.01em" }}>
              pool.
            </span>
          </h1>
          <div style={mono({ marginTop: 11, display: "flex", alignItems: "center", gap: 11, fontSize: 14, color: "rgba(22,35,53,0.62)", flexWrap: "wrap" })}>
            <span>{meta.jobShortcode}</span>
            <span style={{ color: "rgba(22,35,53,0.25)" }}>·</span>
            <span>{total} in pool</span>
            <span style={{ color: "rgba(22,35,53,0.25)" }}>·</span>
            <span style={{ color: "#9E3B28" }}>{nCut} to cut</span>
            <span style={{ color: "rgba(22,35,53,0.25)" }}>·</span>
            <span style={{ color: "#162335" }}>{nWorth} to screen</span>
            <span style={{ color: "rgba(22,35,53,0.25)" }}>·</span>
            <span>{nDq} disqualified</span>
          </div>
        </div>
        <a
          href={meta.jobUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            cursor: "pointer",
            border: "1px solid rgba(22,35,53,0.22)",
            background: "transparent",
            color: "#162335",
            borderRadius: 9999,
            padding: "9px 16px",
            fontSize: 15,
            whiteSpace: "nowrap",
            textDecoration: "none",
          }}
        >
          Open job in Workable ↗
        </a>
      </div>

      {/* pool read + counts */}
      <div style={{ marginTop: 24, borderTop: "1px solid rgba(22,35,53,0.15)", paddingTop: 22 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: "0 56px", alignItems: "start" }}>
          <div>
            <div style={mono({ fontSize: 12, letterSpacing: "0.05em", textTransform: "uppercase", color: "rgba(22,35,53,0.5)" })}>
              Pool read — <span style={{ color: "#E74424" }}>{meta.healthState}</span>
            </div>
            <div style={{ marginTop: 12, fontSize: 23, fontWeight: 400, lineHeight: 1.4, maxWidth: 640 }}>{meta.healthRead}</div>
          </div>
          <div style={{ borderLeft: "1px solid rgba(22,35,53,0.12)", paddingLeft: 40 }}>
            {counts.map((ct) => (
              <div
                key={ct.label}
                style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, padding: "10px 0", borderTop: "1px solid rgba(22,35,53,0.10)" }}
              >
                <span style={{ fontSize: 15, color: "rgba(22,35,53,0.78)" }}>{ct.label}</span>
                <span style={mono({ fontSize: 18, fontWeight: 500, color: ct.color, fontVariantNumeric: "tabular-nums" })}>{ct.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ============ CUT LIST (first) ============ */}
      <div style={{ marginTop: 44 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14, borderBottom: "2px solid #9E3B28", paddingBottom: 11, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, fontSize: 27, fontWeight: 500, letterSpacing: "-0.02em" }}>
            Cut list{" "}
            <span style={{ fontFamily: FONTS.serif, fontStyle: "italic", fontWeight: 400, color: "#9E3B28", fontSize: 24 }}>— clear these first.</span>
          </h2>
          <span style={{ flex: 1 }} />
          <span style={mono({ fontSize: 13, color: "rgba(22,35,53,0.55)" })}>
            {cutRemaining} open · {nDq} disqualified
          </span>
          <button
            onClick={bulkDq}
            style={mono({
              cursor: "pointer",
              border: "1px solid #9E3B28",
              background: openCount > 0 ? "transparent" : "#9E3B28",
              color: openCount > 0 ? "#9E3B28" : "#fff",
              borderRadius: 9999,
              padding: "6px 14px",
              fontSize: 12.5,
              whiteSpace: "nowrap",
            })}
          >
            {openCount > 0 ? "Disqualify all open" : "Undo — restore all"}
          </button>
        </div>

        {cutGroups.map((g) => (
          <div key={g.title} style={{ marginTop: 18 }}>
            <div style={mono({ fontSize: 12, letterSpacing: "0.04em", textTransform: "uppercase", color: "#9E3B28", marginBottom: 4 })}>{g.title}</div>
            {g.items.map((c) => {
              const isDq = !!dq[c.id];
              const isOpen = !!expanded[c.id];
              return (
                <div key={c.id}>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "minmax(0,1.3fr) minmax(0,2.2fr) auto",
                      gap: 20,
                      alignItems: "center",
                      padding: "13px 4px",
                      borderTop: "1px solid rgba(22,35,53,0.09)",
                      background: isDq ? "rgba(22,35,53,0.035)" : "transparent",
                    }}
                  >
                    <div onClick={() => openCandidate(c.id)} style={{ cursor: "pointer", minWidth: 0 }}>
                      <span style={{ fontSize: 16.5, fontWeight: 500, textDecoration: isDq ? "line-through" : "none", color: isDq ? "rgba(22,35,53,0.4)" : "#162335" }}>
                        {c.name}
                      </span>{" "}
                      <span style={{ fontSize: 13.5, color: "rgba(22,35,53,0.5)" }}>· {c.role}</span>
                    </div>
                    <div
                      onClick={() => toggleExpand(c.id)}
                      title={isOpen ? "Hide evidence" : "Show evidence"}
                      aria-expanded={isOpen}
                      style={{ cursor: "pointer", display: "flex", alignItems: "baseline", gap: 8, fontSize: 14.5, lineHeight: 1.4, color: "rgba(22,35,53,0.78)", minWidth: 0 }}
                    >
                      <span style={mono({ fontSize: 11, color: "#9E3B28", flexShrink: 0, transform: isOpen ? "none" : "none" })}>{isOpen ? "▾" : "▸"}</span>
                      <span style={{ minWidth: 0 }}>{c.cutReason}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, justifySelf: "end" }}>
                      <button
                        onClick={() => toggleDq(c.id)}
                        title="Disqualify"
                        style={{
                          cursor: "pointer",
                          width: 32,
                          height: 32,
                          borderRadius: 9999,
                          border: "1px solid #9E3B28",
                          background: isDq ? "#9E3B28" : "transparent",
                          color: isDq ? "#fff" : "#9E3B28",
                          fontSize: 14,
                          lineHeight: 1,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          padding: 0,
                        }}
                      >
                        ✕
                      </button>
                      <button
                        onClick={() => openDeep(c.id)}
                        title="Run deep analysis"
                        style={mono({
                          cursor: "pointer",
                          width: 32,
                          height: 32,
                          borderRadius: 9999,
                          border: "1px solid rgba(22,35,53,0.28)",
                          background: "transparent",
                          color: "#162335",
                          fontSize: 15,
                          lineHeight: 1,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          padding: 0,
                        })}
                      >
                        ?
                      </button>
                    </div>
                  </div>
                  {isOpen && <CutEvidence cite={c.cite} matters={c.cutMatters} next={c.next} />}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* ============ INTERVIEW PRIORITY ============ */}
      <div style={{ marginTop: 52 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap", borderBottom: "1px solid rgba(22,35,53,0.15)", paddingBottom: 11 }}>
          <h2 style={{ margin: 0, fontSize: 27, fontWeight: 500, letterSpacing: "-0.02em" }}>Interview priority</h2>
          <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
            {chipDefs.map((chip) => (
              <button
                key={chip.key}
                onClick={() => setFilter(chip.key)}
                style={{
                  cursor: "pointer",
                  border: "none",
                  background: "transparent",
                  padding: "4px 0",
                  fontSize: 15,
                  fontWeight: 500,
                  color: filter === chip.key ? "#162335" : "rgba(22,35,53,0.5)",
                  borderBottom: `2px solid ${filter === chip.key ? "#E74424" : "transparent"}`,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <span>{chip.label}</span>
                <span style={mono({ fontSize: 13, opacity: 0.55 })}>{chip.count}</span>
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginTop: 6, overflowX: "auto", paddingBottom: 4 }}>
          <div style={{ minWidth: 1300 }}>
            <div style={mono({ display: "grid", gridTemplateColumns: tableCols, gap: 0, alignItems: "center", padding: "11px 8px", borderBottom: "1px solid rgba(22,35,53,0.15)", fontSize: 11.5, letterSpacing: "0.04em", textTransform: "uppercase", color: "rgba(22,35,53,0.45)" })}>
              <div>#</div>
              <div>Candidate</div>
              <div>Decision</div>
              <div>Reviewer signal</div>
              <div>Why</div>
              <div>Ask / RO level</div>
              <div>Main risk</div>
              <div>Next action</div>
            </div>
            {rows.map((c) => {
              const dm = DM(c.decision);
              const rev = REV(c.rev);
              return (
                <div
                  key={c.id}
                  onClick={() => openCandidate(c.id)}
                  style={{ display: "grid", gridTemplateColumns: tableCols, gap: 0, alignItems: "center", padding: "14px 8px", borderBottom: "1px solid rgba(22,35,53,0.09)", cursor: "pointer" }}
                >
                  <div style={mono({ fontSize: 15, color: "rgba(22,35,53,0.4)", fontVariantNumeric: "tabular-nums" })}>{c.rank}</div>
                  <div style={{ paddingRight: 12, minWidth: 0 }}>
                    <div style={{ fontSize: 16.5, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</div>
                    <div style={{ marginTop: 1, fontSize: 13.5, color: "rgba(22,35,53,0.55)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.role}</div>
                  </div>
                  <div style={{ paddingRight: 10 }}>
                    <span style={mono({ display: "inline-block", fontSize: 12, letterSpacing: "0.01em", color: dm.c, background: dm.bg, border: `1px solid ${dm.b}`, borderRadius: 9999, padding: "3px 10px", lineHeight: 1.3, whiteSpace: "nowrap" })}>
                      {dm.label}
                    </span>
                  </div>
                  <div style={{ paddingRight: 10, display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                    <span style={{ width: 7, height: 7, borderRadius: 9999, background: rev.dot, flexShrink: 0 }} />
                    <span style={{ fontSize: 13.5, lineHeight: 1.25, color: rev.c, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{rev.label}</span>
                  </div>
                  <div style={clamp2({ paddingRight: 16, fontSize: 14.5, lineHeight: 1.38, color: "rgba(22,35,53,0.82)" })}>{c.why}</div>
                  <div style={{ paddingRight: 10, minWidth: 0 }}>
                    <div style={mono({ fontSize: 14, color: askColor(c.askTier), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" })} title={`${c.salary} · ${c.roLevel}`}>
                      {c.salary} · {c.roLevel}
                    </div>
                    <div style={clamp2({ marginTop: 1, fontSize: 12.5, lineHeight: 1.25, color: c.mismatch ? "#9E3B28" : "rgba(22,35,53,0.6)" })} title={askTierLabel(c.askTier)}>{askTierLabel(c.askTier)}</div>
                  </div>
                  <div style={clamp2({ paddingRight: 14, fontSize: 14.5, lineHeight: 1.38, color: "rgba(22,35,53,0.82)" })}>{c.flag}</div>
                  <div style={{ paddingRight: 8, display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    <span style={clamp2({ fontSize: 14, lineHeight: 1.35, color: "rgba(22,35,53,0.82)", flex: 1, minWidth: 0 })}>{c.next}</span>
                    {(c.decision === "hold" || c.decision === "blocked") && (
                      <button
                        onClick={(e) => { e.stopPropagation(); openDeep(c.id); }}
                        title="Run deep analysis"
                        aria-label={`Run deep analysis for ${c.name}`}
                        style={mono({
                          cursor: "pointer",
                          width: 26,
                          height: 26,
                          borderRadius: 9999,
                          border: "1px solid rgba(22,35,53,0.28)",
                          background: "transparent",
                          color: "#162335",
                          fontSize: 13,
                          lineHeight: 1,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          padding: 0,
                          flexShrink: 0,
                        })}
                      >
                        ?
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function clamp2(extra: CSSProperties): CSSProperties {
  return {
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
    ...extra,
  } as CSSProperties;
}

// Expanded evidence for a cut row (#2): the already-mapped source, why it
// matters, and the next action — kept out of the row itself so the list stays scannable.
function CutEvidence({ cite, matters, next }: { cite?: string; matters?: string; next: string }) {
  const items: { label: string; value?: string }[] = [
    { label: "Evidence", value: cite },
    { label: "Why it matters", value: matters },
    { label: "Next", value: next },
  ];
  return (
    <div
      style={{
        margin: "0 4px",
        padding: "12px 16px",
        background: "rgba(158,59,40,0.04)",
        borderLeft: "2px solid #9E3B28",
        display: "grid",
        gridTemplateColumns: "minmax(0,1.3fr) minmax(0,2.2fr) auto",
        gap: 20,
      }}
    >
      <div />
      <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: "6px 16px", alignItems: "baseline", minWidth: 0 }}>
        {items.map((it) => (
          <CutEvidenceRow key={it.label} label={it.label} value={it.value} />
        ))}
      </div>
      <div />
    </div>
  );
}

function CutEvidenceRow({ label, value }: { label: string; value?: string }) {
  return (
    <>
      <div style={mono({ fontSize: 10.5, letterSpacing: "0.04em", textTransform: "uppercase", color: "#9E3B28" })}>{label}</div>
      <div style={{ fontSize: 13.5, lineHeight: 1.45, color: value ? ink(0.82) : ink(0.45) }}>{value || "—"}</div>
    </>
  );
}
