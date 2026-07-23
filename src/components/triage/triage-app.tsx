"use client";

import { useCallback, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { APP } from "@/lib/triage/app-theme";
import type { Candidate, DecisionRead } from "@/lib/triage/types";
import type { Viewer } from "@/lib/triage/reviewer";
import type { TriagePool } from "@/lib/triage/load";
import { TriageDataProvider } from "./context";
import { useWorkspace } from "./use-workspace";
import { useIsNarrow } from "./use-media-query";
import { TriageInbox } from "./triage-inbox";
import { PipelineBoard } from "./pipeline-board";
import { CandidateDossier } from "./candidate-dossier";

type Mode = "triage" | "pipeline" | "deep";

export function TriageApp({ pool, viewer }: { pool: TriagePool; viewer: Viewer }) {
  const router = useRouter();
  const narrow = useIsNarrow();
  const [isPending, startTransition] = useTransition();
  const [candidates, setCandidates] = useState<Candidate[]>(pool.candidates);
  const [mode, setMode] = useState<Mode>("triage");
  const [activeId, setActiveId] = useState<string>(pool.candidates[0]?.id ?? "");
  const lastListMode = useRef<"triage" | "pipeline">("triage");

  const findCandidate = useCallback(
    (id: string) => candidates.find((c) => c.id === id),
    [candidates],
  );

  const applyRead = useCallback((id: string, read: DecisionRead) => {
    setCandidates((prev) =>
      prev.map((c) =>
        c.id === id
          ? {
              ...c,
              decision: read.decision,
              why: read.why || c.why,
              flag: read.risk || c.flag,
              next: read.next || c.next,
              redFlags: read.flags ?? c.redFlags,
              reanalysis: read.reanalysis ?? c.reanalysis,
              rev: read.rev ?? c.rev,
              revNote: read.revNote ?? c.revNote,
              careerRead: read.careerRead ?? c.careerRead,
              value: read.value ?? c.value,
              caveat: read.caveat ?? c.caveat,
              assessment: read.assessment ?? c.assessment,
              assessedAt: read.assessment ? read.recalculatedAt ?? c.assessedAt : c.assessedAt,
              rubricFit: read.rubricFit ?? c.rubricFit,
              survivor: read.decision === "interview",
            }
          : c,
      ),
    );
  }, []);

  const applyStage = useCallback((id: string, stage: string) => {
    setCandidates((prev) =>
      prev.map((c) => (c.id === id ? { ...c, workableStage: stage } : c)),
    );
  }, []);

  const wsApi = useWorkspace(pool.workspace, candidates, applyRead, {
    jobShortcode: pool.meta.jobShortcode,
    onStageChange: applyStage,
  });

  const contextValue = useMemo(
    () => ({
      candidates,
      meta: pool.meta,
      jobs: pool.jobs,
      viewer,
      rubricMd: pool.rubricMd,
      specMd: pool.specMd,
      stages: pool.stages,
      findCandidate,
    }),
    [candidates, pool.meta, pool.jobs, viewer, pool.rubricMd, pool.specMd, pool.stages, findCandidate],
  );

  const openList = (m: "triage" | "pipeline" = lastListMode.current) => {
    lastListMode.current = m;
    setMode(m);
  };
  const openCandidate = (id: string) => {
    setActiveId(id);
    if (mode === "triage" || mode === "pipeline") lastListMode.current = mode;
    setMode("deep");
  };

  const switchJob = (shortcode: string) => {
    startTransition(() => {
      router.push(`/?job=${encodeURIComponent(shortcode)}`);
    });
  };

  const active = findCandidate(activeId);
  const isDeep = mode === "deep" && !!active;

  const crossRole = !!pool.crossRole;
  const modes: { id: Mode; label: string; disabled?: boolean }[] = [
    { id: "triage", label: crossRole ? "Across roles" : "Triage" },
    { id: "pipeline", label: "Pipeline", disabled: crossRole },
    { id: "deep", label: "Deep dive", disabled: !activeId },
  ];

  return (
    <TriageDataProvider value={contextValue}>
      <div
        style={{
          minHeight: "100vh",
          background: APP.line2,
          fontFamily: APP.sans,
          color: APP.ink,
          fontSize: 18,
          lineHeight: 1.5,
          opacity: isPending ? 0.6 : 1,
          transition: "opacity 120ms",
        }}
      >
        <div
          style={{
            position: "sticky",
            top: 0,
            zIndex: 40,
            height: 54,
            background: "rgba(255,255,255,0.96)",
            backdropFilter: "saturate(1.1) blur(6px)",
            borderBottom: `1px solid ${APP.hair}`,
            display: "flex",
            alignItems: "center",
            gap: 14,
            padding: narrow ? "0 14px" : "0 20px",
          }}
        >
          <div
            style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer", flexShrink: 0, fontWeight: 700, fontSize: 17, letterSpacing: "-0.02em" }}
            onClick={() => openList("triage")}
          >
            RDIRecruit
          </div>
          <div style={{ width: 1, height: 18, background: APP.hair }} />

          <select
            value={pool.meta.jobShortcode}
            onChange={(e) => switchJob(e.target.value)}
            style={{
              fontFamily: APP.sans,
              fontSize: 14,
              color: APP.ink,
              background: "transparent",
              border: `1px solid ${APP.hair}`,
              borderRadius: 6,
              padding: "4px 8px",
              maxWidth: narrow ? 140 : 320,
              cursor: "pointer",
            }}
          >
            {pool.jobs.map((j) => (
              <option key={j.shortcode} value={j.shortcode}>
                {j.title}
              </option>
            ))}
          </select>

          <div
            style={{
              display: "flex",
              gap: 4,
              marginLeft: 4,
              background: APP.line2,
              padding: 3,
              borderRadius: 8,
              border: `1px solid ${APP.hair}`,
            }}
          >
            {modes.map((m) => (
              <button
                key={m.id}
                type="button"
                disabled={m.disabled}
                onClick={() => {
                  if (m.id === "deep") {
                    if (activeId) setMode("deep");
                    return;
                  }
                  openList(m.id);
                }}
                style={{
                  border: 0,
                  background: mode === m.id || (m.id === "deep" && isDeep) ? APP.surface : "transparent",
                  color: m.disabled ? APP.faint : APP.ink2,
                  padding: "6px 12px",
                  borderRadius: 6,
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: m.disabled ? "not-allowed" : "pointer",
                  boxShadow: mode === m.id || (m.id === "deep" && isDeep) ? "0 1px 2px rgba(16,24,40,.08)" : undefined,
                }}
              >
                {m.label}
              </button>
            ))}
          </div>

          {isDeep && active && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, flexShrink: 0, whiteSpace: "nowrap" }}>
              <span style={{ color: "#C9C9C9" }}>/</span>
              <span style={{ color: APP.ink }}>{active.name}</span>
            </div>
          )}
          <div style={{ flex: 1 }} />
          {pool.meta.jobUrl ? (
            <a
              href={pool.meta.jobUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 13, color: APP.accent, textDecoration: "none", fontWeight: 600, flexShrink: 0 }}
            >
              Open in Workable ↗
            </a>
          ) : (
            <span style={{ fontSize: 12, color: APP.muted, flexShrink: 0 }}>Cross-role inbox</span>
          )}
        </div>

        {wsApi.notice && (
          <div
            onClick={wsApi.clearNotice}
            style={{
              background: APP.accentSoft,
              borderBottom: `1px solid ${APP.accentBorder}`,
              color: APP.ink,
              fontFamily: APP.mono,
              fontSize: 12.5,
              padding: "8px 20px",
              cursor: "pointer",
            }}
          >
            {wsApi.notice} <span style={{ color: APP.muted }}>· dismiss</span>
          </div>
        )}

        {!pool.configured && (
          <div style={{ padding: "12px 20px", background: APP.weakSoft, borderBottom: `1px solid ${APP.weakBorder}`, fontFamily: APP.mono, fontSize: 12.5, color: APP.weak }}>
            Live data source not configured in this environment — showing an empty pool.
          </div>
        )}

        {!isDeep && mode === "triage" && (
          <TriageInbox
            wsApi={wsApi}
            openCandidate={openCandidate}
            stages={pool.stages}
            onStageChange={(id, stage) => wsApi.moveStage(id, stage)}
            crossRole={crossRole}
          />
        )}
        {!isDeep && mode === "pipeline" && !crossRole && (
          <PipelineBoard
            wsApi={wsApi}
            openCandidate={openCandidate}
            stages={pool.stages}
            onStageChange={(id, stage) => wsApi.moveStage(id, stage)}
          />
        )}
        {!isDeep && mode === "pipeline" && crossRole && (
          <div style={{ padding: 28, color: APP.muted, fontSize: 14 }}>
            Pipeline kanban is per-job. Pick a specific role in the job switcher to advance stages.
          </div>
        )}
        {isDeep && active && (
          <CandidateDossier
            wsApi={wsApi}
            activeId={activeId}
            openPool={() => openList()}
            stages={pool.stages}
          />
        )}
      </div>
    </TriageDataProvider>
  );
}
