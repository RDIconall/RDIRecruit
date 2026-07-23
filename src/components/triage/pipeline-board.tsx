"use client";

import { useMemo, useState } from "react";
import { APP, DECISION_LABEL } from "@/lib/triage/app-theme";
import { matchStageSlug, type StageColumn } from "@/lib/triage/stages";
import type { Candidate } from "@/lib/triage/types";
import type { WorkspaceApi } from "./use-workspace";
import { useTriageData } from "./context";
import { Avatar, mono } from "./pool-shared";

interface Props {
  wsApi: WorkspaceApi;
  openCandidate: (id: string) => void;
  stages: StageColumn[];
  onStageChange: (id: string, stage: string) => void;
}

export function PipelineBoard({ wsApi, openCandidate, stages, onStageChange }: Props) {
  const { candidates } = useTriageData();
  const dq = wsApi.ws.dq;
  const [q, setQ] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [overSlug, setOverSlug] = useState<string | null>(null);

  const query = q.trim().toLowerCase();

  const byColumn = useMemo(() => {
    const map = new Map<string, Candidate[]>();
    for (const col of stages) map.set(col.slug, []);

    for (const c of candidates) {
      if (query && !`${c.name} ${c.company} ${c.why}`.toLowerCase().includes(query)) continue;
      if (dq[c.id]) {
        map.get("disqualified")?.push(c);
        continue;
      }
      const slug = matchStageSlug(c.workableStage, stages) ?? stages.find((s) => s.isInbox)?.slug ?? "applied";
      if (slug === "disqualified") {
        map.get("disqualified")?.push(c);
        continue;
      }
      const list = map.get(slug);
      if (list) list.push(c);
      else map.get(stages.find((s) => s.isInbox)?.slug ?? "applied")?.push(c);
    }
    return map;
  }, [candidates, dq, stages, query]);

  const total = [...byColumn.values()].reduce((n, rows) => n + rows.length, 0);

  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "12px 20px 0", flexWrap: "wrap" }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search pipeline"
          style={{
            height: 34,
            border: `1px solid ${APP.hair}`,
            borderRadius: 6,
            padding: "0 10px",
            width: 240,
            fontFamily: APP.sans,
            fontSize: 13,
          }}
        />
        <span style={mono({ fontSize: 12, color: APP.muted })}>
          Drag a card to move stage → writes to Workable
        </span>
        <span style={{ marginLeft: "auto", ...mono({ fontSize: 12, color: APP.muted }) }}>{total} in pipeline</span>
      </div>

      <div
        style={{
          display: "grid",
          gridAutoFlow: "column",
          gridAutoColumns: "minmax(220px, 1fr)",
          gap: 12,
          padding: "12px 20px 28px",
          overflowX: "auto",
          alignItems: "start",
          minHeight: "calc(100vh - 140px)",
        }}
      >
        {stages.map((col) => {
          const rows = byColumn.get(col.slug) ?? [];
          const isDq = col.slug === "disqualified";
          return (
            <div
              key={col.slug}
              onDragOver={(e) => {
                if (isDq) return;
                e.preventDefault();
                setOverSlug(col.slug);
              }}
              onDragLeave={() => setOverSlug((s) => (s === col.slug ? null : s))}
              onDrop={(e) => {
                e.preventDefault();
                setOverSlug(null);
                if (!dragId || isDq) return;
                onStageChange(dragId, col.slug);
                setDragId(null);
              }}
              style={{
                background: isDq ? APP.weakSoft : APP.line2,
                border: `1px solid ${overSlug === col.slug ? APP.accent : isDq ? APP.weakBorder : APP.hair}`,
                borderRadius: 10,
                minHeight: 420,
                outline: overSlug === col.slug ? `2px dashed ${APP.accent}` : undefined,
                outlineOffset: -4,
              }}
            >
              <div style={{ padding: "12px 12px 4px", display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ fontWeight: 750, fontSize: 13 }}>{col.name}</div>
                <div
                  style={{
                    marginLeft: "auto",
                    fontSize: 11,
                    fontWeight: 700,
                    color: APP.muted,
                    background: APP.surface,
                    border: `1px solid ${APP.hair}`,
                    borderRadius: 999,
                    padding: "1px 7px",
                  }}
                >
                  {rows.length}
                </div>
              </div>
              <div style={{ padding: "0 12px 10px", fontSize: 11, color: APP.muted }}>
                {col.isInbox ? "Triage inbox" : isDq ? "Workable disposition — use DQ" : "Workable stage"}
              </div>
              <div style={{ padding: "0 8px 10px", display: "flex", flexDirection: "column", gap: 8, minHeight: 80 }}>
                {rows.length === 0 ? (
                  <div style={{ padding: 16, textAlign: "center", color: APP.muted, fontSize: 12 }}>No candidates</div>
                ) : (
                  rows.map((c) => (
                    <article
                      key={c.id}
                      draggable={!isDq}
                      onDragStart={() => setDragId(c.id)}
                      onDragEnd={() => {
                        setDragId(null);
                        setOverSlug(null);
                      }}
                      style={{
                        background: APP.surface,
                        border: `1px solid ${APP.hair}`,
                        borderRadius: 8,
                        padding: 10,
                        cursor: isDq ? "default" : "grab",
                        opacity: dragId === c.id ? 0.45 : 1,
                        boxShadow: "0 1px 2px rgba(16,24,40,.06)",
                      }}
                    >
                      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                        <Avatar c={c} size={28} />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: 13 }}>{c.name}</div>
                          <div style={{ fontSize: 12, color: APP.muted }}>
                            {c.role} · {c.company}
                          </div>
                        </div>
                      </div>
                      <div style={{ fontSize: 12, color: APP.ink2, marginTop: 8, lineHeight: 1.4 }}>
                        {c.why || DECISION_LABEL[c.decision]}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 750,
                            letterSpacing: "0.02em",
                            textTransform: "uppercase",
                            padding: "2px 6px",
                            borderRadius: 4,
                            border: `1px solid ${APP.hair}`,
                            background: APP.line2,
                          }}
                        >
                          {c.decision}
                        </span>
                        <button
                          type="button"
                          onClick={() => openCandidate(c.id)}
                          style={{
                            marginLeft: "auto",
                            border: 0,
                            background: "transparent",
                            color: APP.accent,
                            fontWeight: 700,
                            fontSize: 12,
                            cursor: "pointer",
                            padding: 0,
                          }}
                        >
                          Open
                        </button>
                      </div>
                    </article>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
