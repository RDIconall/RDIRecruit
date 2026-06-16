"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
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
import type { ReviewerKind, TimelineRow } from "@/lib/triage/types";
import { REVIEWER_OPTIONS } from "@/lib/triage/reviewer";
import type { WorkspaceApi } from "./use-workspace";
import { useTriageData } from "./context";
import { useIsNarrow } from "./use-media-query";
import { getWorkingFileContent, saveJobRubric } from "@/app/actions/triage";

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
  const { candidates, findCandidate, viewer, meta, rubricMd, specMd } = useTriageData();
  const router = useRouter();
  const ws = wsApi.ws;
  const candidate = findCandidate(activeId);
  const total = candidates.length;
  const id = activeId;
  const narrow = useIsNarrow();

  const [tlEditing, setTlEditing] = useState(false);
  const [corrDraft, setCorrDraft] = useState("");
  const [tdraft, setTdraft] = useState("");
  const [reviewerKind, setReviewerKind] = useState<ReviewerKind>(viewer.kind);
  // Inline working-file (.md) viewer — loaded lazily when the section opens.
  const [wfContent, setWfContent] = useState<string | null>(null);
  // Rubric / spec editing.
  const [rubricEditing, setRubricEditing] = useState(false);
  const [specEditing, setSpecEditing] = useState(false);
  const [rubricDraft, setRubricDraft] = useState(rubricMd);
  const [specDraft, setSpecDraft] = useState(specMd);
  const [rubricSaving, setRubricSaving] = useState(false);
  const rubricFileRef = useRef<HTMLInputElement>(null);
  const specFileRef = useRef<HTMLInputElement>(null);
  // #4: lower material sections are collapsible. Default open so the spec's
  // below-the-fold content stays visible; the 5-line read remains the headline.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ rubric: true });
  const isOpen = (k: string) => !collapsed[k];
  const toggleSection = (k: string) => setCollapsed((c) => ({ ...c, [k]: !c[k] }));

  useEffect(() => {
    setTdraft(ws.transcripts[id] ?? "");
    setTlEditing(false);
    setCorrDraft("");
    setReviewerKind(viewer.kind);
    setWfContent(null);
    // The pool and candidate views share the document scroll position; reset to
    // the top so a candidate opens at the header rather than mid-page.
    window.scrollTo(0, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Keep rubric/spec drafts in sync with the latest server-fed values (e.g. after refresh).
  useEffect(() => {
    if (!rubricEditing) setRubricDraft(rubricMd);
    if (!specEditing) setSpecDraft(specMd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rubricMd, specMd]);

  // Load (and refresh) the inline working-file .md whenever the candidate changes or
  // Claude re-derives the read (decision / why / rubric fit move after a recalc).
  useEffect(() => {
    let cancelled = false;
    void getWorkingFileContent({ candidateId: id })
      .then(({ content }) => {
        if (!cancelled) setWfContent(content);
      })
      .catch(() => {
        if (!cancelled) setWfContent("Could not load the working file. Try Download .md instead.");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, candidate?.decision, candidate?.why, candidate?.rubricFit]);

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

  const saveRubric = async (which: "rubric" | "spec") => {
    setRubricSaving(true);
    try {
      await saveJobRubric({
        jobShortcode: meta.jobShortcode,
        ...(which === "rubric" ? { rubricMd: rubricDraft } : { specMd: specDraft }),
      });
      if (which === "rubric") setRubricEditing(false);
      else setSpecEditing(false);
      router.refresh();
    } finally {
      setRubricSaving(false);
    }
  };

  // Upload a .md (or any text) file and save it as this job's rubric / spec.
  const onUploadFile = async (which: "rubric" | "spec", file: File | null) => {
    if (!file) return;
    const text = await file.text();
    if (which === "rubric") {
      setRubricDraft(text);
      setRubricEditing(true);
    } else {
      setSpecDraft(text);
      setSpecEditing(true);
    }
    setRubricSaving(true);
    try {
      await saveJobRubric({
        jobShortcode: meta.jobShortcode,
        ...(which === "rubric" ? { rubricMd: text } : { specMd: text }),
      });
      if (which === "rubric") setRubricEditing(false);
      else setSpecEditing(false);
      router.refresh();
    } finally {
      setRubricSaving(false);
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
                  gridTemplateColumns: narrow ? "1fr" : "200px 1fr 150px",
                  gap: narrow ? 2 : 16,
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
              onClick={() => wsApi.resync(id)}
              disabled={!!wsApi.busy[id]}
              style={{
                cursor: wsApi.busy[id] ? "default" : "pointer",
                border: "none",
                background: "transparent",
                color: wsApi.busy[id] ? ink(0.4) : C.navy,
                fontFamily: F.mono,
                fontSize: 12.5,
                padding: 0,
                textDecoration: "underline",
                textUnderlineOffset: 3,
              }}
            >
              {wsApi.busy[id] ? "Syncing…" : "Sync from Workable ↻"}
            </button>
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

      {/* RUBRIC FIT — Claude's read of this candidate against the job rubric */}
      {(candidate.rubricFit || rubricMd) && (
        <div style={{ marginTop: 16, border: `1px solid ${ink(0.12)}`, borderTop: `3px solid ${C.navy}`, background: "#fff", padding: "18px 22px", maxWidth: 860 }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div style={{ fontFamily: F.mono, fontSize: 11.5, letterSpacing: "0.05em", textTransform: "uppercase", color: ink(0.5) }}>
              Rubric fit{candidate.rubricFit?.verdict ? ` — ` : ""}
              {candidate.rubricFit?.verdict && <span style={{ color: C.navy }}>{candidate.rubricFit.verdict}</span>}
            </div>
            <button
              onClick={() => wsApi.compareRubric(id)}
              disabled={!!wsApi.busy[id]}
              style={{
                cursor: wsApi.busy[id] ? "default" : "pointer",
                border: `1px solid ${C.navy}`,
                background: "transparent",
                color: wsApi.busy[id] ? ink(0.4) : C.navy,
                borderRadius: 9999,
                padding: "6px 14px",
                fontFamily: F.mono,
                fontSize: 12,
                whiteSpace: "nowrap",
              }}
            >
              {wsApi.busy[id] ? "Comparing…" : candidate.rubricFit ? "Re-compare to rubric ↻" : "Compare to rubric →"}
            </button>
          </div>
          {candidate.rubricFit ? (
            <>
              {candidate.rubricFit.summary && (
                <div style={{ marginTop: 11, fontSize: 15.5, lineHeight: 1.55, color: C.navy }}>{candidate.rubricFit.summary}</div>
              )}
              <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: narrow ? "1fr" : "1fr 1fr", gap: narrow ? 14 : 28 }}>
                <div>
                  <div style={{ fontFamily: F.mono, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", color: C.navy }}>Rubric-aligned strengths</div>
                  <div style={{ marginTop: 8 }}>
                    {candidate.rubricFit.strengths.length ? (
                      candidate.rubricFit.strengths.map((sigq, i) => (
                        <div key={i} style={{ display: "flex", gap: 9, alignItems: "flex-start", padding: "5px 0", borderTop: `1px solid ${ink(0.08)}`, fontSize: 14, lineHeight: 1.5 }}>
                          <span style={{ color: C.navy, flexShrink: 0, fontFamily: F.mono }}>+</span>
                          <span style={{ color: ink(0.85) }}>{sigq}</span>
                        </div>
                      ))
                    ) : (
                      <div style={{ fontSize: 13.5, color: ink(0.5) }}>—</div>
                    )}
                  </div>
                </div>
                <div>
                  <div style={{ fontFamily: F.mono, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", color: C.brick }}>Rubric gaps</div>
                  <div style={{ marginTop: 8 }}>
                    {candidate.rubricFit.gaps.length ? (
                      candidate.rubricFit.gaps.map((g, i) => (
                        <div key={i} style={{ display: "flex", gap: 9, alignItems: "flex-start", padding: "5px 0", borderTop: `1px solid ${ink(0.08)}`, fontSize: 14, lineHeight: 1.5 }}>
                          <span style={{ color: C.brick, flexShrink: 0, fontFamily: F.mono }}>–</span>
                          <span style={{ color: ink(0.85) }}>{g}</span>
                        </div>
                      ))
                    ) : (
                      <div style={{ fontSize: 13.5, color: ink(0.5) }}>—</div>
                    )}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div style={{ marginTop: 10, fontSize: 14.5, lineHeight: 1.5, color: ink(0.6) }}>
              No rubric comparison yet. Run a comparison to see how this candidate maps to the {meta.title} rubric and why they are (or are not) a good fit — the read is also folded into the working file.
            </div>
          )}
        </div>
      )}

      {/* JOB RUBRIC & SPEC — the rubric Claude grades against, and the role spec. Both editable.
          Collapsed by default (the rubric is long); the header sits right under the fit read. */}
      <SectionTitle
        title="Job rubric & spec"
        titleSuffix={<span style={{ fontFamily: F.mono, fontSize: 13, color: ink(0.45) }}>{meta.title}</span>}
        open={isOpen("rubric")}
        onToggle={() => toggleSection("rubric")}
      />
      {isOpen("rubric") && (
        <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: narrow ? "1fr" : "1fr 1fr", gap: narrow ? 28 : 36, alignItems: "start" }}>
          {/* Grading rubric */}
          <div>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
              <div style={{ fontFamily: F.mono, fontSize: 11.5, textTransform: "uppercase", letterSpacing: "0.04em", color: ink(0.5) }}>Grading rubric</div>
              <input
                ref={rubricFileRef}
                type="file"
                accept=".md,.markdown,.txt,text/markdown,text/plain"
                style={{ display: "none" }}
                onChange={(e) => { void onUploadFile("rubric", e.target.files?.[0] ?? null); e.target.value = ""; }}
              />
              {rubricEditing ? (
                <div style={{ display: "flex", gap: 12 }}>
                  <button onClick={() => { setRubricEditing(false); setRubricDraft(rubricMd); }} style={{ cursor: "pointer", border: "none", background: "transparent", color: ink(0.5), fontFamily: F.mono, fontSize: 12, padding: 0 }}>Cancel</button>
                  <button onClick={() => saveRubric("rubric")} disabled={rubricSaving} style={{ cursor: "pointer", border: "none", background: "transparent", color: C.orange, fontFamily: F.mono, fontSize: 12, padding: 0, textDecoration: "underline", textUnderlineOffset: 3 }}>{rubricSaving ? "Saving…" : "Save rubric"}</button>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 12 }}>
                  <button onClick={() => rubricFileRef.current?.click()} disabled={rubricSaving} style={{ cursor: "pointer", border: "none", background: "transparent", color: C.navy, fontFamily: F.mono, fontSize: 12, padding: 0, textDecoration: "underline", textUnderlineOffset: 3 }}>{rubricSaving ? "Uploading…" : "Upload .md ↑"}</button>
                  <button onClick={() => { setRubricDraft(rubricMd); setRubricEditing(true); }} style={{ cursor: "pointer", border: "none", background: "transparent", color: ink(0.5), fontFamily: F.mono, fontSize: 12, padding: 0, textDecoration: "underline", textUnderlineOffset: 3 }}>Edit</button>
                </div>
              )}
            </div>
            {rubricEditing ? (
              <textarea
                value={rubricDraft}
                onChange={(e) => setRubricDraft(e.target.value)}
                style={{ marginTop: 10, width: "100%", minHeight: 360, resize: "vertical", border: `1px solid ${ink(0.15)}`, borderRadius: 4, background: "#fff", padding: "12px 14px", fontFamily: F.mono, fontSize: 12.5, lineHeight: 1.55, color: C.navy, outline: "none" }}
              />
            ) : rubricMd ? (
              <pre style={{ marginTop: 10, maxHeight: 420, overflow: "auto", border: `1px solid ${ink(0.1)}`, background: "#fff", padding: "14px 16px", fontFamily: F.mono, fontSize: 12.5, lineHeight: 1.55, color: ink(0.85), whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{rubricMd}</pre>
            ) : (
              <div style={{ marginTop: 10, border: "1px dashed rgba(22,35,53,0.25)", background: ink(0.02), padding: "16px 18px", fontSize: 14, color: ink(0.6) }}>
                No rubric set for {meta.title} yet. Upload an .md file or click Edit to paste one — Claude will then grade candidates for this job against it.
              </div>
            )}
          </div>
          {/* Role spec */}
          <div>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
              <div style={{ fontFamily: F.mono, fontSize: 11.5, textTransform: "uppercase", letterSpacing: "0.04em", color: ink(0.5) }}>Role spec</div>
              <input
                ref={specFileRef}
                type="file"
                accept=".md,.markdown,.txt,text/markdown,text/plain"
                style={{ display: "none" }}
                onChange={(e) => { void onUploadFile("spec", e.target.files?.[0] ?? null); e.target.value = ""; }}
              />
              {specEditing ? (
                <div style={{ display: "flex", gap: 12 }}>
                  <button onClick={() => { setSpecEditing(false); setSpecDraft(specMd); }} style={{ cursor: "pointer", border: "none", background: "transparent", color: ink(0.5), fontFamily: F.mono, fontSize: 12, padding: 0 }}>Cancel</button>
                  <button onClick={() => saveRubric("spec")} disabled={rubricSaving} style={{ cursor: "pointer", border: "none", background: "transparent", color: C.orange, fontFamily: F.mono, fontSize: 12, padding: 0, textDecoration: "underline", textUnderlineOffset: 3 }}>{rubricSaving ? "Saving…" : "Save spec"}</button>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 12 }}>
                  <button onClick={() => specFileRef.current?.click()} disabled={rubricSaving} style={{ cursor: "pointer", border: "none", background: "transparent", color: C.navy, fontFamily: F.mono, fontSize: 12, padding: 0, textDecoration: "underline", textUnderlineOffset: 3 }}>{rubricSaving ? "Uploading…" : "Upload .md ↑"}</button>
                  <button onClick={() => { setSpecDraft(specMd); setSpecEditing(true); }} style={{ cursor: "pointer", border: "none", background: "transparent", color: ink(0.5), fontFamily: F.mono, fontSize: 12, padding: 0, textDecoration: "underline", textUnderlineOffset: 3 }}>Edit</button>
                </div>
              )}
            </div>
            {specEditing ? (
              <textarea
                value={specDraft}
                onChange={(e) => setSpecDraft(e.target.value)}
                style={{ marginTop: 10, width: "100%", minHeight: 360, resize: "vertical", border: `1px solid ${ink(0.15)}`, borderRadius: 4, background: "#fff", padding: "12px 14px", fontFamily: F.mono, fontSize: 12.5, lineHeight: 1.55, color: C.navy, outline: "none" }}
              />
            ) : specMd ? (
              <pre style={{ marginTop: 10, maxHeight: 420, overflow: "auto", border: `1px solid ${ink(0.1)}`, background: "#fff", padding: "14px 16px", fontFamily: F.mono, fontSize: 12.5, lineHeight: 1.55, color: ink(0.85), whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{specMd}</pre>
            ) : (
              <div style={{ marginTop: 10, border: "1px dashed rgba(22,35,53,0.25)", background: ink(0.02), padding: "16px 18px", fontSize: 14, color: ink(0.6) }}>
                No role spec yet. It seeds from the Workable job description on sync, or upload an .md file / paste one here.
              </div>
            )}
          </div>
        </div>
      )}

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

      {/* cut evidence (#2) — the source, why it matters, and next action for a cut */}
      {candidate.decision === "cut" && (
        <div style={{ marginTop: 14, border: `1px solid rgba(158,59,40,0.22)`, background: "rgba(158,59,40,0.035)", padding: "16px 20px", maxWidth: 760 }}>
          <div style={{ fontFamily: F.mono, fontSize: 11.5, letterSpacing: "0.05em", textTransform: "uppercase", color: C.brick }}>
            Cut evidence
          </div>
          <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "120px 1fr", gap: "8px 18px", alignItems: "baseline" }}>
            {[
              { label: "Evidence", value: candidate.cite },
              { label: "Why it matters", value: candidate.cutMatters },
              { label: "Next action", value: candidate.next },
            ].map((r) => (
              <div key={r.label} style={{ display: "contents" }}>
                <div style={{ fontFamily: F.mono, fontSize: 11, letterSpacing: "0.04em", textTransform: "uppercase", color: C.brick }}>{r.label}</div>
                <div style={{ fontSize: 14.5, lineHeight: 1.5, color: r.value ? ink(0.85) : ink(0.45) }}>{r.value || "—"}</div>
              </div>
            ))}
          </div>
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
          <div style={{ marginTop: 26, border: `1px solid ${ink(0.12)}`, background: "#fff", display: "grid", gridTemplateColumns: narrow ? "1fr" : "1fr 1fr 1.5fr" }}>
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

          {/* CAREER READ (#6) — prose under the compare strip; degrades when no dig_in */}
          {candidate.careerRead && (
            <div style={{ marginTop: 24, border: `1px solid ${ink(0.12)}`, borderLeft: `2px solid ${C.orange}`, background: "#fff", padding: "18px 22px" }}>
              <div style={{ fontFamily: F.mono, fontSize: 11.5, letterSpacing: "0.05em", textTransform: "uppercase", color: ink(0.5) }}>Career read</div>
              <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: narrow ? "1fr" : "150px 1fr", gap: narrow ? "4px 0" : "10px 20px", alignItems: "baseline" }}>
                {[
                  { label: "Career path", value: candidate.careerRead.path },
                  { label: "Positive read", value: candidate.careerRead.positive },
                  { label: "Risk read", value: candidate.careerRead.risk },
                  { label: "Decision implication", value: candidate.careerRead.implication },
                ].map((r, i) => (
                  <div key={r.label} style={{ display: "contents" }}>
                    <div style={{ fontFamily: F.mono, fontSize: 11, letterSpacing: "0.03em", textTransform: "uppercase", color: i === 2 ? C.brick : ink(0.5), paddingTop: narrow ? 8 : 0 }}>{r.label}</div>
                    <div style={{ fontSize: 14.5, lineHeight: 1.5, color: r.value ? ink(0.85) : ink(0.45) }}>{r.value || "—"}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* RO TIME PROGRESSION — the RO timeline, shown for every candidate */}
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
            <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: narrow ? 820 : undefined }}>
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
            </div>
          </div>

      {/* RO CAREER PROGRESSION (sourced from the RO assessment) — shown whenever
          RO data exists, independent of the deep-analysis gate. */}
      {candidate.careerProgression?.hasData && (
        <div style={{ marginTop: 38 }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, flexWrap: "wrap", borderBottom: `1px solid ${ink(0.15)}`, paddingBottom: 9 }}>
            <h2 style={{ margin: 0, fontSize: 23, fontWeight: 500, letterSpacing: "-0.02em" }}>RO career progression</h2>
            <span style={{ fontFamily: F.mono, fontSize: 12, color: ink(0.5) }}>
              Seat calls for {candidate.careerProgression.seatStratum} · reads {candidate.careerProgression.currentCapability}
            </span>
          </div>
          <div style={{ marginTop: 10, fontSize: 14.5, lineHeight: 1.5, color: ink(0.8) }}>
            {candidate.careerProgression.trajectory}
            {candidate.careerProgression.confidenceNote ? ` · ${candidate.careerProgression.confidenceNote}` : ""}
          </div>
          <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: narrow ? 720 : undefined }}>
          <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1.2fr 90px 96px 1.4fr", padding: "10px 6px", fontFamily: F.mono, fontSize: 10.5, letterSpacing: "0.03em", textTransform: "uppercase", color: ink(0.42), borderBottom: `1px solid ${ink(0.09)}`, marginTop: 12 }}>
            <div>Role</div>
            <div>Company</div>
            <div>Tenure</div>
            <div>RO stratum</div>
            <div>Scope evidence</div>
          </div>
          {candidate.careerProgression.steps.map((step, idx) => (
            <div key={idx} style={{ display: "grid", gridTemplateColumns: "1.2fr 1.2fr 90px 96px 1.4fr", padding: "11px 6px", alignItems: "baseline", borderBottom: `1px solid ${ink(0.08)}` }}>
              <div style={{ fontSize: 14.5, color: C.navy, paddingRight: 8 }}>{step.role}</div>
              <div style={{ fontSize: 14.5, color: ink(0.78), paddingRight: 8 }}>{step.company}</div>
              <div style={{ fontFamily: F.mono, fontSize: 13, color: ink(0.7) }}>{step.tenure}</div>
              <div style={{ fontFamily: F.mono, fontSize: 13, color: C.navy }}>{step.stratumRange}</div>
              <div style={{ fontSize: 13, color: ink(0.7), paddingRight: 10, lineHeight: 1.45 }}>
                {step.verbs.length ? step.verbs.join(" · ") : "—"}
              </div>
            </div>
          ))}
          </div>
          </div>
        </div>
      )}

      {/* RÉSUMÉ */}
      <SectionTitle
        title="Résumé"
        open={isOpen("resume")}
        onToggle={() => toggleSection("resume")}
        right={
          candidate.resume.fileUrl ? (
            <a
              href={candidate.resume.fileUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontFamily: F.mono, fontSize: 12.5, color: C.brick, textDecoration: "none" }}
            >
              Open résumé file ↗
            </a>
          ) : undefined
        }
      />
      {isOpen("resume") && (candidate.resume.hasResume ? (
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 18 }}>
          {candidate.resume.roles.map((r, i) => (
            <div key={i} style={{ background: "#fff", border: `1px solid ${ink(0.1)}`, borderLeft: `3px solid ${r.current ? C.orange : ink(0.18)}`, padding: "16px 20px" }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                <div style={{ minWidth: 0 }}>
                  <span style={{ fontSize: 16, fontWeight: 500, color: C.navy }}>{r.title}</span>
                  <span style={{ fontSize: 15, color: ink(0.6) }}> · {r.company}</span>
                </div>
                <span style={{ fontFamily: F.mono, fontSize: 12.5, color: r.current ? C.orange : ink(0.55), whiteSpace: "nowrap" }}>{r.period}</span>
              </div>
              {r.bullets.length > 0 && (
                <ul style={{ margin: "10px 0 0", padding: "0 0 0 18px", display: "flex", flexDirection: "column", gap: 4 }}>
                  {r.bullets.map((b, bi) => (
                    <li key={bi} style={{ fontSize: 14.5, lineHeight: 1.55, color: ink(0.82) }}>{b}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          {candidate.resume.roles.length === 0 && candidate.resume.fullText && (
            <div style={{ background: "#fff", border: `1px solid ${ink(0.1)}`, padding: "18px 22px", fontSize: 14.5, lineHeight: 1.6, color: ink(0.85), whiteSpace: "pre-wrap" }}>
              {candidate.resume.fullText}
            </div>
          )}
        </div>
      ) : (
        <div style={{ marginTop: 14, border: "1px dashed rgba(22,35,53,0.25)", background: ink(0.02), padding: "18px 22px", fontSize: 15, color: ink(0.6) }}>
          No résumé on file yet.{" "}
          <span style={{ color: ink(0.5) }}>Once a résumé syncs from Workable it appears here, role by role.</span>
        </div>
      ))}

      {/* COVER LETTER */}
      <SectionTitle title="Cover letter" open={isOpen("cover")} onToggle={() => toggleSection("cover")} />
      {isOpen("cover") && (candidate.cover.hasLetter ? (
        <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: narrow ? "1fr" : "1fr 300px", gap: narrow ? 16 : 36, alignItems: "start" }}>
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
      ))}

      {/* APPLICATION ANSWERS */}
      <SectionTitle title="Application answers" open={isOpen("answers")} onToggle={() => toggleSection("answers")} />
      {isOpen("answers") && (
      <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 16 }}>
        {candidate.answers.map((qa, i) => {
          const m = CM(qa.kind);
          const key = `ans-${i}`;
          return (
            <div key={key} style={{ display: "grid", gridTemplateColumns: narrow ? "1fr" : "1fr 300px", gap: narrow ? 16 : 36, alignItems: "start" }}>
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
      )}

      {/* LOGISTICS */}
      <SectionTitle title="Logistics check" open={isOpen("logistics")} onToggle={() => toggleSection("logistics")} right={<span style={{ fontFamily: F.mono, fontSize: 12, color: ink(0.5) }}>{candidate.logistics.mode}</span>} />
      {isOpen("logistics") && (
      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: narrow ? "1fr" : "280px 1fr", gap: narrow ? 16 : 36, alignItems: "start" }}>
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
      )}

      {/* INTERVIEW SUMMARY */}
      <SectionTitle title="Interview summary" open={isOpen("interview")} onToggle={() => toggleSection("interview")} />
      {isOpen("interview") && candidate.interview && (
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
        open={isOpen("workingFile")}
        onToggle={() => toggleSection("workingFile")}
        right={
          <button onClick={downloadMd} style={{ cursor: "pointer", border: `1px solid ${ink(0.22)}`, background: "transparent", color: C.navy, borderRadius: 9999, padding: "7px 14px", fontFamily: F.mono, fontSize: 12.5 }}>
            Download .md ↓
          </button>
        }
      />
      {isOpen("workingFile") && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontFamily: F.mono, fontSize: 11.5, textTransform: "uppercase", letterSpacing: "0.04em", color: ink(0.5), marginBottom: 8 }}>
            What Claude has on this candidate ({id}.md)
          </div>
          {wfContent === null ? (
            <div style={{ border: `1px solid ${ink(0.1)}`, background: "#fff", padding: "16px 18px", fontFamily: F.mono, fontSize: 12.5, color: ink(0.55) }}>
              Loading working file…
            </div>
          ) : (
            <pre style={{ maxHeight: 460, overflow: "auto", border: `1px solid ${ink(0.1)}`, background: "#fff", padding: "16px 18px", fontFamily: F.mono, fontSize: 12.5, lineHeight: 1.55, color: ink(0.85), whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{wfContent}</pre>
          )}
        </div>
      )}
      {isOpen("workingFile") && (
      <div style={{ marginTop: 22, display: "grid", gridTemplateColumns: narrow ? "1fr" : "1fr 1fr", gap: narrow ? "24px 0" : "0 40px", alignItems: "start" }}>
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
          <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <label style={{ fontFamily: F.mono, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", color: ink(0.5) }}>Reviewer</label>
            <select
              value={reviewerKind}
              onChange={(e) => setReviewerKind(e.target.value as ReviewerKind)}
              aria-label="Reviewer leaving this correction"
              style={{ fontFamily: F.sans, fontSize: 13, color: C.navy, background: "#fff", border: `1px solid ${ink(0.18)}`, borderRadius: 8, padding: "5px 9px", cursor: "pointer" }}
            >
              {REVIEWER_OPTIONS.map((o) => (
                <option key={o.kind} value={o.kind}>{o.label}</option>
              ))}
            </select>
            <button
              onClick={() => {
                wsApi.addCorrection(id, corrDraft, reviewerKind);
                setCorrDraft("");
              }}
              style={{ cursor: "pointer", border: "none", background: C.navy, color: C.cream, borderRadius: 9999, padding: "8px 16px", fontFamily: F.mono, fontSize: 12.5 }}
            >
              Save correction &amp; re-analyze
            </button>
          </div>
        </div>
        <div>
          <div style={{ fontFamily: F.mono, fontSize: 11.5, textTransform: "uppercase", letterSpacing: "0.04em", color: ink(0.5), marginBottom: 8 }}>Correction log</div>
          {corrLog.length > 0 ? (
            corrLog
              .slice()
              .reverse()
              .map((e, i) => (
                <div key={i} style={{ borderLeft: `2px solid ${C.orange}`, padding: "3px 0 3px 12px", marginBottom: 12 }}>
                  <div style={{ fontFamily: F.mono, fontSize: 11, color: ink(0.45) }}>
                    {e.ts}{e.reviewerLabel ? ` · ${e.reviewerLabel}` : ""} · applied
                  </div>
                  <div style={{ marginTop: 3, fontSize: 14.5, lineHeight: 1.5, color: C.navy }}>{e.text}</div>
                </div>
              ))
          ) : (
            <div style={{ fontSize: 14, color: ink(0.5) }}>No corrections yet. The record reflects Claude&apos;s parse of the submitted materials.</div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}

function SectionTitle({
  title,
  titleSuffix,
  right,
  open,
  onToggle,
}: {
  title: string;
  titleSuffix?: React.ReactNode;
  right?: React.ReactNode;
  // When provided, the header becomes a collapse toggle with a caret (#4).
  open?: boolean;
  onToggle?: () => void;
}) {
  const collapsible = typeof open === "boolean" && !!onToggle;
  const heading = (
    <h2 style={{ margin: 0, fontSize: 23, fontWeight: 500, letterSpacing: "-0.02em", display: "flex", alignItems: "baseline", gap: 10 }}>
      {collapsible && (
        <span aria-hidden style={{ fontFamily: F.mono, fontSize: 14, color: ink(0.45) }}>{open ? "▾" : "▸"}</span>
      )}
      <span>
        {title} {titleSuffix}
      </span>
    </h2>
  );
  return (
    <div style={{ marginTop: 42, display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, flexWrap: "wrap", borderBottom: `1px solid ${ink(0.15)}`, paddingBottom: 9 }}>
      {collapsible ? (
        <button
          onClick={onToggle}
          aria-expanded={open}
          style={{ cursor: "pointer", border: "none", background: "transparent", padding: 0, textAlign: "left", color: C.navy }}
        >
          {heading}
        </button>
      ) : (
        heading
      )}
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
