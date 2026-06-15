"use client";

import { useEffect, useState } from "react";
import {
  COLORS,
  FONTS,
  CM,
  DM,
  REV,
  SIG,
  askColor,
  askTierLabel,
  logColor,
} from "@/lib/triage/theme";
import type { TimelineRow } from "@/lib/triage/types";
import type { WorkspaceApi } from "./use-workspace";
import { useTriageData } from "./context";
import { getWorkingFileContent } from "@/app/actions/triage";

const C = COLORS;
const F = FONTS;
const ink = (a: number) => `rgba(22,35,53,${a})`;

const TL_COLS = "104px 1.05fr 1.2fr 64px 1.35fr 150px 124px";

interface Props {
  wsApi: WorkspaceApi;
  activeId: string;
  openPool: () => void;
}

export function CandidateScreen({ wsApi, activeId, openPool }: Props) {
  const { candidates, findCandidate } = useTriageData();
  const ws = wsApi.ws;
  const candidate = findCandidate(activeId);
  const total = candidates.length;
  const id = activeId;

  const [tlEditing, setTlEditing] = useState(false);
  const [corrDraft, setCorrDraft] = useState("");
  const [tdraft, setTdraft] = useState("");

  useEffect(() => {
    setTdraft(ws.transcripts[id] ?? "");
    setTlEditing(false);
    setCorrDraft("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!candidate) return null;

  const dm = DM(candidate.decision);
  const rev = REV(candidate.rev);
  const activeDq = !!ws.dq[id];

  const aShowDeep =
    ["interview", "short", "verify"].includes(candidate.decision) || !!ws.deep[id];

  const srcParts = ["Résumé"];
  if (candidate.cover.hasLetter) srcParts.push("Cover letter");
  if (candidate.answers.length) srcParts.push("Application answers");
  srcParts.push("Salary / logistics");
  if (candidate.fireflies?.length) srcParts.push("Fireflies");
  const aSources = srcParts.join(" · ");

  const readRows = [
    { label: "Decision", value: dm.label, labelColor: dm.c },
    { label: "Why", value: candidate.why, labelColor: ink(0.45) },
    { label: "Main risk", value: candidate.flag, labelColor: C.brick },
    { label: "Next action", value: candidate.next, labelColor: ink(0.45) },
    { label: "Sources", value: aSources, labelColor: ink(0.45) },
  ];

  const revBrick = ["conallConcern", "laraConcern", "laraNo"].includes(candidate.rev);
  const revOrange = ["mixed", "second"].includes(candidate.rev);
  const revBar = revBrick ? C.brick : revOrange ? C.orange : ink(0.3);
  const revBg = revBrick ? "rgba(158,59,40,0.05)" : revOrange ? "rgba(231,68,36,0.05)" : ink(0.03);

  const corrLog = ws.corrections[id] ?? [];
  const reps = ws.replies[id] ?? {};

  const effTimeline = wsApi.effTimeline(id);
  const transcriptSaved = (ws.transcripts[id] ?? "") === tdraft && tdraft.length > 0;

  const downloadMd = async () => {
    try {
      const { content } = await getWorkingFileContent({ candidateId: id });
      const blob = new Blob([content], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${id}.md`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      // ignore — download is best-effort
    }
  };

  let coverCommentIdx = 0;

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto", padding: "26px 28px 120px" }}>
      <div style={{ fontFamily: F.mono, fontSize: 13, color: ink(0.5) }}>
        <span style={{ color: C.brick, cursor: "pointer" }} onClick={openPool}>
          ← Pool
        </span>{" "}
        · rank {candidate.rank} of {total}
      </div>

      {/* RED FLAGS */}
      {candidate.redFlags.length > 0 && (
        <div
          style={{
            marginTop: 16,
            border: "1px solid rgba(158,59,40,0.28)",
            borderTop: `3px solid ${C.brick}`,
            background: "rgba(158,59,40,0.045)",
            padding: "18px 22px",
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <div style={{ fontFamily: F.mono, fontSize: 12, letterSpacing: "0.05em", textTransform: "uppercase", color: C.brick }}>
              Red flags — why this is a cut
            </div>
            <span style={{ fontFamily: F.mono, fontSize: 12, color: ink(0.5) }}>{candidate.redFlags.length} found</span>
          </div>
          <div style={{ marginTop: 12, display: "grid" }}>
            {candidate.redFlags.map((f, i) => (
              <div
                key={i}
                style={{
                  display: "grid",
                  gridTemplateColumns: "200px 1fr 150px",
                  gap: 16,
                  alignItems: "baseline",
                  padding: "9px 0",
                  borderTop: "1px solid rgba(158,59,40,0.16)",
                }}
              >
                <div style={{ fontSize: 15, fontWeight: 500, color: C.brick }}>{f.flag}</div>
                <div style={{ fontSize: 14.5, lineHeight: 1.45, color: ink(0.85) }}>{f.detail}</div>
                <div style={{ fontFamily: F.mono, fontSize: 12, color: ink(0.5) }}>{f.source}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* identity + decision */}
      <div style={{ marginTop: 18, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 24, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: 36, fontWeight: 500, letterSpacing: "-0.03em", lineHeight: 1.0 }}>{candidate.name}</h1>
          <div style={{ marginTop: 7, fontSize: 17, color: ink(0.72) }}>
            {candidate.role} ·{" "}
            <span style={{ fontFamily: F.serif, fontStyle: "italic", fontSize: 19 }}>{candidate.company}</span>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 11, alignItems: "flex-end" }}>
          <span
            style={{
              display: "inline-block",
              fontFamily: F.mono,
              fontSize: 15,
              color: dm.c,
              background: dm.bg,
              border: `1px solid ${dm.b}`,
              borderRadius: 9999,
              padding: "6px 16px",
            }}
          >
            {dm.label}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <a
              href={candidate.workableUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontFamily: F.mono, fontSize: 12.5, color: C.brick, textDecoration: "none" }}
            >
              Open in Workable ↗
            </a>
            <button
              onClick={() => wsApi.toggleDq(id)}
              style={{
                cursor: "pointer",
                border: "none",
                background: "transparent",
                color: activeDq ? C.brick : ink(0.55),
                fontFamily: F.mono,
                fontSize: 12.5,
                padding: 0,
                textDecoration: "underline",
                textUnderlineOffset: 3,
              }}
            >
              {activeDq ? "Disqualified ✓" : "Disqualify"}
            </button>
          </div>
        </div>
      </div>

      {/* short decision read */}
      <div style={{ marginTop: 20, maxWidth: 860 }}>
        {readRows.map((r) => (
          <div
            key={r.label}
            style={{
              display: "grid",
              gridTemplateColumns: "120px 1fr",
              gap: 18,
              alignItems: "baseline",
              padding: "11px 0",
              borderTop: `1px solid ${ink(0.1)}`,
            }}
          >
            <div style={{ fontFamily: F.mono, fontSize: 11.5, letterSpacing: "0.04em", textTransform: "uppercase", color: r.labelColor }}>
              {r.label}
            </div>
            <div style={{ fontSize: 15.5, lineHeight: 1.5, color: C.navy }}>{r.value}</div>
          </div>
        ))}
      </div>

      {/* reviewer signal */}
      <div style={{ marginTop: 14, display: "flex", gap: 10, alignItems: "flex-start", background: revBg, borderLeft: `2px solid ${revBar}`, padding: "10px 13px", maxWidth: 760 }}>
        <span style={{ width: 8, height: 8, borderRadius: 9999, background: rev.dot, marginTop: 6, flexShrink: 0 }} />
        <div>
          <span style={{ fontFamily: F.mono, fontSize: 11.5, letterSpacing: "0.04em", textTransform: "uppercase", color: rev.c }}>
            Reviewer signal — {rev.label}.{" "}
          </span>
          <span style={{ fontSize: 14.5, lineHeight: 1.45, color: ink(0.82) }}>{candidate.revNote}</span>
        </div>
      </div>

      {/* corrections applied */}
      {corrLog.length > 0 && (
        <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10, background: "rgba(231,68,36,0.06)", borderLeft: `2px solid ${C.orange}`, padding: "9px 13px", maxWidth: 760, flexWrap: "wrap" }}>
          <span style={{ fontFamily: F.mono, fontSize: 11.5, textTransform: "uppercase", letterSpacing: "0.04em", color: C.orange }}>
            {corrLog.length} correction(s) applied
          </span>
          <span style={{ fontSize: 14, color: ink(0.78) }}>Claude updated this record from your notes — see the working file below.</span>
        </div>
      )}

      {/* re-analysis */}
      {candidate.reanalysis && (
        <div style={{ marginTop: 14, border: "1px solid rgba(158,59,40,0.25)", borderTop: `2px solid ${C.brick}`, background: "rgba(158,59,40,0.04)", padding: "16px 20px", maxWidth: 760 }}>
          <div style={{ fontFamily: F.mono, fontSize: 11.5, letterSpacing: "0.05em", textTransform: "uppercase", color: C.brick }}>
            Re-analysis · human signal — {candidate.reanalysis.reviewer}
          </div>
          <div style={{ marginTop: 9, display: "flex", alignItems: "center", gap: 12, fontSize: 17, fontWeight: 500 }}>
            <span style={{ color: ink(0.55), textDecoration: "line-through" }}>{candidate.reanalysis.before}</span>
            <span style={{ color: ink(0.4) }}>→</span>
            <span style={{ color: C.brick }}>{candidate.reanalysis.after}</span>
          </div>
          <div style={{ marginTop: 9, fontSize: 14.5, lineHeight: 1.5, color: ink(0.85) }}>{candidate.reanalysis.rec}</div>
        </div>
      )}

      {/* deep gating */}
      {!aShowDeep && (
        <div style={{ marginTop: 24 }}>
          <button
            onClick={() => wsApi.runDeep(id)}
            style={{
              cursor: "pointer",
              border: `1px solid ${C.navy}`,
              background: "transparent",
              color: C.navy,
              borderRadius: 9999,
              padding: "9px 18px",
              fontFamily: F.mono,
              fontSize: 12.5,
              whiteSpace: "nowrap",
            }}
          >
            Run deep analysis anyway →
          </button>
        </div>
      )}

      {aShowDeep && (
        <>
          {/* COMPARE STRIP */}
          <div style={{ marginTop: 26, border: `1px solid ${ink(0.12)}`, background: "#fff", display: "grid", gridTemplateColumns: "1fr 1fr 1.5fr" }}>
            <div style={{ padding: "18px 22px", borderRight: `1px solid ${ink(0.1)}` }}>
              <div style={{ fontFamily: F.mono, fontSize: 11.5, letterSpacing: "0.04em", textTransform: "uppercase", color: ink(0.5) }}>Salary ask</div>
              <div style={{ marginTop: 7, fontFamily: F.mono, fontSize: 30, fontWeight: 500, color: C.navy }}>{candidate.salary}</div>
              <div style={{ marginTop: 4, fontSize: 14, lineHeight: 1.4, color: askColor(candidate.askTier) }}>
                {askTierLabel(candidate.askTier)} · {candidate.askNote}
              </div>
            </div>
            <div style={{ padding: "18px 22px", borderRight: `1px solid ${ink(0.1)}` }}>
              <div style={{ fontFamily: F.mono, fontSize: 11.5, letterSpacing: "0.04em", textTransform: "uppercase", color: ink(0.5) }}>RO level</div>
              <div style={{ marginTop: 7, fontFamily: F.mono, fontSize: 30, fontWeight: 500, color: C.navy }}>{candidate.roLevel}</div>
              <div style={{ marginTop: 4, fontSize: 14, lineHeight: 1.4, color: ink(0.7) }}>{candidate.roVsPool}</div>
            </div>
            <div style={{ padding: "18px 22px", background: candidate.mismatch ? "rgba(158,59,40,0.05)" : ink(0.02) }}>
              <div style={{ fontFamily: F.mono, fontSize: 11.5, letterSpacing: "0.04em", textTransform: "uppercase", color: candidate.mismatch ? C.brick : C.navy }}>
                {candidate.mismatchLabel ?? (candidate.mismatch ? "Ask / level mismatch" : "Ask / level fit")}
              </div>
              <div style={{ marginTop: 7, fontSize: 17, lineHeight: 1.4, fontWeight: 500, color: C.navy }}>{candidate.mismatchRead}</div>
            </div>
          </div>

          {/* RO TIME PROGRESSION */}
          <div style={{ marginTop: 38 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, flexWrap: "wrap", borderBottom: `1px solid ${ink(0.15)}`, paddingBottom: 9 }}>
              <h2 style={{ margin: 0, fontSize: 23, fontWeight: 500, letterSpacing: "-0.02em" }}>RO-style time progression</h2>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {tlEditing && (
                  <>
                    <TlAddButton label="+ Role" onClick={() => { wsApi.addRow(id, "role"); setTlEditing(true); }} />
                    <TlAddButton label="+ Gap" onClick={() => { wsApi.addRow(id, "gap"); setTlEditing(true); }} />
                    <TlAddButton label="+ Cert" onClick={() => { wsApi.addRow(id, "cert"); setTlEditing(true); }} />
                  </>
                )}
                <button
                  onClick={() => setTlEditing((v) => !v)}
                  style={{
                    cursor: "pointer",
                    border: "none",
                    background: "transparent",
                    color: tlEditing || ws.ovr[id] ? C.orange : ink(0.5),
                    fontFamily: F.mono,
                    fontSize: 12,
                    textDecoration: "underline",
                    textUnderlineOffset: 3,
                    padding: 0,
                  }}
                >
                  {tlEditing ? "Done editing" : ws.ovr[id] ? "Edit timeline · edited" : "Edit timeline"}
                </button>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: TL_COLS, padding: "10px 6px", fontFamily: F.mono, fontSize: 10.5, letterSpacing: "0.03em", textTransform: "uppercase", color: ink(0.42), borderBottom: `1px solid ${ink(0.09)}` }}>
              <div>Period</div>
              <div>Org / school</div>
              <div>Role</div>
              <div>Tenure</div>
              <div>Level / scope</div>
              <div>Language level</div>
              <div>Signal</div>
            </div>
            {effTimeline.map((r: TimelineRow, idx: number) => {
              const sc = SIG(r.signal);
              const isEdu = r.type === "edu";
              const isCert = r.type === "cert";
              const isGap = r.type === "gap";
              const rowBg =
                isGap || r.signal === "Gap" || r.signal === "Switched" || r.signal === "Inflated"
                  ? "rgba(158,59,40,0.03)"
                  : isEdu || isCert
                    ? ink(0.02)
                    : "transparent";
              const bb = tlEditing ? ink(0.2) : "transparent";
              const cellInput = (field: keyof TimelineRow, value: string, extra: React.CSSProperties): React.ReactNode => (
                <input
                  value={value}
                  onChange={(e) => wsApi.editCell(id, idx, field, e.target.value)}
                  readOnly={!tlEditing}
                  style={{
                    width: "100%",
                    border: "none",
                    borderBottom: `1px solid ${bb}`,
                    background: "transparent",
                    outline: "none",
                    ...extra,
                  }}
                />
              );
              return (
                <div key={idx} style={{ display: "grid", gridTemplateColumns: TL_COLS, padding: "11px 6px", alignItems: "baseline", borderBottom: `1px solid ${ink(0.08)}`, background: rowBg }}>
                  {cellInput("period", r.period, { padding: "2px 4px 2px 0", fontFamily: F.mono, fontSize: 13, color: isGap ? C.brick : ink(0.7) })}
                  {cellInput("org", r.org, {
                    padding: "2px 8px 2px 0",
                    fontSize: 14.5,
                    color: isEdu || isCert ? ink(0.65) : C.navy,
                    fontStyle: isEdu || isCert ? "italic" : "normal",
                    fontFamily: isEdu || isCert ? F.serif : F.sans,
                  })}
                  {cellInput("role", r.role, { padding: "2px 8px 2px 0", fontSize: 14.5, color: C.navy, fontFamily: F.sans })}
                  {cellInput("tenure", r.tenure, { padding: "2px 4px 2px 0", fontFamily: F.mono, fontSize: 13, color: ink(0.7) })}
                  {cellInput("scope", r.scope, { padding: "2px 10px 2px 0", fontSize: 13.5, color: ink(0.78), fontFamily: F.sans })}
                  <div style={{ fontSize: 13, color: r.lang.includes("inflated") ? C.brick : ink(0.7), paddingRight: 10, lineHeight: 1.4 }}>{r.lang}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span style={{ fontFamily: F.mono, fontSize: 11.5, color: sc.c, background: sc.bg, borderRadius: 9999, padding: "2px 9px", whiteSpace: "nowrap" }}>{r.signal}</span>
                    {tlEditing && (
                      <button onClick={() => wsApi.removeRow(id, idx)} style={{ cursor: "pointer", border: "none", background: "transparent", color: C.brick, fontSize: 16, lineHeight: 1, padding: 0 }}>
                        ×
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* COVER LETTER */}
      <SectionTitle title="Cover letter" />
      {candidate.cover.hasLetter ? (
        <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr 300px", gap: 36, alignItems: "start" }}>
          <div style={{ background: "#fff", border: `1px solid ${ink(0.1)}`, padding: "30px 34px", fontSize: 16, lineHeight: 1.75, color: C.navy }}>
            {candidate.cover.lines.map((ln, i) => (
              <span key={i}>
                <span style={{ background: CM(ln.kind).hl, padding: "1px 0", boxDecorationBreak: "clone", WebkitBoxDecorationBreak: "clone" }}>{ln.t}</span>{" "}
              </span>
            ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {candidate.cover.lines
              .filter((ln) => ln.comment)
              .map((ln) => {
                const m = CM(ln.kind);
                const key = `cover-${coverCommentIdx++}`;
                return (
                  <MarginComment
                    key={key}
                    color={m.color}
                    label={m.label}
                    note={ln.comment ?? ""}
                    reply={reps[key] ?? ""}
                    onReply={(v) => wsApi.setReply(id, key, v)}
                  />
                );
              })}
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 14, border: "1px dashed rgba(158,59,40,0.4)", background: "rgba(158,59,40,0.04)", padding: "18px 22px", fontSize: 15, color: C.brick }}>
          No cover letter submitted.{" "}
          <span style={{ color: ink(0.7) }}>For a role built on care and detail, a blank cover letter is itself a signal.</span>
        </div>
      )}

      {/* APPLICATION ANSWERS */}
      <SectionTitle title="Application answers" />
      <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 16 }}>
        {candidate.answers.map((qa, i) => {
          const m = CM(qa.kind);
          const key = `ans-${i}`;
          return (
            <div key={key} style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 36, alignItems: "start" }}>
              <div style={{ background: "#fff", border: `1px solid ${ink(0.1)}`, borderLeft: `3px solid ${m.color}`, padding: "18px 22px" }}>
                <div style={{ fontFamily: F.mono, fontSize: 12, letterSpacing: "0.02em", color: ink(0.5) }}>{qa.q}</div>
                <div style={{ marginTop: 8, fontSize: 15.5, lineHeight: 1.6, color: C.navy }}>
                  <span style={{ background: m.hl, padding: "1px 0" }}>{qa.a}</span>
                </div>
              </div>
              {qa.comment ? (
                <MarginComment color={m.color} label={m.label} note={qa.comment} reply={reps[key] ?? ""} onReply={(v) => wsApi.setReply(id, key, v)} />
              ) : (
                <div />
              )}
            </div>
          );
        })}
      </div>

      {/* LOGISTICS */}
      <SectionTitle title="Logistics check" right={<span style={{ fontFamily: F.mono, fontSize: 12, color: ink(0.5) }}>{candidate.logistics.mode}</span>} />
      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "280px 1fr", gap: 36, alignItems: "start" }}>
        <div style={{ border: `1px solid ${ink(0.12)}`, background: "#fff", padding: "18px 20px" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
            <span style={{ fontFamily: F.mono, fontSize: 11.5, textTransform: "uppercase", letterSpacing: "0.04em", color: ink(0.5) }}>Likelihood</span>
            <span style={{ fontFamily: F.mono, fontSize: 18, fontWeight: 500, color: logColor(candidate.logistics.likelihood) }}>{candidate.logistics.likelihood}</span>
          </div>
          <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "auto 1fr", gap: "7px 14px", fontSize: 14 }}>
            <span style={{ fontFamily: F.mono, fontSize: 11.5, textTransform: "uppercase", color: ink(0.5), paddingTop: 2 }}>Based</span>
            <span style={{ color: ink(0.85) }}>{candidate.logistics.location}</span>
            <span style={{ fontFamily: F.mono, fontSize: 11.5, textTransform: "uppercase", color: ink(0.5), paddingTop: 2 }}>To VN</span>
            <span style={{ color: ink(0.85) }}>{candidate.logistics.distance}</span>
          </div>
        </div>
        <div>
          <div style={{ fontSize: 16, lineHeight: 1.55, color: ink(0.88) }}>{candidate.logistics.read}</div>
          <div style={{ marginTop: 12 }}>
            {candidate.logistics.signals.map((s, i) => (
              <div key={i} style={{ display: "flex", gap: 9, alignItems: "flex-start", padding: "6px 0", borderTop: `1px solid ${ink(0.08)}`, fontSize: 14, lineHeight: 1.5 }}>
                <span style={{ color: s.mark === "+" ? C.navy : C.brick, flexShrink: 0, fontFamily: F.mono }}>{s.mark}</span>
                <span style={{ color: ink(0.82) }}>{s.t}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* INTERVIEW SUMMARY */}
      <SectionTitle title="Interview summary" />
      {candidate.interview && (
        <div style={{ marginTop: 16, border: `1px solid ${ink(0.12)}`, borderTop: `2px solid ${C.navy}`, background: "#fff", padding: "20px 22px" }}>
          <div style={{ fontFamily: F.mono, fontSize: 12, letterSpacing: "0.03em", color: ink(0.6) }}>{candidate.interview.title}</div>
          <div style={{ marginTop: 10, fontSize: 16, lineHeight: 1.55, color: ink(0.88) }}>{candidate.interview.fit}</div>
          <div style={{ marginTop: 12 }}>
            {candidate.interview.points.map((p, i) => (
              <div key={i} style={{ display: "flex", gap: 9, alignItems: "flex-start", padding: "6px 0", borderTop: `1px solid ${ink(0.08)}`, fontSize: 14.5, lineHeight: 1.5 }}>
                <span style={{ color: p.mark === "+" ? C.navy : C.brick, flexShrink: 0, fontFamily: F.mono }}>{p.mark}</span>
                <span style={{ color: ink(0.82) }}>{p.t}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Fireflies */}
      <div style={{ marginTop: 18, border: `1px solid ${ink(0.12)}`, background: "#fff", padding: "16px 18px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <span style={{ width: 9, height: 9, borderRadius: 9999, background: C.orange, flexShrink: 0 }} />
            <span style={{ fontFamily: F.mono, fontSize: 12, letterSpacing: "0.03em", textTransform: "uppercase", color: C.navy }}>Fireflies · connected</span>
          </div>
          <span style={{ fontFamily: F.mono, fontSize: 12, color: ink(0.5) }}>
            {candidate.fireflies?.length
              ? `${candidate.fireflies.length} recording${candidate.fireflies.length > 1 ? "s" : ""} matched`
              : "Watching for new meetings"}
          </span>
        </div>
        {candidate.fireflies?.length ? (
          <div style={{ marginTop: 8 }}>
            {candidate.fireflies.map((f, i) => {
              const pulled = (ws.transcripts[id] ?? "") === f.transcript;
              return (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 14, alignItems: "center", padding: "11px 0", borderTop: `1px solid ${ink(0.08)}` }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 500, color: C.navy }}>{f.title}</div>
                    <div style={{ marginTop: 2, fontFamily: F.mono, fontSize: 12, color: ink(0.55) }}>
                      {f.date} · {f.dur}
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      wsApi.setTranscript(id, f.transcript);
                      setTdraft(f.transcript);
                    }}
                    style={{
                      cursor: "pointer",
                      border: `1px solid ${pulled ? C.orange : C.navy}`,
                      background: "transparent",
                      color: pulled ? C.orange : C.navy,
                      borderRadius: 9999,
                      padding: "6px 16px",
                      fontFamily: F.mono,
                      fontSize: 12.5,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {pulled ? "Pulled ✓" : "Pull in"}
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ marginTop: 10, fontSize: 14, color: ink(0.55) }}>
            No Fireflies recordings matched this candidate yet — new meetings sync here automatically.
          </div>
        )}
      </div>

      {/* transcript editor */}
      <div style={{ marginTop: 14 }}>
        <div style={{ fontFamily: F.mono, fontSize: 11.5, textTransform: "uppercase", letterSpacing: "0.04em", color: ink(0.5), marginBottom: 6 }}>
          {ws.transcripts[id] ? "Transcript on file — edit or append" : "No transcript yet — paste or pull from Fireflies"}
        </div>
        <textarea
          value={tdraft}
          onChange={(e) => setTdraft(e.target.value)}
          placeholder="Paste an interview transcript, or pull one from Fireflies above — Claude folds it into this candidate's working file and fit read."
          style={{
            width: "100%",
            minHeight: 110,
            resize: "vertical",
            border: `1px solid ${ink(0.15)}`,
            borderRadius: 4,
            background: "#fff",
            padding: "12px 14px",
            fontFamily: F.sans,
            fontSize: 14,
            lineHeight: 1.55,
            color: C.navy,
            outline: "none",
          }}
        />
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <button
            onClick={() => wsApi.setTranscript(id, tdraft)}
            style={{ cursor: "pointer", border: "none", background: C.navy, color: C.cream, borderRadius: 9999, padding: "9px 18px", fontFamily: F.mono, fontSize: 12.5 }}
          >
            Save transcript &amp; analyze
          </button>
          {transcriptSaved && <span style={{ fontFamily: F.mono, fontSize: 12, color: C.orange }}>Saved ✓ · folded into working file</span>}
        </div>
      </div>

      {/* WORKING FILE */}
      <SectionTitle
        title="Candidate working file"
        titleSuffix={<span style={{ fontFamily: F.mono, fontSize: 13, color: ink(0.45) }}>{id}.md</span>}
        right={
          <button onClick={downloadMd} style={{ cursor: "pointer", border: `1px solid ${ink(0.22)}`, background: "transparent", color: C.navy, borderRadius: 9999, padding: "7px 14px", fontFamily: F.mono, fontSize: 12.5 }}>
            Download .md ↓
          </button>
        }
      />
      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 40px", alignItems: "start" }}>
        <div>
          <div style={{ fontFamily: F.mono, fontSize: 11.5, textTransform: "uppercase", letterSpacing: "0.04em", color: ink(0.5), marginBottom: 8 }}>Corrections &amp; analysis notes</div>
          <div style={{ fontSize: 14, lineHeight: 1.5, color: ink(0.7), marginBottom: 10 }}>
            Tell Claude what it got wrong — a mis-parsed résumé, a real tenure, anything. It stays on this candidate and updates the record.
          </div>
          <textarea
            value={corrDraft}
            onChange={(e) => setCorrDraft(e.target.value)}
            placeholder="e.g. Résumé mis-parsed — this person's Quartz Dx tenure was actually 19 years, not 3."
            style={{
              width: "100%",
              minHeight: 70,
              resize: "vertical",
              border: `1px solid ${ink(0.15)}`,
              borderRadius: 4,
              background: "#fff",
              padding: "11px 13px",
              fontFamily: F.sans,
              fontSize: 14,
              lineHeight: 1.5,
              color: C.navy,
              outline: "none",
            }}
          />
          <button
            onClick={() => {
              wsApi.addCorrection(id, corrDraft);
              setCorrDraft("");
            }}
            style={{ marginTop: 9, cursor: "pointer", border: "none", background: C.navy, color: C.cream, borderRadius: 9999, padding: "8px 16px", fontFamily: F.mono, fontSize: 12.5 }}
          >
            Save correction &amp; re-analyze
          </button>
        </div>
        <div>
          <div style={{ fontFamily: F.mono, fontSize: 11.5, textTransform: "uppercase", letterSpacing: "0.04em", color: ink(0.5), marginBottom: 8 }}>Correction log</div>
          {corrLog.length > 0 ? (
            corrLog
              .slice()
              .reverse()
              .map((e, i) => (
                <div key={i} style={{ borderLeft: `2px solid ${C.orange}`, padding: "3px 0 3px 12px", marginBottom: 12 }}>
                  <div style={{ fontFamily: F.mono, fontSize: 11, color: ink(0.45) }}>{e.ts} · applied</div>
                  <div style={{ marginTop: 3, fontSize: 14.5, lineHeight: 1.5, color: C.navy }}>{e.text}</div>
                </div>
              ))
          ) : (
            <div style={{ fontSize: 14, color: ink(0.5) }}>No corrections yet. The record reflects Claude&apos;s parse of the submitted materials.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionTitle({
  title,
  titleSuffix,
  right,
}: {
  title: string;
  titleSuffix?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div style={{ marginTop: 42, display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, flexWrap: "wrap", borderBottom: `1px solid ${ink(0.15)}`, paddingBottom: 9 }}>
      <h2 style={{ margin: 0, fontSize: 23, fontWeight: 500, letterSpacing: "-0.02em" }}>
        {title} {titleSuffix}
      </h2>
      {right}
    </div>
  );
}

function MarginComment({
  color,
  label,
  note,
  reply,
  onReply,
}: {
  color: string;
  label: string;
  note: string;
  reply: string;
  onReply: (v: string) => void;
}) {
  return (
    <div style={{ border: `1px solid ${ink(0.12)}`, borderLeft: `3px solid ${color}`, background: "#fff", padding: "11px 13px", boxShadow: "0 1px 0 rgba(22,35,53,0.05)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span style={{ width: 18, height: 18, borderRadius: 9999, background: color, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontFamily: F.mono }}>C</span>
        <span style={{ fontFamily: F.mono, fontSize: 11, letterSpacing: "0.03em", textTransform: "uppercase", color }}>{label}</span>
      </div>
      <div style={{ marginTop: 6, fontSize: 13.5, lineHeight: 1.45, color: ink(0.85) }}>{note}</div>
      <input
        value={reply}
        onChange={(e) => onReply(e.target.value)}
        placeholder="↳ Reply to train Claude…"
        style={{ marginTop: 9, width: "100%", border: "none", borderTop: `1px solid ${ink(0.1)}`, background: "transparent", outline: "none", padding: "8px 0 0", fontFamily: F.sans, fontSize: 13, color: C.navy }}
      />
    </div>
  );
}

function TlAddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ cursor: "pointer", border: `1px solid ${ink(0.22)}`, background: "transparent", color: C.navy, borderRadius: 9999, padding: "4px 11px", fontFamily: F.mono, fontSize: 11.5 }}>
      {label}
    </button>
  );
}
