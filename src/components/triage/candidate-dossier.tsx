"use client";

import { CSSProperties, useEffect, useMemo, useState } from "react";
import { APP, DECISION_LABEL, decisionColor, verdictDot } from "@/lib/triage/app-theme";
import type { ActivityType, Candidate, TimelineRow, VerdictRead } from "@/lib/triage/types";
import type { WorkspaceApi } from "./use-workspace";
import { useTriageData } from "./context";
import { useIsNarrow } from "./use-media-query";
import { getWorkingFileContent } from "@/app/actions/triage";

const mono = (extra: CSSProperties = {}): CSSProperties => ({ fontFamily: APP.mono, ...extra });

interface Props {
  wsApi: WorkspaceApi;
  activeId: string;
  openPool: () => void;
}

// ---------- small derivations (all from cached data — never Claude on render) ----------

/** Leading roman numeral of an RO stratum ("IIa" → 2, "IIIb" → 3.5). */
function stratumToNum(stratum: string): number | null {
  const m = (stratum || "").trim().match(/^(VII|VI|IV|IX|V|III|II|I)([a-c])?/i);
  if (!m) return null;
  const roman: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, ix: 9 };
  const base = roman[m[1].toLowerCase()];
  if (!base) return null;
  const sub = m[2]?.toLowerCase();
  return base + (sub === "b" ? 0.5 : sub === "c" ? 0.66 : 0);
}

function reviewedList(c: Candidate, activityCount: number): string[] {
  const out: string[] = [];
  if (c.resume?.hasResume) out.push(c.resume.roles.length ? `Résumé — ${c.resume.roles.length} roles` : "Résumé");
  if (c.cover?.hasLetter) out.push("Cover letter");
  if (c.answers?.length) out.push(`${c.answers.length} application ${c.answers.length === 1 ? "answer" : "answers"}`);
  if (c.salary && c.salary !== "—") out.push(`Stated salary — ${c.salary}`);
  out.push(`Logistics — ${c.logistics.location || "—"}`);
  const interviews = (c.fireflies ?? []).filter((f) => f.transcript?.trim()).length;
  if (interviews) out.push(`${interviews} interview ${interviews === 1 ? "transcript" : "transcripts"}`);
  if (activityCount) out.push(`Activity log — ${activityCount} ${activityCount === 1 ? "entry" : "entries"}`);
  return out;
}

// ---------------------------------- component ----------------------------------

