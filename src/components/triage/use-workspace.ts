"use client";

import { useCallback, useEffect, useState } from "react";
import type { TimelineRow, Workspace } from "@/lib/triage/types";
import { emptyWorkspace, loadWorkspace, nowStamp, saveWorkspace } from "@/lib/triage/workspace";
import { CANDIDATES, findCandidate } from "@/lib/triage/data";

export interface WorkspaceApi {
  ws: Workspace;
  hydrated: boolean;
  toggleDq: (id: string) => void;
  bulkDq: () => void;
  openCount: number; // cuts still open (not disqualified)
  runDeep: (id: string) => void;
  effTimeline: (id: string) => TimelineRow[];
  editCell: (id: string, idx: number, field: keyof TimelineRow, val: string) => void;
  addRow: (id: string, type: "role" | "gap" | "cert") => void;
  removeRow: (id: string, idx: number) => void;
  setReply: (id: string, key: string, val: string) => void;
  setTranscript: (id: string, val: string) => void;
  addCorrection: (id: string, text: string) => void;
}

export function useWorkspace(): WorkspaceApi {
  const [ws, setWs] = useState<Workspace>(emptyWorkspace);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setWs(loadWorkspace());
    setHydrated(true);
  }, []);

  const commit = useCallback((next: Workspace) => {
    setWs(next);
    saveWorkspace(next);
  }, []);

  const toggleDq = useCallback(
    (id: string) => commit({ ...ws, dq: { ...ws.dq, [id]: !ws.dq[id] } }),
    [ws, commit],
  );

  const cuts = CANDIDATES.filter((c) => c.decision === "cut");
  const openCount = cuts.filter((c) => !ws.dq[c.id]).length;

  const bulkDq = useCallback(() => {
    const anyOpen = cuts.some((c) => !ws.dq[c.id]);
    const dq = { ...ws.dq };
    cuts.forEach((c) => (dq[c.id] = anyOpen));
    commit({ ...ws, dq });
  }, [ws, commit, cuts]);

  const runDeep = useCallback(
    (id: string) => commit({ ...ws, deep: { ...ws.deep, [id]: true } }),
    [ws, commit],
  );

  const effTimeline = useCallback(
    (id: string): TimelineRow[] => (ws.ovr[id] || findCandidate(id).timeline || []).map((r) => ({ ...r })),
    [ws],
  );

  const editCell = useCallback(
    (id: string, idx: number, field: keyof TimelineRow, val: string) => {
      const cur = effTimeline(id);
      if (cur[idx]) (cur[idx][field] as string) = val;
      commit({ ...ws, ovr: { ...ws.ovr, [id]: cur } });
    },
    [ws, commit, effTimeline],
  );

  const addRow = useCallback(
    (id: string, type: "role" | "gap" | "cert") => {
      const cur = effTimeline(id);
      const blank: TimelineRow =
        type === "gap"
          ? { type: "gap", period: "", org: "—", role: "Gap", tenure: "", scope: "New gap — describe", lang: "—", signal: "Gap" }
          : type === "cert"
            ? { type: "cert", period: "", org: "", role: "New certificate", tenure: "—", scope: "", lang: "—", signal: "Cert" }
            : { type: "role", period: "", org: "", role: "New role", tenure: "", scope: "", lang: "Reads —, scope —", signal: "Positive" };
      cur.push(blank);
      commit({ ...ws, ovr: { ...ws.ovr, [id]: cur } });
    },
    [ws, commit, effTimeline],
  );

  const removeRow = useCallback(
    (id: string, idx: number) => {
      const cur = effTimeline(id);
      cur.splice(idx, 1);
      commit({ ...ws, ovr: { ...ws.ovr, [id]: cur } });
    },
    [ws, commit, effTimeline],
  );

  const setReply = useCallback(
    (id: string, key: string, val: string) => {
      const r = { ...(ws.replies[id] || {}) };
      r[key] = val;
      commit({ ...ws, replies: { ...ws.replies, [id]: r } });
    },
    [ws, commit],
  );

  const setTranscript = useCallback(
    (id: string, val: string) => commit({ ...ws, transcripts: { ...ws.transcripts, [id]: val } }),
    [ws, commit],
  );

  const addCorrection = useCallback(
    (id: string, text: string) => {
      const v = text.trim();
      if (!v) return;
      const log = [...(ws.corrections[id] || []), { ts: nowStamp(), text: v }];
      commit({ ...ws, corrections: { ...ws.corrections, [id]: log } });
    },
    [ws, commit],
  );

  return {
    ws,
    hydrated,
    toggleDq,
    bulkDq,
    openCount,
    runDeep,
    effTimeline,
    editCell,
    addRow,
    removeRow,
    setReply,
    setTranscript,
    addCorrection,
  };
}
