"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { APP } from "@/lib/triage/app-theme";
import type { Candidate, DecisionRead } from "@/lib/triage/types";
import type { Viewer } from "@/lib/triage/reviewer";
import type { TriagePool } from "@/lib/triage/load";
import { TriageDataProvider } from "./context";
import { useWorkspace } from "./use-workspace";
import { useIsNarrow } from "./use-media-query";
import { PoolBoard } from "./pool-board";
import { CandidateDossier } from "./candidate-dossier";

type View = "pool" | "candidate";

export function TriageApp({ pool, viewer }: { pool: TriagePool; viewer: Viewer }) {
  const router = useRouter();
  const narrow = useIsNarrow();
  const [isPending, startTransition] = useTransition();
  const [candidates, setCandidates] = useState<Candidate[]>(pool.candidates);
  const [view, setView] = useState<View>("pool");
  const [activeId, setActiveId] = useState<string>(pool.candidates[0]?.id ?? "");

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

  const wsApi = useWorkspace(pool.workspace, candidates, applyRead);

  const contextValue = useMemo(
    () => ({
      candidates,
      meta: pool.meta,
      jobs: pool.jobs,
      viewer,
      rubricMd: pool.rubricMd,
      specMd: pool.specMd,
      findCandidate,
    }),
    [candidates, pool.meta, pool.jobs, viewer, pool.rubricMd, pool.specMd, findCandidate],
  );

  const openPool = () => setView("pool");
  const openCandidate = (id: string) => {
    setActiveId(id);
    setView("candidate");
  };

  const switchJob = (shortcode: string) => {
    startTransition(() => {
      router.push(`/?job=${encodeURIComponent(shortcode)}`);
    });
  };

  const isCandidate = view === "candidate";
  const active = findCandidate(activeId);

  return (
    <TriageDataProvider value={contextValue}>
      <div
        style={{
          minHeight: "100vh",
          background: APP.surface,
          fontFamily: APP.sans,
          color: APP.ink,
          fontSize: 18,
          lineHeight: 1.5,
          opacity: isPending ? 0.6 : 1,
          transition: "opacity 120ms",
        }}
      >
        {/* ============ TOP BAR ============ */}
        <div
          style={{
            position: "sticky",
            top: 0,
            zIndex: 40,
            height: 54,
            background: "rgba(255,255,255,0.92)",
            backdropFilter: "saturate(1.1) blur(6px)",
            borderBottom: `1px solid ${APP.hair}`,
            display: "flex",
            alignItems: "center",
            gap: 14,
            padding: narrow ? "0 14px" : "0 28px",
          }}
        >
          <div
            style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer", flexShrink: 0, fontWeight: 700, fontSize: 17, letterSpacing: "-0.02em" }}
            onClick={openPool}
          >
            RDIRecruit
          </div>
          <div style={{ width: 1, height: 18, background: APP.hair }} />
          <a
            href="/radar"
            style={{ fontSize: 13, color: APP.secondary, textDecoration: "none", flexShrink: 0 }}
            title="Talent Radar — sourcing, enrichment, scoring & outreach"
          >
            Talent Radar
          </a>
          <div style={{ width: 1, height: 18, background: APP.hair }} />

          {/* Job switcher (the job context / breadcrumb) */}
          <select
            value={pool.meta.jobShortcode}
            onChange={(e) => switchJob(e.target.value)}
            style={{
              fontFamily: APP.sans,
              fontSize: 15,
              color: isCandidate ? APP.secondary : APP.ink,
              background: "transparent",
              border: "1px solid transparent",
              borderRadius: 6,
              padding: "4px 6px",
              maxWidth: narrow ? 150 : 360,
              cursor: "pointer",
            }}
          >
            {pool.jobs.map((j) => (
              <option key={j.shortcode} value={j.shortcode}>
                {j.title}
              </option>
            ))}
          </select>

          {isCandidate && active && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 15, flexShrink: 0, whiteSpace: "nowrap" }}>
              <span style={{ color: "#C9C9C9" }}>/</span>
              <span style={{ color: APP.ink }}>{active.name}</span>
            </div>
          )}
          <div style={{ flex: 1 }} />
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
              padding: "8px 28px",
              cursor: "pointer",
            }}
          >
            {wsApi.notice} <span style={{ color: APP.muted }}>· dismiss</span>
          </div>
        )}

        {!pool.configured && (
          <div style={{ padding: "12px 28px", background: APP.weakSoft, borderBottom: `1px solid ${APP.weakBorder}`, fontFamily: APP.mono, fontSize: 12.5, color: APP.weak }}>
            Live data source not configured in this environment — showing an empty pool.
          </div>
        )}

        {view === "pool" || !active ? (
          <PoolBoard wsApi={wsApi} openCandidate={openCandidate} />
        ) : (
          <CandidateDossier wsApi={wsApi} activeId={activeId} openPool={openPool} />
        )}
      </div>
    </TriageDataProvider>
  );
}
