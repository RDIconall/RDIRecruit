"use client";

import { CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  APP,
  DECISION_LABEL,
  POOL_GROUPS,
  poolGroupOf,
  verdictDot,
  fitWeight,
  describeMissingInputs,
} from "@/lib/triage/app-theme";
import { standingLabel } from "@/lib/triage/ranking";
import type { Candidate, Decision, VerdictRead } from "@/lib/triage/types";

const DECISION_OPTIONS: Decision[] = ["interview", "short", "verify", "hold", "cut", "blocked"];
import type { WorkspaceApi } from "./use-workspace";
import { useTriageData } from "./context";
import { useIsNarrow } from "./use-media-query";
import { saveJobRubric } from "@/app/actions/triage";

const mono = (extra: CSSProperties = {}): CSSProperties => ({ fontFamily: APP.mono, ...extra });
const ellipsis: CSSProperties = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
// every grid cell needs min-width:0 so nowrap text truncates instead of
// overflowing into the next column (CSS grid items default to min-width:auto).
const cell: CSSProperties = { minWidth: 0, overflow: "hidden" };

const COLS =
  "26px 34px minmax(150px,1.6fr) minmax(110px,1.1fr) minmax(82px,0.9fr) 46px 92px minmax(98px,0.9fr) minmax(98px,0.9fr) 78px 240px";

/**
 * Compacts a raw salary ask into a tight column-friendly form:
 * "$145,000-$160,000" → "$145–160k", "$130K" → "$130k", "$70,000" → "$70k".
 * Falls back to the raw string (truncated by the cell) when it can't parse.
 */
function compactAsk(raw: string | null | undefined): string {
  if (!raw) return "—";
  if (/[mb]/i.test(raw)) return raw; // leave millions/billions untouched
  const nums = raw.match(/\d[\d,]*/g);
  if (!nums) return raw;
  const toK = (s: string): number | null => {
    const n = parseInt(s.replace(/,/g, ""), 10);
    if (!Number.isFinite(n)) return null;
    return n >= 1000 ? Math.round(n / 1000) : n;
  };
  const vals = nums.map(toK).filter((n): n is number => n != null);
  if (vals.length === 0) return raw;
  if (vals.length >= 2) return `$${vals[0]}–${vals[1]}k`;
  return `$${vals[0]}k`;
}

interface Props {
  wsApi: WorkspaceApi;
  openCandidate: (id: string) => void;
}

