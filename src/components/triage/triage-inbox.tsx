"use client";

import { useMemo, useState } from "react";
import { APP, DECISION_LABEL } from "@/lib/triage/app-theme";
import { isInboxStage, phoneScreenSlug, type StageColumn } from "@/lib/triage/stages";
import { sortBestNew } from "@/lib/triage/ranking";
import type { Candidate, Decision } from "@/lib/triage/types";
import type { WorkspaceApi } from "./use-workspace";
import { useTriageData } from "./context";
import { Avatar, Checkbox, Dot, StatusSelect, mono, ellipsis } from "./pool-shared";

interface Props {
  wsApi: WorkspaceApi;
  openCandidate: (id: string) => void;
  stages: StageColumn[];
  onStageChange: (id: string, stage: string) => void;
  crossRole?: boolean;
}

type Filter = "all" | Decision;

function flagChips(c: Candidate) {
  const chips: { label: string; color: string; bg: string }[] = [];
  if (c.refusedToAnswer) chips.push({ label: "Refused", color: APP.weak, bg: APP.weakSoft });
  if (c.cutGroup === "evidence" || /integrity/i.test(c.why || "") || /integrity/i.test(c.cutReason || "")) {
    chips.push({ label: "Integrity", color: APP.weak, bg: APP.weakSoft });
  }
  if (c.decision === "blocked") chips.push({ label: "Blocked", color: APP.muted, bg: APP.line2 });
  return chips;
}

