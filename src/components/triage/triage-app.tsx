"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { FONTS } from "@/lib/triage/theme";
import type { Candidate, DecisionRead } from "@/lib/triage/types";
import type { Viewer } from "@/lib/triage/reviewer";
import type { TriagePool } from "@/lib/triage/load";
import { TriageDataProvider } from "./context";
import { useWorkspace } from "./use-workspace";
import { useIsNarrow } from "./use-media-query";
import { PoolScreen } from "./pool-screen";
import { CandidateScreen } from "./candidate-screen";

type View = "pool" | "candidate";

export function TriageApp({ pool, viewer }: { pool: TriagePool; viewer: Viewer }) {
  const router = useRouter();
  const narrow = useIsNarrow();
  const [isPending, startTransition] = useTransition();
  const [candidates, setCandidates] = useState<Candidate[]>(pool.candidates);
  const [view, setView] = useState<View>("pool");
  const [activeId, setActiveId] = useState<string>(pool.candidates[0]?.id ?? "");
  const [filter, setFilter] = useState<string>("all");

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
              survivor: read.decision === "interview" || read.decision === "short",
            }
          : c,
      ),
    );
  }, []);

  const wsApi = useWorkspace(pool.workspace, candidates, applyRead);

  const contextValue = useMemo(
    () => ({ candidates, meta: pool.meta, jobs: pool.jobs, viewer, findCandidate }),
    [candidates, pool.meta, pool.jobs, viewer, findCandidate],
  );

  const openPool = () => setView("pool");
  const openCandidate = (id: string) => {
    setActiveId(id);
    setView("candidate");
  };
  const openDeep = (id: string) => {
    wsApi.runDeep(id);
    openCandidate(id);
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
          background: "#FAFAF7",
          fontFamily: FONTS.sans,
          color: "#162335",
          fontSize: 17,
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
            background: "#FFFFFF",
            borderBottom: "1px solid rgba(22,35,53,0.15)",
            display: "flex",
            alignItems: "center",
            gap: narrow ? 10 : 18,
            padding: narrow ? "0 14px" : "0 28px",
          }}
        >
          <div
            style={{ display: "flex", alignItems: "center", gap: 11, cursor: "pointer", flexShrink: 0 }}
            onClick={openPool}
          >
            <Image src="/logo-mark.svg" alt="RDI" width={42} height={22} style={{ height: 22, width: "auto", display: "block" }} priority />
            <span
              style={{
                fontFamily: FONTS.mono,
                fontSize: 12,
                letterSpacing: "0.05em",
                color: "rgba(22,35,53,0.55)",
                whiteSpace: "nowrap",
                textTransform: "uppercase",
              }}
            >
              Candidate triage
            </span>
          </div>
          <div style={{ width: 1, height: 22, background: "rgba(22,35,53,0.15)" }} />

          {/* Job switcher */}
          <select
            value={pool.meta.jobShortcode}
            onChange={(e) => switchJob(e.target.value)}
            style={{
              fontFamily: FONTS.sans,
              fontSize: 15,
              color: "#162335",
              background: "transparent",
              border: "1px solid rgba(22,35,53,0.18)",
              borderRadius: 8,
              padding: "5px 10px",
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
            <div style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 16, flexShrink: 0, whiteSpace: "nowrap" }}>
              <span style={{ color: "rgba(22,35,53,0.30)" }}>›</span>
              <span style={{ color: "#162335" }}>{active.name}</span>
            </div>
          )}
          <div style={{ flex: 1 }} />
          {!narrow && (
            <span
              style={{
                fontFamily: FONTS.mono,
                fontSize: 12,
                color: "rgba(22,35,53,0.45)",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              Submitted materials only · synced from Workable
            </span>
          )}
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 9999,
              background: "#162335",
              color: "#FAFAF7",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 14,
              fontWeight: 500,
              flexShrink: 0,
            }}
          >
            C
          </div>
        </div>

        {wsApi.notice && (
          <div
            onClick={wsApi.clearNotice}
            style={{
              background: "rgba(231,68,36,0.08)",
              borderBottom: "1px solid rgba(231,68,36,0.25)",
              color: "#162335",
              fontFamily: FONTS.mono,
              fontSize: 12.5,
              padding: "8px 28px",
              cursor: "pointer",
            }}
          >
            {wsApi.notice} <span style={{ color: "rgba(22,35,53,0.45)" }}>· dismiss</span>
          </div>
        )}

        {!pool.configured && (
          <div style={{ padding: "12px 28px", background: "rgba(158,59,40,0.06)", borderBottom: "1px solid rgba(158,59,40,0.2)", fontFamily: FONTS.mono, fontSize: 12.5, color: "#9E3B28" }}>
            Live data source not configured in this environment — showing an empty pool.
          </div>
        )}

        {view === "pool" || !active ? (
          <PoolScreen wsApi={wsApi} filter={filter} setFilter={setFilter} openCandidate={openCandidate} openDeep={openDeep} />
        ) : (
          <CandidateScreen wsApi={wsApi} activeId={activeId} openPool={openPool} />
        )}
      </div>
    </TriageDataProvider>
  );
}