export function PoolBoard({ wsApi, openCandidate }: Props) {
  const { candidates, meta, rubricMd, specMd } = useTriageData();
  const narrow = useIsNarrow();
  const dq = wsApi.ws.dq;
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [showDisq, setShowDisq] = useState(false);

  const isDq = (c: Candidate) => !!dq[c.id];
  const active = useMemo(() => candidates.filter((c) => !isDq(c)), [candidates, dq]);
  const disqRows = useMemo(() => candidates.filter((c) => isDq(c)), [candidates, dq]);

  // Group by status (fixed order); within a group sort by fit = answers + spec.
  const groups = useMemo(() => {
    return POOL_GROUPS.map((g) => {
      const rows = active
        .filter((c) => poolGroupOf(c.decision) === g.key)
        .map((c, i) => ({ c, i }))
        .sort((a, b) => fit(b.c) - fit(a.c) || a.i - b.i)
        .map((x) => x.c);
      return { ...g, rows };
    }).filter((g) => g.rows.length > 0);
  }, [active]);

  const selIds = Object.keys(sel).filter((k) => sel[k] && active.some((c) => c.id === k));
  const selCount = selIds.length;
  const allSelected = active.length > 0 && active.every((c) => sel[c.id]);

  const toggleSel = (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setSel((s) => {
      const next = { ...s };
      if (next[id]) delete next[id];
      else next[id] = true;
      return next;
    });
  };
  const toggleAll = () => {
    if (allSelected) setSel({});
    else setSel(Object.fromEntries(active.map((c) => [c.id, true])));
  };
  const clearSel = () => setSel({});
  const bulkDisqualify = () => {
    wsApi.setDqMany(selIds, true);
    setSel({});
  };

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto", padding: narrow ? "18px 16px 80px" : "24px 28px 90px" }}>
      {/* job-level spec + rubric (scoped to the active job, not the candidate) */}
      <JobSpecPanel jobShortcode={meta.jobShortcode} jobTitle={meta.title} rubricMd={rubricMd} specMd={specMd} />

      {/* selection / count bar */}
      <div style={{ marginBottom: 6, minHeight: 34, display: "flex", alignItems: "center" }}>
        {selCount > 0 ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              width: "100%",
              background: APP.ink,
              color: "#fff",
              borderRadius: 6,
              padding: "7px 8px 7px 16px",
            }}
          >
            <span style={{ fontSize: 13.5, fontWeight: 600 }}>{selCount} selected</span>
            <span style={{ width: 1, height: 16, background: "rgba(255,255,255,0.2)" }} />
            <button
              onClick={bulkDisqualify}
              style={{ cursor: "pointer", background: APP.weak, color: "#fff", border: "none", borderRadius: 4, padding: "6px 14px", fontSize: 13, fontWeight: 500 }}
            >
              Disqualify {selCount}
            </button>
            <span style={{ flex: 1 }} />
            <button onClick={clearSel} style={{ cursor: "pointer", background: "transparent", color: "rgba(255,255,255,0.7)", border: "none", padding: "6px 12px", fontSize: 13 }}>
              Clear
            </button>
          </div>
        ) : (
          <div style={mono({ fontSize: 12, color: APP.muted })}>
            {active.length} candidates · {disqRows.length} disqualified · tick rows to disqualify in bulk
          </div>
        )}
      </div>

      {!narrow ? (
        <div style={{ marginTop: 14, overflowX: "auto" }}>
          <div style={{ minWidth: 1060 }}>
            {/* header */}
            <div
              style={mono({
                display: "grid",
                gridTemplateColumns: COLS,
                alignItems: "end",
                columnGap: 10,
                padding: "0 6px 7px",
                borderBottom: `1px solid ${APP.ink}`,
                fontSize: 10.5,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                color: APP.faint,
              })}
            >
              <div style={{ display: "flex", alignItems: "center" }}>
                <Check checked={allSelected} onClick={toggleAll} />
              </div>
              <div />
              <div style={ellipsis}>Candidate</div>
              <div style={ellipsis}>Company</div>
              <div style={ellipsis}>Location</div>
              <div style={{ textAlign: "right" }}>Exp.</div>
              <div style={{ textAlign: "right" }}>Ask</div>
              <div style={ellipsis}>Answers</div>
              <div style={ellipsis}>Vs. spec</div>
              <div style={{ textAlign: "right" }}>RO</div>
              <div style={{ textAlign: "right" }}>Actions</div>
            </div>

            {groups.map((g) => (
              <div key={g.key}>
                <div
                  style={mono({
                    padding: "15px 6px 6px",
                    fontSize: 10.5,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    color: APP.faint,
                    display: "flex",
                    gap: 8,
                    alignItems: "baseline",
                    borderBottom: `1px solid ${APP.hair2}`,
                  })}
                >
                  <span style={{ color: APP.ink, fontWeight: 600 }}>{g.label}</span>
                  <span>{g.rows.length}</span>
                </div>
                {g.rows.map((c) => (
                  <Row key={c.id} c={c} selected={!!sel[c.id]} onToggle={(e) => toggleSel(c.id, e)} onOpen={() => openCandidate(c.id)} onDisq={() => wsApi.toggleDq(c.id)} onSetDecision={(d) => wsApi.setDecision(c.id, d)} />
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column" }}>
          {groups.map((g) => (
            <div key={g.key}>
              <div
                style={mono({
                  padding: "16px 2px 6px",
                  fontSize: 10.5,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: APP.faint,
                  display: "flex",
                  gap: 8,
                  alignItems: "baseline",
                  borderBottom: `1px solid ${APP.hair2}`,
                })}
              >
                <span style={{ color: APP.ink, fontWeight: 600 }}>{g.label}</span>
                <span>{g.rows.length}</span>
              </div>
              {g.rows.map((c) => (
                <MobileRow key={c.id} c={c} selected={!!sel[c.id]} onToggle={(e) => toggleSel(c.id, e)} onOpen={() => openCandidate(c.id)} onDisq={() => wsApi.toggleDq(c.id)} onSetDecision={(d) => wsApi.setDecision(c.id, d)} />
              ))}
            </div>
          ))}
        </div>
      )}

      {!narrow && (
        <p style={{ margin: "22px 6px 0", fontSize: 14, lineHeight: 1.5, color: APP.faint, maxWidth: 780 }}>
          Verdict dots: filled reads strong, hollow reads mixed, red reads weak. Both AI reads are cached at ingest — opening a candidate never re-runs the model.
        </p>
      )}

      {disqRows.length > 0 && (
        <div style={{ marginTop: 18, borderTop: `1px solid ${APP.hair2}`, paddingTop: 12 }}>
          <button
            onClick={() => setShowDisq((v) => !v)}
            style={mono({ cursor: "pointer", background: "transparent", border: "none", padding: "4px 0", fontSize: 12, color: APP.muted })}
          >
            {showDisq ? "Hide disqualified ⌃" : `Show ${disqRows.length} disqualified ⌄`}
          </button>
          {showDisq && (
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column" }}>
              {disqRows.map((c) => (
                <div
                  key={c.id}
                  onClick={() => openCandidate(c.id)}
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 4px", borderBottom: `1px solid ${APP.line2}`, cursor: "pointer", opacity: 0.55 }}
                >
                  <Avatar c={c} size={22} />
                  <div style={{ minWidth: 0, flex: 1, ...ellipsis }}>
                    <span style={{ fontSize: 13.5, fontWeight: 600, textDecoration: "line-through" }}>{c.name}</span>{" "}
                    <span style={{ fontSize: 12.5, color: APP.muted }}>· {c.company}</span>
                  </div>
                  <span style={mono({ fontSize: 12, color: APP.faint, whiteSpace: "nowrap" })}>{c.roLevel}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); wsApi.toggleDq(c.id); }}
                    style={{ cursor: "pointer", background: "transparent", color: APP.secondary, border: `1px solid #CFCFCF`, borderRadius: 4, padding: "3px 10px", fontSize: 11.5, fontWeight: 500, whiteSpace: "nowrap" }}
                  >
                    Reinstate
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function fit(c: Candidate): number {
  return fitWeight(c.answersRead.level) + fitWeight(c.specRead.level);
}

/**
 * Sub-line under a candidate's name: when the read is blocked, says exactly what
 * grading is waiting on; otherwise shows the ordinal pool standing ("3rd of 12
 * interview-ready"). Ordinal only — never a numeric score.
 */
function StandingLine({ c }: { c: Candidate }) {
  if (c.decision === "blocked" && c.readiness && !c.readiness.ready) {
    if (c.readiness.resumeMissingFromSource) {
      return (
        <div
          style={mono({ fontSize: 11, color: APP.weak, lineHeight: 1.3, ...ellipsis })}
          title="Review blocked — no résumé on file in Workable, nothing to grade"
        >
          Blocked · no résumé on file
        </div>
      );
    }
    return (
      <div
        style={mono({ fontSize: 11, color: APP.weak, lineHeight: 1.3, ...ellipsis })}
        title={`Review blocked — waiting on ${describeMissingInputs(c.readiness.missing)}`}
      >
        Blocked · waiting on {describeMissingInputs(c.readiness.missing)}
      </div>
    );
  }
  const label = standingLabel(c.standing);
  if (!label) return null;
  return (
    <div style={mono({ fontSize: 11, color: APP.faint, lineHeight: 1.3, ...ellipsis })} title={`Pool standing: ${label}`}>
      {label}
    </div>
  );
}

/**
 * Job-level grading rubric + role spec (stored in job_rubrics, keyed by job
 * shortcode — one per job, NOT per candidate). Claude reads both to derive the
 * per-candidate "Vs. spec" read. Upload a .md/.txt file or paste/edit inline.
 */
function JobSpecPanel({
  jobShortcode,
  jobTitle,
  rubricMd,
  specMd,
}: {
  jobShortcode: string;
  jobTitle: string;
  rubricMd: string;
  specMd: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [specDraft, setSpecDraft] = useState(specMd);
  const [rubricDraft, setRubricDraft] = useState(rubricMd);
  const [saving, setSaving] = useState<"spec" | "rubric" | null>(null);
  const specFileRef = useRef<HTMLInputElement>(null);
  const rubricFileRef = useRef<HTMLInputElement>(null);

  // Keep drafts in sync with server-fed values (e.g. after a job switch / refresh).
  useEffect(() => {
    setSpecDraft(specMd);
    setRubricDraft(rubricMd);
  }, [specMd, rubricMd, jobShortcode]);

  const onUpload = async (file: File | undefined, set: (v: string) => void) => {
    if (!file) return;
    try {
      const text = await file.text();
      set(text);
    } catch {
      /* ignore unreadable file */
    }
  };

  const save = async (which: "spec" | "rubric") => {
    setSaving(which);
    try {
      await saveJobRubric({
        jobShortcode,
        ...(which === "spec" ? { specMd: specDraft } : { rubricMd: rubricDraft }),
      });
      router.refresh();
    } finally {
      setSaving(null);
    }
  };

  const hasSpec = !!specMd.trim();
  const hasRubric = !!rubricMd.trim();

  return (
    <div style={{ marginBottom: 16, border: `1px solid ${APP.hair}`, borderRadius: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px" }}>
        <span style={mono({ fontSize: 11, letterSpacing: "0.05em", textTransform: "uppercase", color: APP.faint })}>Job spec</span>
        <span style={{ fontSize: 13, color: APP.ink, fontWeight: 600, ...ellipsis, minWidth: 0 }}>{jobTitle}</span>
        <span style={mono({ fontSize: 11.5, color: hasSpec ? APP.secondary : APP.weak })}>
          role spec {hasSpec ? "on file" : "needed"} · grading rubric {hasRubric ? "on file" : "optional"}
        </span>
        <span style={{ flex: 1 }} />
        <button
          onClick={() => setOpen((v) => !v)}
          style={mono({ cursor: "pointer", background: open ? APP.ink : "transparent", color: open ? "#fff" : APP.accent, border: `1px solid ${open ? APP.ink : APP.accentBorder}`, borderRadius: 5, padding: "4px 12px", fontSize: 12 })}
        >
          {open ? "Done" : hasSpec ? "Edit" : "Add role spec"}
        </button>
      </div>

      {open && (
        <div style={{ borderTop: `1px solid ${APP.hair2}`, padding: "14px", display: "flex", flexDirection: "column", gap: 18 }}>
          <SpecField
            label="Role spec (.md) — what this job actually is"
            value={specDraft}
            onChange={setSpecDraft}
            onPick={() => specFileRef.current?.click()}
            fileRef={specFileRef}
            onFile={(f) => onUpload(f, setSpecDraft)}
            onSave={() => save("spec")}
            saving={saving === "spec"}
          />
          <SpecField
            label="Grading rubric (.md) — optional · the role spec is the grading basis when this is empty"
            value={rubricDraft}
            onChange={setRubricDraft}
            onPick={() => rubricFileRef.current?.click()}
            fileRef={rubricFileRef}
            onFile={(f) => onUpload(f, setRubricDraft)}
            onSave={() => save("rubric")}
            saving={saving === "rubric"}
          />
          <p style={mono({ margin: 0, fontSize: 11, color: APP.faint })}>
            Only the role spec is required — Claude grades against it directly. The grading rubric is optional and only sharpens the fit read when present. Saved once per job; re-run a candidate&apos;s assessment (war room → Update assessment) to grade against the new spec.
          </p>
        </div>
      )}
    </div>
  );
}

function SpecField({
  label,
  value,
  onChange,
  onPick,
  fileRef,
  onFile,
  onSave,
  saving,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onPick: () => void;
  fileRef: React.RefObject<HTMLInputElement | null>;
  onFile: (f: File | undefined) => void;
  onSave: () => void;
  saving: boolean;
}) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <span style={mono({ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", color: APP.faint })}>{label}</span>
        <span style={{ flex: 1 }} />
        <input
          ref={fileRef}
          type="file"
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          style={{ display: "none" }}
          onChange={(e) => {
            onFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <button onClick={onPick} style={mono({ cursor: "pointer", background: "transparent", color: APP.secondary, border: `1px solid ${APP.hair}`, borderRadius: 5, padding: "4px 11px", fontSize: 12 })}>
          Upload .md
        </button>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={7}
        placeholder="Paste markdown here, or upload a .md file…"
        style={{
          width: "100%",
          boxSizing: "border-box",
          border: `1px solid ${APP.hair}`,
          borderRadius: 7,
          padding: "10px 12px",
          fontFamily: APP.mono,
          fontSize: 12.5,
          lineHeight: 1.5,
          color: APP.ink,
          resize: "vertical",
          outline: "none",
        }}
      />
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
        <button
          onClick={onSave}
          disabled={saving}
          style={{ cursor: saving ? "default" : "pointer", background: saving ? APP.hair : APP.accent, color: saving ? APP.muted : "#fff", border: "none", borderRadius: 6, padding: "7px 16px", fontSize: 13, fontWeight: 500 }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

function Check({ checked, onClick }: { checked: boolean; onClick: (e: React.MouseEvent) => void }) {
  return (
    <span
      onClick={onClick}
      style={{
        cursor: "pointer",
        width: 15,
        height: 15,
        borderRadius: 3,
        border: `1.5px solid ${checked ? APP.accent : "#CFCFCF"}`,
        background: checked ? APP.accent : "transparent",
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 10,
        lineHeight: 1,
        flexShrink: 0,
      }}
    >
      {checked ? "✓" : ""}
    </span>
  );
}

function Avatar({ c, size = 24 }: { c: Candidate; size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 9999,
        background: c.avatarColor,
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size <= 22 ? 9 : 9.5,
        fontWeight: 600,
        fontFamily: APP.mono,
        flexShrink: 0,
      }}
    >
      {c.initials}
    </div>
  );
}

function Dot({ read }: { read: VerdictRead }) {
  const d = verdictDot(read.level);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
      <span style={{ width: 8, height: 8, borderRadius: 9999, flexShrink: 0, background: d.fill, border: `1.5px solid ${d.color}` }} />
      <span style={{ fontSize: 13, color: d.color, ...ellipsis }}>{read.label}</span>
    </div>
  );
}

function StatusSelect({ value, onChange }: { value: Decision; onChange: (d: Decision) => void }) {
  return (
    <select
      value={value}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => { e.stopPropagation(); onChange(e.target.value as Decision); }}
      aria-label="Set status manually"
      title="Set status manually"
      style={mono({ fontSize: 11.5, color: APP.ink, background: APP.surface, border: `1px solid ${APP.hair}`, borderRadius: 4, padding: "3px 6px", cursor: "pointer", maxWidth: 120 })}
    >
      {DECISION_OPTIONS.map((d) => (
        <option key={d} value={d}>{DECISION_LABEL[d]}</option>
      ))}
    </select>
  );
}

function DisqButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{ cursor: "pointer", background: "transparent", color: APP.weak, border: `1px solid ${APP.weakBorder}`, borderRadius: 4, padding: "4px 9px", fontSize: 11.5, fontWeight: 500, whiteSpace: "nowrap" }}
    >
      Disqualify
    </button>
  );
}

function Row({ c, selected, onToggle, onOpen, onDisq, onSetDecision }: { c: Candidate; selected: boolean; onToggle: (e: React.MouseEvent) => void; onOpen: () => void; onDisq: () => void; onSetDecision: (d: Decision) => void }) {
  return (
    <div
      onClick={onOpen}
      style={{
        display: "grid",
        gridTemplateColumns: COLS,
        alignItems: "center",
        columnGap: 10,
        padding: "6px 6px",
        borderBottom: `1px solid ${APP.line}`,
        cursor: "pointer",
        background: selected ? APP.accentSoft : "transparent",
      }}
    >
      <div style={{ display: "flex", alignItems: "center" }}>
        <Check checked={selected} onClick={onToggle} />
      </div>
      <Avatar c={c} />
      <div style={cell}>
        <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.2, ...ellipsis }} title={c.name}>{c.name}</div>
        <div style={{ fontSize: 11.5, color: APP.muted, lineHeight: 1.2, ...ellipsis }} title={c.role}>{c.role}</div>
        <StandingLine c={c} />
      </div>
      <div style={{ ...cell, fontSize: 13.5, color: APP.ink2, ...ellipsis }} title={c.company}>{c.company}</div>
      <div style={{ ...cell, fontSize: 13, color: APP.secondary, ...ellipsis }} title={c.locationShort}>{c.locationShort}</div>
      <div style={mono({ ...cell, textAlign: "right", fontSize: 13, color: APP.ink2, fontVariantNumeric: "tabular-nums", ...ellipsis })}>{c.experience}</div>
      <div style={mono({ ...cell, textAlign: "right", fontSize: 13, color: APP.ink, fontVariantNumeric: "tabular-nums", ...ellipsis })} title={c.salary}>{compactAsk(c.salary)}</div>
      <div style={cell}>
        <Dot read={c.answersRead} />
      </div>
      <div style={cell}>
        <Dot read={c.specRead} />
      </div>
      <div style={mono({ ...cell, textAlign: "right", fontSize: 13, color: APP.ink, ...ellipsis })} title={c.roLevel}>{c.roLevel}</div>
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 9 }}>
        <StatusSelect value={c.decision} onChange={onSetDecision} />
        <a
          href={c.workableUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={mono({ fontSize: 11.5, color: APP.muted, textDecoration: "none", whiteSpace: "nowrap" })}
        >
          Workable ↗
        </a>
        <DisqButton onClick={onDisq} />
      </div>
    </div>
  );
}

function MobileRow({ c, selected, onToggle, onOpen, onDisq, onSetDecision }: { c: Candidate; selected: boolean; onToggle: (e: React.MouseEvent) => void; onOpen: () => void; onDisq: () => void; onSetDecision: (d: Decision) => void }) {
  return (
    <div
      onClick={onOpen}
      style={{ display: "flex", flexDirection: "column", gap: 8, padding: "13px 2px", borderBottom: `1px solid ${APP.hair2}`, cursor: "pointer", background: selected ? APP.accentSoft : "transparent" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Check checked={selected} onClick={onToggle} />
        <Avatar c={c} size={30} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.2, ...ellipsis }}>{c.name}</div>
          <div style={{ fontSize: 12, color: APP.muted, lineHeight: 1.25, ...ellipsis }}>{c.role} · {c.company}</div>
          <StandingLine c={c} />
        </div>
        <div style={mono({ fontSize: 13, color: APP.ink, flexShrink: 0 })}>{c.roLevel}</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", paddingLeft: 42, fontSize: 12.5, color: APP.secondary }}>
        <span style={mono({ color: APP.ink })} title={c.salary}>{compactAsk(c.salary)}</span>
        <span>{c.locationShort}</span>
        <Dot read={c.answersRead} />
        <Dot read={c.specRead} />
        <span style={{ flex: 1 }} />
        <StatusSelect value={c.decision} onChange={onSetDecision} />
        <DisqButton onClick={onDisq} />
      </div>
    </div>
  );
}