export function TriageInbox({ wsApi, openCandidate, stages, onStageChange, crossRole }: Props) {
  const { candidates, meta } = useTriageData();
  const dq = wsApi.ws.dq;
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Record<string, boolean>>({});

  const inbox = useMemo(() => {
    const query = q.trim().toLowerCase();
    const rows = candidates
      .filter((c) => !dq[c.id] && isInboxStage(c.workableStage))
      .filter((c) => (filter === "all" ? true : c.decision === filter))
      .filter((c) => {
        if (!query) return true;
        return `${c.name} ${c.company} ${c.why} ${c.role} ${c.jobTitle || ""}`.toLowerCase().includes(query);
      });
    return sortBestNew(rows);
  }, [candidates, dq, filter, q]);

  const best = inbox.find((c) => c.decision === "interview") ?? inbox[0] ?? null;
  const selectedIds = Object.keys(sel).filter((id) => sel[id] && inbox.some((c) => c.id === id));
  const screenSlug = phoneScreenSlug(stages);

  const toggle = (id: string) =>
    setSel((s) => {
      const next = { ...s };
      if (next[id]) delete next[id];
      else next[id] = true;
      return next;
    });

  const sendToScreen = (id: string) => {
    if (crossRole) {
      wsApi.sendToScreen(id);
      return;
    }
    if (!screenSlug) return;
    onStageChange(id, screenSlug);
  };

  return (
    <div style={{ padding: "12px 20px 28px" }}>
      {crossRole && best && (
        <div
          style={{
            marginBottom: 14,
            padding: "14px 16px",
            borderRadius: 10,
            border: `1px solid ${APP.accentBorder}`,
            background: APP.accentSoft,
            display: "flex",
            gap: 14,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={mono({ fontSize: 11, color: APP.accent, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" })}>
              Best new applicant
            </div>
            <div style={{ fontWeight: 700, fontSize: 17, marginTop: 2 }}>
              {best.name}
              <span style={{ fontWeight: 500, color: APP.secondary, fontSize: 14 }}>
                {" "}
                · {best.jobTitle || best.role}
              </span>
            </div>
            <div style={{ fontSize: 13, color: APP.ink2, marginTop: 4 }}>{best.why || DECISION_LABEL[best.decision]}</div>
            <div style={mono({ fontSize: 12, color: APP.muted, marginTop: 4 })}>
              {DECISION_LABEL[best.decision]} · {best.answersRead.label} · {best.value?.headline || "—"}
            </div>
          </div>
          <button type="button" onClick={() => openCandidate(best.id)} style={{ ...btnStyle, background: APP.accent, borderColor: APP.accent, color: "#fff" }}>
            Open
          </button>
          {best.decision === "interview" && (
            <button type="button" onClick={() => sendToScreen(best.id)} style={btnStyle}>
              Send to screen
            </button>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={crossRole ? "Search across roles" : "Search new candidates"}
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
        {(
          [
            ["all", "All new"],
            ["interview", "Interview"],
            ["backup", "Backup"],
            ["reject", "Reject"],
            ["blocked", "Blocked"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            style={{
              height: 28,
              padding: "0 10px",
              borderRadius: 999,
              border: `1px solid ${filter === key ? APP.accentBorder : APP.hair}`,
              background: filter === key ? APP.accentSoft : APP.surface,
              color: filter === key ? APP.accent : APP.secondary,
              fontWeight: 600,
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        ))}
        <span style={{ marginLeft: "auto", ...mono({ fontSize: 12, color: APP.muted }) }}>
          {inbox.length} new · {meta.healthRead}
        </span>
      </div>

      {selectedIds.length > 0 && (
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            marginBottom: 10,
            padding: "10px 12px",
            borderRadius: 8,
            background: APP.ink,
            color: "#fff",
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600 }}>{selectedIds.length} selected</span>
          <button
            type="button"
            onClick={() => {
              wsApi.setDqMany(selectedIds, true);
              setSel({});
            }}
            style={{
              height: 30,
              padding: "0 12px",
              borderRadius: 6,
              border: "none",
              background: APP.weak,
              color: "#fff",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Disqualify in Workable
          </button>
          <button
            type="button"
            onClick={() => setSel({})}
            style={{
              height: 30,
              padding: "0 12px",
              borderRadius: 6,
              border: "1px solid rgba(255,255,255,.3)",
              background: "transparent",
              color: "#fff",
              cursor: "pointer",
            }}
          >
            Clear
          </button>
        </div>
      )}

      <div style={{ background: APP.surface, border: `1px solid ${APP.hair}`, borderRadius: 10, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: APP.line2 }}>
              <th style={{ width: 36, padding: "10px 12px" }}>
                <Checkbox
                  label="Select all"
                  checked={inbox.length > 0 && selectedIds.length === inbox.length}
                  onChange={() => {
                    if (selectedIds.length === inbox.length) setSel({});
                    else {
                      const next: Record<string, boolean> = {};
                      inbox.forEach((c) => {
                        next[c.id] = true;
                      });
                      setSel(next);
                    }
                  }}
                />
              </th>
              {(crossRole
                ? ["Candidate", "Role", "AI call", "Answers", "Why", "Flags", ""]
                : ["Candidate", "AI call", "Answers", "Why", "Flags", "Workable", ""]
              ).map((h) => (
                <th
                  key={h || "actions"}
                  style={{
                    textAlign: "left",
                    fontSize: 11,
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                    color: APP.muted,
                    fontWeight: 700,
                    padding: "10px 12px",
                    borderBottom: `1px solid ${APP.hair}`,
                    whiteSpace: "nowrap",
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {inbox.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ padding: 28, textAlign: "center", color: APP.muted, fontSize: 13 }}>
                  No new applicants in Applied — try another filter or job.
                </td>
              </tr>
            ) : (
              inbox.map((c, idx) => {
                const chips = flagChips(c);
                return (
                  <tr
                    key={c.id}
                    style={{
                      borderBottom: `1px solid ${APP.hair}`,
                      background: idx === 0 && c.decision === "interview" ? APP.accentSoft : undefined,
                    }}
                  >
                    <td style={{ padding: "10px 12px" }}>
                      <Checkbox label={`Select ${c.name}`} checked={!!sel[c.id]} onChange={() => toggle(c.id)} />
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 160 }}>
                        <Avatar c={c} size={30} />
                        <div style={{ minWidth: 0 }}>
                          <button
                            type="button"
                            onClick={() => openCandidate(c.id)}
                            style={{
                              background: "none",
                              border: "none",
                              padding: 0,
                              fontWeight: 650,
                              color: APP.ink,
                              cursor: "pointer",
                              fontSize: 14,
                              textAlign: "left",
                            }}
                          >
                            {c.name}
                          </button>
                          <div style={{ fontSize: 12, color: APP.muted, ...ellipsis }}>
                            {c.role} · {c.company}
                          </div>
                        </div>
                      </div>
                    </td>
                    {crossRole && (
                      <td style={{ padding: "10px 12px", fontSize: 13, color: APP.ink2, maxWidth: 180 }}>
                        <div style={ellipsis} title={c.jobTitle}>
                          {c.jobTitle || "—"}
                        </div>
                      </td>
                    )}
                    <td style={{ padding: "10px 12px" }}>
                      <StatusSelect value={c.decision} onChange={(d) => wsApi.setDecision(c.id, d)} />
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      <Dot read={c.answersRead} />
                    </td>
                    <td style={{ padding: "10px 12px", maxWidth: 280, color: APP.ink2, fontSize: 13 }} title={c.why}>
                      <div style={ellipsis}>{c.why || DECISION_LABEL[c.decision]}</div>
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      {chips.length === 0 ? (
                        <span style={{ color: APP.faint }}>—</span>
                      ) : (
                        chips.map((chip) => (
                          <span
                            key={chip.label}
                            style={{
                              display: "inline-block",
                              fontSize: 11,
                              fontWeight: 700,
                              padding: "2px 7px",
                              borderRadius: 4,
                              color: chip.color,
                              background: chip.bg,
                              marginRight: 4,
                            }}
                          >
                            {chip.label}
                          </span>
                        ))
                      )}
                    </td>
                    {!crossRole && (
                      <td style={{ padding: "10px 12px", fontSize: 12, color: APP.muted }}>
                        {c.workableStage || "Applied"}
                      </td>
                    )}
                    <td style={{ padding: "10px 12px", whiteSpace: "nowrap", textAlign: "right" }}>
                      <button type="button" onClick={() => openCandidate(c.id)} style={btnStyle}>
                        Open
                      </button>
                      {c.decision === "interview" && (
                        <button
                          type="button"
                          onClick={() => sendToScreen(c.id)}
                          style={{ ...btnStyle, background: APP.accent, borderColor: APP.accent, color: "#fff" }}
                        >
                          Send to screen
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => wsApi.toggleDq(c.id)}
                        style={{ ...btnStyle, color: APP.weak, borderColor: APP.weakBorder, background: APP.weakSoft }}
                      >
                        DQ
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  height: 30,
  padding: "0 10px",
  borderRadius: 6,
  border: `1px solid ${APP.hair}`,
  background: APP.surface,
  color: APP.ink,
  fontWeight: 600,
  fontSize: 12,
  cursor: "pointer",
  marginLeft: 6,
};