export function CandidateDossier({ wsApi, activeId, openPool }: Props) {
  const { findCandidate } = useTriageData();
  const ws = wsApi.ws;
  const id = activeId;
  const narrow = useIsNarrow();
  const candidate = findCandidate(activeId);

  const [chatDraft, setChatDraft] = useState("");
  const [actType, setActType] = useState<ActivityType>("note");
  const [actDraft, setActDraft] = useState("");

  useEffect(() => {
    setChatDraft("");
    setActDraft("");
    setActType("note");
    window.scrollTo(0, 0);
  }, [id]);

  if (!candidate) return null;
  const c = candidate;

  const decisionLabel = DECISION_LABEL[c.decision];
  const decisionC = decisionColor(c.decision);
  const isDq = !!ws.dq[id];
  const activity = ws.activity[id] ?? [];
  const chat = ws.chat[id] ?? [];
  const chatThinking = !!wsApi.chatBusy[id];
  const busy = !!wsApi.busy[id];
  const regenAt = ws.regen[id];

  const tl = wsApi.effTimeline(id).filter((r) => r.type === "role" || r.type === "edu");
  const steps = c.careerProgression?.steps ?? [];

  const chartPts = useMemo(() => {
    if (!c.careerProgression?.hasData) return [] as { label: string; y: number }[];
    return steps
      .map((s) => ({ label: s.company || s.role || "", y: stratumToNum(s.stratum) }))
      .filter((p): p is { label: string; y: number } => p.y != null);
  }, [c.careerProgression?.hasData, steps]);

  const downloadMd = async () => {
    try {
      const { content } = await getWorkingFileContent({ candidateId: id });
      const blob = new Blob([content], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${id}.md`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      /* best-effort */
    }
  };

  const sendChat = () => {
    const v = chatDraft.trim();
    if (!v || chatThinking) return;
    wsApi.sendChat(id, v);
    setChatDraft("");
  };

  const addActivity = () => {
    const v = actDraft.trim();
    if (!v) return;
    wsApi.logActivity(id, actType, v);
    setActDraft("");
  };

  const pullFireflies = () => {
    const t = (c.fireflies ?? []).find((f) => f.transcript?.trim());
    if (t) {
      setActType("interview");
      setActDraft(t.transcript.trim());
    }
  };

  const wrap: CSSProperties = { maxWidth: 880, margin: "0 auto", padding: narrow ? "16px 16px 110px" : "22px 28px 130px" };

  // dossier facts
  const facts: { k: string; v: React.ReactNode }[] = [
    { k: "Position", v: c.role },
    { k: "Company", v: c.company },
    { k: "Location", v: c.locationShort || c.logistics.location || "—" },
    { k: "Commute", v: c.logistics.read || c.logistics.likelihood || "—" },
    { k: "Experience", v: c.experience },
    { k: "Salary ask", v: c.salary },
    { k: "RO level", v: c.roLevel },
    { k: "Answers", v: <DotInline read={c.answersRead} /> },
    { k: "Vs. spec", v: <DotInline read={c.specRead} /> },
    { k: "Recommendation", v: <span style={{ color: decisionC, fontWeight: 600 }}>{decisionLabel}</span> },
  ];

  const reviewed = reviewedList(c, activity.length);

  // bio paragraphs
  const bio: string[] = [];
  if (c.careerRead?.path) bio.push(c.careerRead.path);
  else if (c.why) bio.push(c.why);
  if (c.careerRead?.positive) bio.push(c.careerRead.positive);
  tl.filter((r) => r.scope && r.scope !== "—")
    .slice(0, 5)
    .forEach((r) => bio.push(`${r.org}${r.period ? ` · ${r.period}` : ""}. ${r.scope}`));
  if (c.careerRead?.implication) bio.push(c.careerRead.implication);

  return (
    <div style={wrap}>
      {/* top row */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 22 }}>
        <button onClick={openPool} style={mono({ cursor: "pointer", background: "transparent", border: "none", padding: 0, fontSize: 13, color: APP.secondary })}>
          ← Pool
        </button>
        <a href={c.workableUrl} target="_blank" rel="noopener noreferrer" style={mono({ fontSize: 13, color: APP.accent, textDecoration: "none" })}>
          Open in Workable ↗
        </a>
        <span style={{ flex: 1 }} />
        <button
          onClick={() => wsApi.toggleDq(id)}
          style={{
            cursor: "pointer",
            background: "transparent",
            color: isDq ? APP.secondary : APP.weak,
            border: `1px solid ${isDq ? "#CFCFCF" : APP.weakBorder}`,
            borderRadius: 5,
            padding: "5px 12px",
            fontSize: 12.5,
            fontWeight: 500,
          }}
        >
          {isDq ? "Reinstate" : "Disqualify"}
        </button>
      </div>

      {/* header */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 6 }}>
        <div
          style={{
            width: 46,
            height: 46,
            borderRadius: 9999,
            background: c.avatarColor,
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: APP.mono,
            fontSize: 15,
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          {c.initials}
        </div>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", textDecoration: isDq ? "line-through" : "none" }}>{c.name}</h1>
          <div style={{ fontSize: 15, color: APP.secondary }}>
            {c.role} · {c.company}
          </div>
        </div>
      </div>

      {/* dossier facts */}
      <Section title="Dossier">
        <div style={{ display: "grid", gridTemplateColumns: narrow ? "1fr" : "1fr 1fr", gap: "0 40px" }}>
          {facts.map((f) => (
            <div key={f.k} style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "7px 0", borderBottom: `1px solid ${APP.line}` }}>
              <span style={mono({ fontSize: 12, color: APP.faint, textTransform: "uppercase", letterSpacing: "0.04em" })}>{f.k}</span>
              <span style={{ fontSize: 14, color: APP.ink, textAlign: "right" }}>{f.v}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* Claude assessment — pinned dark card */}
      <div style={{ margin: "26px 0", background: APP.ink, color: "#fff", borderRadius: 10, padding: narrow ? "18px 16px" : "22px 24px" }}>
        <div style={mono({ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(255,255,255,0.5)", marginBottom: 10 })}>
          Claude's assessment
        </div>
        <p style={{ margin: "0 0 14px", fontSize: 17, lineHeight: 1.5 }}>{c.why || "No assessment on file yet."}</p>
        <AssessRow label="Recommendation" value={decisionLabel} valueColor={c.decision === "interview" ? "#93b4ff" : c.decision === "cut" ? "#f0a89e" : "#fff"} />
        {c.flag && <AssessRow label="Main risk" value={c.flag} />}
        {c.next && <AssessRow label="Next" value={c.next} />}
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid rgba(255,255,255,0.12)" }}>
          <div style={mono({ fontSize: 11, color: "rgba(255,255,255,0.5)", marginBottom: 6 })}>Reviewed</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {reviewed.map((r) => (
              <span key={r} style={mono({ fontSize: 11.5, color: "rgba(255,255,255,0.82)", border: "1px solid rgba(255,255,255,0.18)", borderRadius: 4, padding: "3px 8px" })}>
                {r}
              </span>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 16, flexWrap: "wrap" }}>
          <span style={mono({ fontSize: 11, color: "rgba(255,255,255,0.45)" })}>
            Cached at ingest · saved to {id}.md{regenAt ? ` · updated ${regenAt}` : ""}
          </span>
          <span style={{ flex: 1 }} />
          <button onClick={downloadMd} style={mono({ cursor: "pointer", background: "transparent", color: "#fff", border: "1px solid rgba(255,255,255,0.28)", borderRadius: 5, padding: "5px 12px", fontSize: 12 })}>
            Download .md
          </button>
        </div>
      </div>

      {/* bio */}
      {bio.length > 0 && (
        <Section title="Who they are">
          {bio.map((p, i) => (
            <p key={i} style={{ margin: "0 0 12px", fontSize: 16, lineHeight: 1.6, color: APP.ink2 }}>
              {p}
            </p>
          ))}
        </Section>
      )}

      {/* what the application says */}
      <Section title="What the application says">
        {(c.careerRead?.positive || c.why) && (
          <p style={{ margin: "0 0 14px", fontSize: 16, lineHeight: 1.6, color: APP.ink2 }}>{c.careerRead?.positive || c.why}</p>
        )}
        <FactLine k="Target salary" v={`${c.salary}${c.askNote ? ` — ${c.askNote}` : ""}`} />
        <FactLine k="Answers" v={`${c.answersRead.label}${c.answers.length ? ` · graded from ${c.answers.length} ${c.answers.length === 1 ? "answer" : "answers"}` : ""}`} />
        <FactLine k="Cover letter" v={c.cover.hasLetter ? `On file — ${c.cover.lines.length} ${c.cover.lines.length === 1 ? "paragraph" : "paragraphs"}` : "None submitted"} />
        <FactLine k="Against the spec" v={c.specRead.label} />
        {c.rubricFit?.summary && (
          <p style={{ margin: "10px 0 0", fontSize: 14.5, lineHeight: 1.55, color: APP.secondary }}>{c.rubricFit.summary}</p>
        )}
        <FactLine k="Commute" v={`${c.logistics.location || "—"}${c.logistics.likelihood && c.logistics.likelihood !== "—" ? ` · likelihood ${c.logistics.likelihood}` : ""}`} />
      </Section>

      {/* the record */}
      {tl.length > 0 && (
        <Section title="The record">
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
              <thead>
                <tr style={mono({ fontSize: 10.5, letterSpacing: "0.04em", textTransform: "uppercase", color: APP.faint })}>
                  {["Years", "Org", "Role", "Tenure", "Biggest accomplishment", "RO"].map((h) => (
                    <th key={h} style={{ textAlign: "left", padding: "0 10px 7px 0", borderBottom: `1px solid ${APP.ink}`, fontWeight: 500 }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tl.map((r: TimelineRow, i) => (
                  <tr key={i} style={{ borderBottom: `1px solid ${APP.line}` }}>
                    <td style={cellMono}>{r.period || "—"}</td>
                    <td style={cell}>{r.org || "—"}</td>
                    <td style={cell}>{r.role || "—"}</td>
                    <td style={cellMono}>{r.tenure || "—"}</td>
                    <td style={{ ...cell, color: APP.secondary }}>{r.scope || "—"}</td>
                    <td style={cellMono}>{steps[i]?.stratum || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* level over time */}
      {chartPts.length >= 2 && (
        <Section title="Level over time">
          <LevelChart pts={chartPts} />
          {c.careerProgression?.trajectory && (
            <p style={mono({ margin: "10px 0 0", fontSize: 12.5, color: APP.muted })}>{c.careerProgression.trajectory}</p>
          )}
        </Section>
      )}

      {/* résumé + resync */}
      <Section
        title="Résumé"
        right={
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {c.resume.fileUrl && (
              <a href={c.resume.fileUrl} target="_blank" rel="noopener noreferrer" style={mono({ fontSize: 12, color: APP.accent, textDecoration: "none" })}>
                Download ↗
              </a>
            )}
            <button
              onClick={() => wsApi.resync(id)}
              disabled={busy}
              style={mono({ cursor: busy ? "default" : "pointer", background: "transparent", color: busy ? APP.muted : APP.secondary, border: `1px solid ${APP.hair}`, borderRadius: 5, padding: "4px 11px", fontSize: 12 })}
            >
              {busy ? "Syncing…" : "Resync from Workable"}
            </button>
          </div>
        }
      >
        {c.resume.hasResume && c.resume.roles.length > 0 ? (
          c.resume.roles.map((role, i) => (
            <div key={i} style={{ padding: "10px 0", borderBottom: `1px solid ${APP.line}` }}>
              <div style={{ fontSize: 14.5, fontWeight: 600 }}>
                {role.title} <span style={{ color: APP.muted, fontWeight: 400 }}>— {role.company}</span>
              </div>
              <div style={mono({ fontSize: 12, color: APP.faint, margin: "2px 0 6px" })}>
                {role.period}
                {role.current ? " · current" : ""}
              </div>
              {role.bullets.slice(0, 6).map((b, j) => (
                <div key={j} style={{ fontSize: 14, color: APP.ink2, lineHeight: 1.5, paddingLeft: 14, position: "relative" }}>
                  <span style={{ position: "absolute", left: 0, color: APP.muted }}>·</span>
                  {b}
                </div>
              ))}
            </div>
          ))
        ) : c.resume.hasResume && c.resume.fullText ? (
          <pre style={{ whiteSpace: "pre-wrap", fontFamily: APP.sans, fontSize: 14, lineHeight: 1.55, color: APP.ink2, margin: 0 }}>{c.resume.fullText.slice(0, 4000)}</pre>
        ) : (
          <p style={{ margin: 0, fontSize: 14, color: APP.muted }}>No résumé captured yet. Resync from Workable to pull it in.</p>
        )}
      </Section>

      {/* cover letter */}
      {c.cover.hasLetter && (
        <Section title="Cover letter">
          {c.cover.lines.map((ln, i) => (
            <p key={i} style={{ margin: "0 0 10px", fontSize: 15.5, lineHeight: 1.6, color: APP.ink2 }}>
              {ln.t}
            </p>
          ))}
        </Section>
      )}

      {/* application answers */}
      {c.answers.length > 0 && (
        <Section title="Application answers">
          {c.answers.map((a, i) => (
            <div key={i} style={{ padding: "12px 0", borderBottom: `1px solid ${APP.line}` }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: APP.ink }}>{a.q || "Application question"}</div>
              <p style={{ margin: "5px 0 0", fontSize: 15, lineHeight: 1.55, color: APP.ink2 }}>{a.a}</p>
              {a.comment && (
                <div style={mono({ marginTop: 7, fontSize: 12.5, color: APP.secondary, borderLeft: `2px solid ${APP.accentBorder}`, paddingLeft: 10 })}>
                  Claude: {a.comment}
                </div>
              )}
            </div>
          ))}
        </Section>
      )}

      {/* activity log */}
      <Section title={`Activity log${activity.length ? ` · ${activity.length}` : ""}`}>
        {activity.length > 0 ? (
          <div style={{ marginBottom: 16 }}>
            {activity.map((e) => (
              <div key={e.id} style={{ display: "flex", gap: 12, padding: "10px 0", borderBottom: `1px solid ${APP.line}` }}>
                <span style={mono({ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.04em", color: APP.accent, width: 70, flexShrink: 0, paddingTop: 2 })}>{e.type}</span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 14.5, color: APP.ink2, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{e.body}</div>
                  <div style={mono({ fontSize: 11, color: APP.faint, marginTop: 3 })}>
                    {e.author} · {e.at.slice(0, 16).replace("T", " ")}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p style={{ margin: "0 0 14px", fontSize: 14, color: APP.muted }}>No activity logged yet. Record interviews, notes, and comments here — Claude reads this on Update assessment.</p>
        )}
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          {(["note", "interview", "comment"] as ActivityType[]).map((t) => (
            <button
              key={t}
              onClick={() => setActType(t)}
              style={mono({
                cursor: "pointer",
                background: actType === t ? APP.ink : "transparent",
                color: actType === t ? "#fff" : APP.secondary,
                border: `1px solid ${actType === t ? APP.ink : APP.hair}`,
                borderRadius: 5,
                padding: "4px 11px",
                fontSize: 12,
                textTransform: "capitalize",
              })}
            >
              {t}
            </button>
          ))}
          <span style={{ flex: 1 }} />
          {actType === "interview" && (c.fireflies ?? []).some((f) => f.transcript?.trim()) && (
            <button onClick={pullFireflies} style={mono({ cursor: "pointer", background: "transparent", color: APP.accent, border: `1px solid ${APP.accentBorder}`, borderRadius: 5, padding: "4px 11px", fontSize: 12 })}>
              Pull from Fireflies
            </button>
          )}
        </div>
        <textarea
          value={actDraft}
          onChange={(e) => setActDraft(e.target.value)}
          placeholder={actType === "interview" ? "Paste the interview transcript or notes…" : actType === "comment" ? "A comment for the record…" : "A note for the record…"}
          rows={actType === "interview" ? 5 : 3}
          style={textareaStyle}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
          <button onClick={addActivity} disabled={!actDraft.trim()} style={primaryBtn(!actDraft.trim())}>
            Log {actType}
          </button>
        </div>
      </Section>

      {/* war room */}
      <Section
        title="War room"
        right={
          chat.length > 0 ? (
            <button onClick={() => wsApi.clearChat(id)} style={mono({ cursor: "pointer", background: "transparent", border: "none", fontSize: 12, color: APP.muted })}>
              Clear
            </button>
          ) : undefined
        }
      >
        <p style={{ margin: "0 0 14px", fontSize: 13.5, lineHeight: 1.5, color: APP.muted }}>
          Ask Claude about this candidate — it reads the cached assessment, activity log, résumé, and spec. Chat is reasoning only; use <strong style={{ color: APP.secondary }}>Update assessment</strong> to re-run the evaluator and re-persist the read.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 14 }}>
          {chat.map((m, i) => {
            const isLastAssistant = m.role === "assistant" && i === chat.length - 1;
            return (
              <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: m.role === "user" ? "flex-end" : "flex-start" }}>
                <div
                  style={{
                    maxWidth: "86%",
                    background: m.role === "user" ? APP.accentSoft : APP.line2,
                    border: `1px solid ${m.role === "user" ? APP.accentBorder : APP.hair2}`,
                    borderRadius: 10,
                    padding: "10px 13px",
                    fontSize: 14.5,
                    lineHeight: 1.55,
                    color: APP.ink2,
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {m.content}
                </div>
                {isLastAssistant && (
                  <button
                    onClick={() => wsApi.updateAssessment(id)}
                    disabled={busy}
                    style={mono({ marginTop: 6, cursor: busy ? "default" : "pointer", background: "transparent", color: busy ? APP.muted : APP.accent, border: "none", padding: 0, fontSize: 12.5 })}
                  >
                    {busy ? "Updating assessment…" : "Update assessment →"}
                  </button>
                )}
              </div>
            );
          })}
          {chatThinking && <div style={mono({ fontSize: 12.5, color: APP.muted })}>Claude is thinking…</div>}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <textarea
            value={chatDraft}
            onChange={(e) => setChatDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                sendChat();
              }
            }}
            placeholder="Ask about this candidate…  (⌘↵ to send)"
            rows={2}
            style={{ ...textareaStyle, flex: 1 }}
          />
          <button onClick={sendChat} disabled={!chatDraft.trim() || chatThinking} style={{ ...primaryBtn(!chatDraft.trim() || chatThinking), alignSelf: "flex-end" }}>
            Send
          </button>
        </div>
        <button
          onClick={() => wsApi.updateAssessment(id)}
          disabled={busy}
          style={mono({ marginTop: 12, cursor: busy ? "default" : "pointer", background: "transparent", color: busy ? APP.muted : APP.secondary, border: `1px solid ${APP.hair}`, borderRadius: 5, padding: "6px 12px", fontSize: 12.5 })}
        >
          {busy ? "Regenerating…" : "Regenerate assessment manually"}
        </button>
      </Section>

    </div>
  );
}

// ---------------------------------- subcomponents ----------------------------------

const cell: CSSProperties = { padding: "8px 10px 8px 0", fontSize: 13.5, color: APP.ink, verticalAlign: "top" };
const cellMono: CSSProperties = { ...cell, fontFamily: APP.mono, fontSize: 12.5, whiteSpace: "nowrap" };

const textareaStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  border: `1px solid ${APP.hair}`,
  borderRadius: 7,
  padding: "10px 12px",
  fontFamily: APP.sans,
  fontSize: 14.5,
  lineHeight: 1.5,
  color: APP.ink,
  resize: "vertical",
  outline: "none",
};

function primaryBtn(disabled: boolean): CSSProperties {
  return {
    cursor: disabled ? "default" : "pointer",
    background: disabled ? APP.hair : APP.accent,
    color: disabled ? APP.muted : "#fff",
    border: "none",
    borderRadius: 6,
    padding: "8px 16px",
    fontSize: 13.5,
    fontWeight: 500,
  };
}

function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 26 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12, borderBottom: `1px solid ${APP.hair2}`, paddingBottom: 7 }}>
        <h2 style={mono({ margin: 0, fontSize: 12, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: APP.ink })}>{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function AssessRow({ label, value, valueColor = "#fff" }: { label: string; value: string; valueColor?: string }) {
  return (
    <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
      <span style={mono({ fontSize: 11.5, color: "rgba(255,255,255,0.5)", width: 110, flexShrink: 0, paddingTop: 2 })}>{label}</span>
      <span style={{ fontSize: 14.5, lineHeight: 1.5, color: valueColor }}>{value}</span>
    </div>
  );
}

function DotInline({ read }: { read: VerdictRead }) {
  const d = verdictDot(read.level);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
      <span style={{ width: 8, height: 8, borderRadius: 9999, background: d.fill, border: `1.5px solid ${d.color}` }} />
      <span style={{ color: d.color }}>{read.label}</span>
    </span>
  );
}

function FactLine({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", gap: 16, padding: "7px 0", borderBottom: `1px solid ${APP.line}` }}>
      <span style={mono({ fontSize: 12, color: APP.faint, textTransform: "uppercase", letterSpacing: "0.04em", width: 150, flexShrink: 0 })}>{k}</span>
      <span style={{ fontSize: 14.5, color: APP.ink2, lineHeight: 1.5 }}>{v}</span>
    </div>
  );
}

function LevelChart({ pts }: { pts: { label: string; y: number }[] }) {
  const W = 640;
  const H = 150;
  const padX = 30;
  const padY = 22;
  const ys = pts.map((p) => p.y);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys, minY + 1);
  const stepX = pts.length > 1 ? (W - padX * 2) / (pts.length - 1) : 0;
  const xy = (i: number, y: number) => {
    const x = padX + i * stepX;
    const yy = H - padY - ((y - minY) / (maxY - minY)) * (H - padY * 2);
    return { x, y: yy };
  };
  const path = pts.map((p, i) => { const { x, y } = xy(i, p.y); return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`; }).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="RO capability over time">
      <path d={path} fill="none" stroke={APP.accent} strokeWidth={2} />
      {pts.map((p, i) => {
        const { x, y } = xy(i, p.y);
        return (
          <g key={i}>
            <circle cx={x} cy={y} r={3.5} fill={APP.accent} />
            <text x={x} y={H - 5} textAnchor="middle" fontSize={9} fontFamily={APP.mono} fill={APP.faint}>
              {p.label.length > 10 ? p.label.slice(0, 9) + "…" : p.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
