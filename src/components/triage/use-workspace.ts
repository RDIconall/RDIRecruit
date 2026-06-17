"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ActivityEntry, ActivityType, Candidate, ChatMessage, DecisionRead, ReviewerKind, TimelineRow, Workspace } from "@/lib/triage/types";
import { reviewerKindLabel } from "@/lib/triage/reviewer";
import {
  bulkDisqualify,
  clearCandidateChat,
  compareToRubric,
  logActivity as logActivityAction,
  resyncCandidate,
  runDeepAnalysis,
  saveCorrection,
  saveReply,
  saveTimeline,
  saveTranscript,
  sendCandidateChat,
  setDisqualified,
  updateAssessment,
} from "@/app/actions/triage";

export interface WorkspaceApi {
  ws: Workspace;
  hydrated: boolean;
  busy: Record<string, boolean>;
  chatBusy: Record<string, boolean>;
  notice: string | null;
  clearNotice: () => void;
  sendChat: (id: string, text: string) => void;
  clearChat: (id: string) => void;
  toggleDq: (id: string) => void;
  bulkDq: () => void;
  /** Force a set of candidates to (un)disqualified — drives the board's selection bulk bar. */
  setDqMany: (ids: string[], value: boolean) => void;
  openCount: number;
  runDeep: (id: string) => void;
  compareRubric: (id: string) => void;
  resync: (id: string) => void;
  effTimeline: (id: string) => TimelineRow[];
  editCell: (id: string, idx: number, field: keyof TimelineRow, val: string) => void;
  addRow: (id: string, type: "role" | "gap" | "cert") => void;
  removeRow: (id: string, idx: number) => void;
  setReply: (id: string, key: string, val: string) => void;
  setTranscript: (id: string, val: string) => void;
  addCorrection: (id: string, text: string, reviewerKind?: ReviewerKind) => void;
  /** Append a human entry to the candidate's activity log (interview/note/comment). */
  logActivity: (id: string, type: ActivityType, body: string) => void;
  /** Re-run the evaluator over the activity-log delta and re-persist the pinned assessment. */
  updateAssessment: (id: string) => void;
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
  const router = useRouter();
  const [ws, setWs] = useState<Workspace>(initial);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [chatBusy, setChatBusy] = useState<Record<string, boolean>>({});
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
    void setDisqualified({ candidateId: id, disqualified: next }).then((res) => {
      if (res?.workable === "disqualified") setNotice("Disqualified in Workable too.");
      else if (res?.workable === "failed") setNotice("Cut saved locally, but the Workable disqualify failed — retry or do it in Workable.");
    });
  }, []);

  const bulkDq = useCallback(() => {
    const anyOpen = cuts.some((c) => !wsRef.current.dq[c.id]);
    const dq = { ...wsRef.current.dq };
    cuts.forEach((c) => (dq[c.id] = anyOpen));
    setWs((w) => ({ ...w, dq }));
    void bulkDisqualify({ candidateIds: cuts.map((c) => c.id), disqualified: anyOpen }).then((res) => {
      if (res?.workableDisqualified) {
        setNotice(
          `Disqualified ${res.workableDisqualified} in Workable${res.workableFailed ? ` · ${res.workableFailed} failed` : ""}.`,
        );
      } else if (res?.workableFailed) {
        setNotice(`Cuts saved locally, but ${res.workableFailed} Workable disqualify call(s) failed.`);
      }
    });
  }, [cuts]);

  const setDqMany = useCallback((ids: string[], value: boolean) => {
    const targets = ids.filter(Boolean);
    if (!targets.length) return;
    setWs((w) => {
      const dq = { ...w.dq };
      targets.forEach((id) => (dq[id] = value));
      return { ...w, dq };
    });
    void bulkDisqualify({ candidateIds: targets, disqualified: value }).then((res) => {
      if (res?.workableDisqualified) {
        setNotice(
          `${value ? "Disqualified" : "Reinstated"} ${res.workableDisqualified} in Workable${res.workableFailed ? ` · ${res.workableFailed} failed` : ""}.`,
        );
      } else if (res?.workableFailed) {
        setNotice(`Saved locally, but ${res.workableFailed} Workable call(s) failed.`);
      }
    });
  }, []);

  const runDeep = useCallback(
    (id: string) => {
      setWs((w) => ({ ...w, deep: { ...w.deep, [id]: true } }));
      void handleRecalc(id, () => runDeepAnalysis({ candidateId: id }));
    },
    [handleRecalc],
  );

  const compareRubric = useCallback(
    (id: string) => {
      void handleRecalc(id, () => compareToRubric({ candidateId: id }));
    },
    [handleRecalc],
  );

  const resync = useCallback(
    (id: string) => {
      setBusyFor(id, true);
      void resyncCandidate({ candidateId: id })
        .then((res) => {
          setNotice(res.message);
          if (res.ok) router.refresh();
        })
        .catch(() => setNotice("Sync failed — please retry."))
        .finally(() => setBusyFor(id, false));
    },
    [router, setBusyFor],
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
    (id: string, text: string, reviewerKind?: ReviewerKind) => {
      const v = text.trim();
      if (!v) return;
      // Optimistic entry: stamp the picked reviewer's label; the server persists the
      // authoritative Clerk-derived label/id on its write.
      const optimistic = {
        ts: nowStamp(),
        text: v,
        ...(reviewerKind ? { reviewerKind, reviewerLabel: reviewerKindLabel(reviewerKind) } : {}),
      };
      const log = [...(wsRef.current.corrections[id] || []), optimistic];
      setWs((w) => ({ ...w, corrections: { ...w.corrections, [id]: log } }));
      void handleRecalc(id, () => saveCorrection({ candidateId: id, text: v, reviewerKind }));
    },
    [handleRecalc],
  );

  const sendChat = useCallback((id: string, text: string) => {
    const v = text.trim();
    if (!v) return;
    // Optimistic: show the human's turn immediately; the server returns the
    // authoritative thread (with Claude's reply) which we then swap in.
    const optimistic: ChatMessage = { role: "user", content: v, ts: new Date().toISOString() };
    const log = [...(wsRef.current.chat[id] || []), optimistic];
    setWs((w) => ({ ...w, chat: { ...w.chat, [id]: log } }));
    setChatBusy((b) => ({ ...b, [id]: true }));
    void sendCandidateChat({ candidateId: id, message: v })
      .then((res) => {
        if (res.messages?.length) {
          setWs((w) => ({ ...w, chat: { ...w.chat, [id]: res.messages } }));
        }
        if (res.message) setNotice(res.message);
      })
      .catch(() => setNotice("Chat failed — please retry."))
      .finally(() => setChatBusy((b) => ({ ...b, [id]: false })));
  }, []);

  const clearChat = useCallback((id: string) => {
    setWs((w) => ({ ...w, chat: { ...w.chat, [id]: [] } }));
    void clearCandidateChat({ candidateId: id });
  }, []);

  const logActivity = useCallback((id: string, type: ActivityType, body: string) => {
    const v = body.trim();
    if (!v) return;
    const optimistic: ActivityEntry = {
      id: `tmp-${Date.now()}`,
      type,
      author: "You",
      body: v,
      at: new Date().toISOString(),
    };
    const log = [...(wsRef.current.activity[id] || []), optimistic];
    setWs((w) => ({ ...w, activity: { ...w.activity, [id]: log } }));
    void logActivityAction({ candidateId: id, type, body: v })
      .then((res) => {
        if (res.ok && res.entry) {
          // Swap the optimistic row for the persisted one (real id + author + ts).
          setWs((w) => ({
            ...w,
            activity: {
              ...w.activity,
              [id]: (w.activity[id] || []).map((e) => (e.id === optimistic.id ? res.entry! : e)),
            },
          }));
        } else if (res.message) {
          setNotice(res.message);
        }
      })
      .catch(() => setNotice("Couldn't save to the activity log — please retry."));
  }, []);

  const updateAssessmentCb = useCallback(
    (id: string) => {
      void handleRecalc(id, async () => {
        const res = await updateAssessment({ candidateId: id });
        if (res.ok && res.read) {
          setWs((w) => ({ ...w, regen: { ...w.regen, [id]: res.regenAt || nowStamp() } }));
        }
        return res;
      });
    },
    [handleRecalc],
  );

  const clearNotice = useCallback(() => setNotice(null), []);

  return {
    ws,
    hydrated: true,
    busy,
    chatBusy,
    notice,
    clearNotice,
    sendChat,
    clearChat,
    toggleDq,
    bulkDq,
    setDqMany,
    openCount,
    runDeep,
    compareRubric,
    resync,
    effTimeline,
    editCell,
    addRow,
    removeRow,
    setReply,
    setTranscript,
    addCorrection,
    logActivity,
    updateAssessment: updateAssessmentCb,
  };
}
