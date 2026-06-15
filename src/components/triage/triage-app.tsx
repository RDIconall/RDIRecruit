"use client";

import { useState } from "react";
import Image from "next/image";
import { FONTS } from "@/lib/triage/theme";
import { POOL_TITLE, findCandidate } from "@/lib/triage/data";
import { useWorkspace } from "./use-workspace";
import { PoolScreen } from "./pool-screen";
import { CandidateScreen } from "./candidate-screen";

type View = "pool" | "candidate";

export function TriageApp() {
  const wsApi = useWorkspace();
  const [view, setView] = useState<View>("pool");
  const [activeId, setActiveId] = useState<string>("prashanthi");
  const [filter, setFilter] = useState<string>("all");

  const openPool = () => setView("pool");
  const openCandidate = (id: string) => {
    setActiveId(id);
    setView("candidate");
  };
  const openDeep = (id: string) => {
    wsApi.runDeep(id);
    openCandidate(id);
  };

  const isCandidate = view === "candidate";

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#FAFAF7",
        fontFamily: FONTS.sans,
        color: "#162335",
        fontSize: 17,
        lineHeight: 1.5,
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
          gap: 18,
          padding: "0 28px",
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
        <div style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 16, flexShrink: 0, whiteSpace: "nowrap" }}>
          <span style={{ cursor: "pointer", color: view === "pool" ? "#162335" : "rgba(22,35,53,0.55)" }} onClick={openPool}>
            {POOL_TITLE}
          </span>
          {isCandidate && (
            <>
              <span style={{ color: "rgba(22,35,53,0.30)" }}>›</span>
              <span style={{ color: "#162335" }}>{findCandidate(activeId).name}</span>
            </>
          )}
        </div>
        <div style={{ flex: 1 }} />
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

      {view === "pool" ? (
        <PoolScreen wsApi={wsApi} filter={filter} setFilter={setFilter} openCandidate={openCandidate} openDeep={openDeep} />
      ) : (
        <CandidateScreen wsApi={wsApi} activeId={activeId} openPool={openPool} />
      )}
    </div>
  );
}
