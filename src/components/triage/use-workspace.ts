"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { Candidate, DecisionRead, TimelineRow, Workspace } from "@/lib/triage/types";
import {
  bulkDisqualify,
  runDeepAnalysis,
  saveCorrection,
  saveReply,
  saveTimeline,
  saveTranscript,
  setDisqualified,
} from "@/app/actions/triage";

export interface WorkspaceApi {
  ws: Workspace;
  hydrated: boolean;
  busy: Record<string, boolean>;
  notice: string | null;
  clearNotice: () => void;
  toggleDq: (id: string) => void;
  bulkDq: () => void;
  openCount: number;
  runDeep: (id: string) => void;
  effTimeline: (id: string) => TimelineRow[];
  editCell: (id: string, idx: number, field: keyof TimelineRow, val: string) => void;
  addRow: (id: string, type: "role" | "gap" | "cert") => void;
  removeRow: (id: string, idx: number) => void;
  setReply: (id: string, key: string, val: string) => void;
  setTranscript: (id: string, val: string) => void;
  addCorrection: (id: string, text: string) => void;
}

function nowStamp(): string {
  const d = new Date();
  return (
    d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) +
    " " +
    d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
  );
}

export function useWorkspace(
  initial: Workspace,
  candidates: Candidate[],
  onRead: (id: string, read: DecisionRead) => void,
): WorkspaceApi {
  const [ws, setWs] = useState<Workspace>(initial);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const cuts = useMemo(() => candidates.filter((c) => c.decision === "cut"), [candidates]);
  const openCount = cuts.filter((c) => !ws.dq[c.id]).length;

  const setBusyFor = useCallback((id: string, v: boolean) => {
    setBusy((b) => ({ ...b, [id]: v }));
  }, []);

  const handleRecalc = useCallback(
    async (id: string, run: () => Promise<{ ok: boolean; read: DecisionRead | null; message?: string }>) => {
      setBusyFor(id, true);
      try {
        const res = await run();
        if (res.read) onRead(id, res.read);
        if (res.message) setNotice(res.message);
        else if (res.ok && res.read) setNotice("Claude re-analyzed this candidate.");
      } catch {
        setNotice("Save failed — please retry.");
      } finally {
        setBusyFor(id, false);
      }
    },
    [onRead, setBusyFor],
  );

  const toggleDq = useCallback((id: string) => {
    const next = !wsRef.current.dq[id];
    setWs((w) => ({ ...w, dq: { ...w.dq, [id]: next } }));
    void setDisqualified({ candidateId: id, disqualified: next });
  }, []);

  const bulkDq = useCallback(() => {
    const anyOpen = cuts.some((c) => !wsRef.current.dq[c.id]);
    const dq = { ...wsRef.current.dq };
    cuts.forEach((c) => (dq[c.id] = anyOpen));
    setWs((w) => ({ ...w, dq }));
    void bulkDisqualify({ candidateIds: cuts.map((c) => c.id), disqualified: anyOpen });
  }, [cuts]);

  const runDeep = useCallback(
    (id: string) => {
      setWs((w) => ({ ...w, deep: { ...w.deep, [id]: true } }));
      void handleRecalc(id, () => runDeepAnalysis({ candidateId: id }));
    },
    [handleRecalc],
  );

  const findTimeline = useCallback(
    (id: string): TimelineRow[] => {
      const c = candidates.find((x) => x.id === id);
      return (wsRef.current.ovr[id] || c?.timeline || []).map((r) => ({ ...r }));
    },
    [candidates],
  );

  const effTimeline = findTimeline;

  const persistTimeline = useCallback((id: string, rows: TimelineRow[]) => {
    clearTimeout(timers.current[`tl-${id}`]);
    timers.current[`tl-${id}`] = setTimeout(() => {
      void saveTimeline({ candidateId: id, ovr: rows });
    }, 600);
  }, []);

  const editCell = useCallback(
    (id: string, idx: number, field: keyof TimelineRow, val: string) => {
      const cur = findTimeline(id);
      if (cur[idx]) (cur[idx][field] as string) = val;
      setWs((w) => ({ ...w, ovr: { ...w.ovr, [id]: cur } }));
      persistTimeline(id, cur);
    },
    [findTimeline, persistTimeline],
  );

  const addRow = useCallback(
    (id: string, type: "role" | "gap" | "cert") => {
      const cur = findTimeline(id);
      const blank: TimelineRow =
        type === "gap"
          ? { type: "gap", period: "", org: "—", role: "Gap", tenure: "", scope: "New gap — describe", lang: "—", signal: "Gap" }
          : type === "cert"
            ? { type: "cert", period: "", org: "", role: "New certificate", tenure: "—", scope: "", lang: "—", signal: "Cert" }
            : { type: "role", period: "", org: "", role: "New role", tenure: "", scope: "", lang: "Reads —, scope —", signal: "Positive" };
      cur.push(blank);
      setWs((w) => ({ ...w, ovr: { ...w.ovr, [id]: cur } }));
      persistTimeline(id, cur);
    },
    [findTimeline, persistTimeline],
  );

  const removeRow = useCallback(
    (id: string, idx: number) => {
      const cur = findTimeline(id);
      cur.splice(idx, 1);
      setWs((w) => ({ ...w, ovr: { ...w.ovr, [id]: cur } }));
      persistTimeline(id, cur);
    },
    [findTimeline, persistTimeline],
  );

  const setReply = useCallback((id: string, key: string, val: string) => {
    const r = { ...(wsRef.current.replies[id] || {}) };
    r[key] = val;
    setWs((w) => ({ ...w, replies: { ...w.replies, [id]: r } }));
    clearTimeout(timers.current[`rep-${id}-${key}`]);
    timers.current[`rep-${id}-${key}`] = setTimeout(() => {
      void saveReply({ candidateId: id, key, value: val });
    }, 700);
  }, []);

  const setTranscript = useCallback(
    (id: string, val: string) => {
      setWs((w) => ({ ...w, transcripts: { ...w.transcripts, [id]: val } }));
      void handleRecalc(id, () => saveTranscript({ candidateId: id, transcript: val }));
    },
    [handleRecalc],
  );

  const addCorrection = useCallback(
    (id: string, text: string) => {
      const v = text.trim();
      if (!v) return;
      const log = [...(wsRef.current.corrections[id] || []), { ts: nowStamp(), text: v }];
      setWs((w) => ({ ...w, corrections: { ...w.corrections, [id]: log } }));
      void handleRecalc(id, () => saveCorrection({ candidateId: id, text: v }));
    },
    [handleRecalc],
  );

  const clearNotice = useCallback(() => setNotice(null), []);

  return {
    ws,
    hydrated: true,
    busy,
    notice,
    clearNotice,
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
