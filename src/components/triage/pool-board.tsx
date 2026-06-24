"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { RowSelectionState } from "@tanstack/react-table";
import { useRouter } from "next/navigation";
import { APP, POOL_GROUPS, poolGroupOf, fitWeight } from "@/lib/triage/app-theme";
import type { Candidate, Decision } from "@/lib/triage/types";
import type { WorkspaceApi } from "./use-workspace";
import { useTriageData } from "./context";
import { useIsNarrow } from "./use-media-query";
import { saveJobRubric } from "@/app/actions/triage";
import { PoolTable } from "./pool-table";
import {
  Avatar,
  Checkbox,
  Dot,
  DisqButton,
  StandingLine,
  StatusSelect,
  ValueCell,
  compactAsk,
  ellipsis,
  mono,
} from "./pool-shared";

interface Props {
  wsApi: WorkspaceApi;
  openCandidate: (id: string) => void;
}

export function PoolBoard({ wsApi, openCandidate }: Props) {
  const { candidates, meta, rubricMd, specMd } = useTriageData();
  const narrow = useIsNarrow();
  const dq = wsApi.ws.dq;
  const [sel, setSel] = useState<RowSelectionState>({});
  const [showDisq, setShowDisq] = useState(false);

  const isDq = (c: Candidate) => !!dq[c.id];
  // Active candidates, ordered the way the pool reads top-down (decision-group
  // priority, then pool standing within the group). The table keeps this as its
  // default order; sorting a column overrides it per group.
  const active = useMemo(
    () =>
      candidates
        .filter((c) => !isDq(c))
        .slice()
        .sort((a, b) => (a.standing?.overallRank ?? 1e9) - (b.standing?.overallRank ?? 1e9)),
    [candidates, dq],
  );
  const disqRows = useMemo(() => candidates.filter((c) => isDq(c)), [candidates, dq]);

  // Mobile-only grouping (desktop grouping lives inside PoolTable).
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

  const toggleSel = (id: string) =>
    setSel((s) => {
      const next = { ...s };
      if (next[id]) delete next[id];
      else next[id] = true;
      return next;
    });
  const clearSel = () => setSel({});
  const bulkDisqualify = () => {
    wsApi.setDqMany(selIds, true);
    setSel({});
  };

  return (
    <div style={{ margin: "0 auto", padding: narrow ? "18px 16px 80px" : "24px 28px 90px" }}>
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
        <PoolTable
          active={active}
          rowSelection={sel}
          onRowSelectionChange={setSel}
          openCandidate={openCandidate}
          onDisqualify={(id) => wsApi.toggleDq(id)}
          onSetDecision={(id, d) => wsApi.setDecision(id, d)}
        />
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
                <MobileRow key={c.id} c={c} selected={!!sel[c.id]} onToggle={() => toggleSel(c.id)} onOpen={() => openCandidate(c.id)} onDisq={() => wsApi.toggleDq(c.id)} onSetDecision={(d) => wsApi.setDecision(c.id, d)} />
              ))}
            </div>
          ))}
        </div>
      )}

      {!narrow && (
        <p style={{ margin: "22px 6px 0", fontSize: 14, lineHeight: 1.5, color: APP.faint, maxWidth: 820 }}>
          The interview list is ranked — work it top-down (#1 first). &quot;Strength vs ask&quot; weighs the candidate against their salary target: filled accent reads strong value, hollow reads fair, red reads weak. The do-not-interview list shows the reason for each cut — tick rows to disqualify in bulk. Sort any column, search, or hide columns; the view is remembered in the URL. All reads are cached; opening a candidate never re-runs the model.
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
                    onClick={(e) => {
                      e.stopPropagation();
                      wsApi.toggleDq(c.id);
                    }}
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

function MobileRow({ c, selected, onToggle, onOpen, onDisq, onSetDecision }: { c: Candidate; selected: boolean; onToggle: () => void; onOpen: () => void; onDisq: () => void; onSetDecision: (d: Decision) => void }) {
  return (
    <div
      onClick={onOpen}
      style={{ display: "flex", flexDirection: "column", gap: 8, padding: "13px 2px", borderBottom: `1px solid ${APP.hair2}`, cursor: "pointer", background: selected ? APP.accentSoft : "transparent" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Checkbox checked={selected} onChange={onToggle} label={`Select ${c.name}`} />
        <Avatar c={c} size={30} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.2, ...ellipsis }}>
            {c.decision === "interview" && c.standing?.groupRank ? (
              <span style={mono({ color: APP.accent, marginRight: 6, fontSize: 13 })}>#{c.standing.groupRank}</span>
            ) : null}
            {c.name}
          </div>
          <div style={{ fontSize: 12, color: APP.muted, lineHeight: 1.25, ...ellipsis }}>{c.role} · {c.company}</div>
          <StandingLine c={c} />
        </div>
        <div style={mono({ fontSize: 13, color: APP.ink, flexShrink: 0 })}>{c.roLevel}</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", paddingLeft: 42, fontSize: 12.5, color: APP.secondary }}>
        <span style={mono({ color: APP.ink })} title={c.salary}>{compactAsk(c.salary)}</span>
        <span>{c.locationShort}</span>
        <ValueCell value={c.value} />
        <Dot read={c.answersRead} />
        <Dot read={c.specRead} />
        <span style={{ flex: 1 }} />
        <StatusSelect value={c.decision} onChange={onSetDecision} />
        <DisqButton onClick={onDisq} />
      </div>
    </div>
  );
}
