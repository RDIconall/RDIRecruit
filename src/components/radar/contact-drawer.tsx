"use client";

import { useState, useTransition } from "react";
import {
  draftOutreachAction,
  logManualOutreachAction,
  optOutAction,
  scoreContactAction,
  updateContactAction,
  updateOutreachAction,
} from "@/app/actions/radar";
import {
  OUTREACH_STATUS_LABEL,
  type ConsentStatus,
  type OutreachStatus,
  type Pipeline,
  type RadarContact,
} from "@/lib/radar/types";
import { initials, outreachMeta, recMeta, scoreColor } from "./ui";

const STATUSES: OutreachStatus[] = [
  "not_started",
  "drafted",
  "sent",
  "replied",
  "no_response",
  "bounced",
  "meeting",
  "opted_out",
];
const CONSENTS: ConsentStatus[] = ["unknown", "implied", "explicit", "withdrawn"];

export function ContactDrawer({
  contact,
  pipeline,
  hasLlm,
  onClose,
  onRefresh,
}: {
  contact: RadarContact;
  pipeline: Pipeline;
  hasLlm: boolean;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ subject: string; body: string; linkedin: string } | null>(null);
  const score = contact.score;
  const latest = contact.outreach?.[0];

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setErr(null);
    start(async () => {
      const res = await fn();
      if (!res.ok) setErr(res.error ?? "Something went wrong");
      else onRefresh();
    });
  };

  function doDraft() {
    setErr(null);
    start(async () => {
      const res = await draftOutreachAction({ contactId: contact.id, pipeline });
      if (!res.ok) { setErr(res.error ?? "Draft failed"); return; }
      setDraft({ subject: res.emailSubject ?? "", body: res.emailBody ?? "", linkedin: res.linkedinMessage ?? "" });
      onRefresh();
    });
  }

  return (
    <div style={overlay} onClick={onClose}>
      <aside style={panel} onClick={(e) => e.stopPropagation()}>
        <header style={head}>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <div style={avatar}>{initials(contact.fullName)}</div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 18 }}>{contact.fullName ?? "Unnamed contact"}</div>
              <div style={{ fontSize: 13, color: "rgba(22,35,53,0.6)" }}>
                {[contact.title, contact.company].filter(Boolean).join(" · ") || "—"}
              </div>
            </div>
          </div>
          <button style={iconBtn} onClick={onClose} aria-label="Close">✕</button>
        </header>

        <div style={body}>
          {contact.optOut && (
            <div style={{ ...callout, borderColor: "rgba(158,59,40,0.3)", background: "rgba(158,59,40,0.06)" }}>
              <strong>Opted out.</strong> {contact.optOutReason || "This person has opted out of outreach."}
            </div>
          )}

          {/* Identity / contact fields */}
          <Section title="Contact">
            <Field label="Location" value={contact.location} />
            <Field label="Email" value={contact.email} extra={contact.emailStatus !== "unknown" ? contact.emailStatus : undefined} />
            <Field label="Phone" value={contact.phone} />
            <Field label="LinkedIn" value={contact.linkedinUrl} link />
            <Field label="Source" value={contact.source} />
            <Field label="Pipelines" value={contact.pipeline.join(", ")} />
            {contact.profileSummary && (
              <p style={{ margin: "8px 0 0", fontSize: 13, lineHeight: 1.5, color: "rgba(22,35,53,0.75)" }}>
                {contact.profileSummary}
              </p>
            )}
          </Section>

          {/* Ownership + consent */}
          <Section title="Ownership & consent">
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <input
                defaultValue={contact.owner ?? ""}
                placeholder="Owner (recruiter / BD)"
                onBlur={(e) => {
                  const v = e.target.value.trim() || null;
                  if (v !== (contact.owner ?? null)) run(() => updateContactAction({ contactId: contact.id, owner: v }));
                }}
                style={input}
              />
              <select
                defaultValue={contact.consentStatus}
                onChange={(e) => run(() => updateContactAction({ contactId: contact.id, consentStatus: e.target.value as ConsentStatus }))}
                style={select}
              >
                {CONSENTS.map((c) => <option key={c} value={c}>Consent: {c}</option>)}
              </select>
              {!contact.optOut && (
                <button
                  style={ghostBtn}
                  disabled={pending}
                  onClick={() => {
                    const reason = window.prompt("Opt-out reason (optional)") ?? "";
                    run(() => optOutAction({ contactId: contact.id, reason }));
                  }}
                >
                  Mark opted out
                </button>
              )}
            </div>
          </Section>

          {/* Score */}
          <Section
            title="Scorecard read"
            action={
              <button style={primaryBtn} disabled={pending || !hasLlm} onClick={() => run(() => scoreContactAction({ contactId: contact.id, pipeline }))}>
                {score ? "Re-score" : "Score"}
              </button>
            }
          >
            {!hasLlm && <p style={muted}>Scoring needs ANTHROPIC_API_KEY.</p>}
            {score ? (
              <>
                <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
                  <div style={{ fontSize: 28, fontWeight: 700, color: scoreColor(score.overall), fontVariantNumeric: "tabular-nums" }}>
                    {score.overall != null ? score.overall.toFixed(1) : "—"}
                  </div>
                  {score.recommendation && <Pill meta={recMeta(score.recommendation)} />}
                </div>
                {score.summary && <p style={{ margin: "0 0 10px", fontSize: 13.5, lineHeight: 1.55 }}>{score.summary}</p>}
                <KeyVal k="Strongest signal" v={score.strongestSignal} />
                <KeyVal k="Biggest concern" v={score.biggestConcern} />
                <KeyVal k="Next action" v={score.nextAction} accent />
                <div style={{ marginTop: 12, display: "grid", gap: 6 }}>
                  {score.dimensions.map((d) => (
                    <div key={d.key} title={d.rationale}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 2 }}>
                        <span style={{ color: d.isRisk ? "#9E3B28" : "rgba(22,35,53,0.7)" }}>
                          {d.label}{d.isRisk ? " (risk)" : ""}
                        </span>
                        <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{d.score}/5</span>
                      </div>
                      <div style={barTrack}>
                        <div style={{ ...barFill, width: `${(d.score / 5) * 100}%`, background: d.isRisk ? "#9E3B28" : "#162335" }} />
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p style={muted}>Not scored yet.</p>
            )}
          </Section>

          {/* Outreach */}
          <Section
            title="Outreach"
            action={
              <button style={primaryBtn} disabled={pending || !hasLlm || contact.optOut} onClick={doDraft}>
                Draft email + LinkedIn
              </button>
            }
          >
            {!hasLlm && <p style={muted}>Drafting needs ANTHROPIC_API_KEY.</p>}
            {draft && (
              <div style={{ marginBottom: 14 }}>
                <DraftBlock label="Email subject" text={draft.subject} />
                <DraftBlock label="Email body" text={draft.body} multiline />
                <DraftBlock label="LinkedIn message" text={draft.linkedin} multiline />
                <p style={{ ...muted, marginTop: 4 }}>Saved as a draft. Copy into your sender; mark Sent below once it goes out.</p>
              </div>
            )}

            {contact.outreach && contact.outreach.length > 0 ? (
              <div style={{ display: "grid", gap: 10 }}>
                {contact.outreach.map((o) => (
                  <div key={o.id} style={outreachCard}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.4, color: "rgba(22,35,53,0.55)" }}>
                        {o.channel}
                      </span>
                      <Pill meta={outreachMeta(o.status)} small />
                    </div>
                    {o.subject && <div style={{ fontWeight: 600, fontSize: 13, marginTop: 4 }}>{o.subject}</div>}
                    {o.body && <pre style={pre}>{o.body}</pre>}
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8, alignItems: "center" }}>
                      <select defaultValue={o.status} onChange={(e) => run(() => updateOutreachAction({ outreachId: o.id, status: e.target.value as OutreachStatus }))} style={select}>
                        {STATUSES.map((s) => <option key={s} value={s}>{OUTREACH_STATUS_LABEL[s]}</option>)}
                      </select>
                      <label style={dateLabel}>Last
                        <input type="date" defaultValue={o.lastContactDate ?? ""} onChange={(e) => run(() => updateOutreachAction({ outreachId: o.id, lastContactDate: e.target.value || null }))} style={dateInput} />
                      </label>
                      <label style={dateLabel}>Follow-up
                        <input type="date" defaultValue={o.nextFollowUpDate ?? ""} onChange={(e) => run(() => updateOutreachAction({ outreachId: o.id, nextFollowUpDate: e.target.value || null }))} style={dateInput} />
                      </label>
                    </div>
                    <input
                      defaultValue={o.response ?? ""}
                      placeholder="Response / notes"
                      onBlur={(e) => { const v = e.target.value.trim() || null; if (v !== (o.response ?? null)) run(() => updateOutreachAction({ outreachId: o.id, response: v })); }}
                      style={{ ...input, width: "100%", marginTop: 8 }}
                    />
                  </div>
                ))}
              </div>
            ) : (
              !draft && <p style={muted}>No outreach yet.</p>
            )}

            {!contact.optOut && (
              <button
                style={{ ...ghostBtn, marginTop: 10 }}
                disabled={pending}
                onClick={() => run(() => logManualOutreachAction({ contactId: contact.id, pipeline, channel: "linkedin", status: "sent" }))}
              >
                + Log a manual touch
              </button>
            )}
          </Section>

          {err && <div style={{ ...callout, borderColor: "rgba(158,59,40,0.3)", background: "rgba(158,59,40,0.06)" }}>{err}</div>}
        </div>
      </aside>
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section style={{ borderTop: "1px solid rgba(22,35,53,0.08)", padding: "16px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.6, color: "rgba(22,35,53,0.5)" }}>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Field({ label, value, extra, link }: { label: string; value: string | null; extra?: string; link?: boolean }) {
  if (!value) return null;
  return (
    <div style={{ display: "flex", gap: 8, fontSize: 13, padding: "2px 0" }}>
      <span style={{ width: 90, color: "rgba(22,35,53,0.5)", flexShrink: 0 }}>{label}</span>
      {link ? (
        <a href={value.startsWith("http") ? value : `https://${value}`} target="_blank" rel="noreferrer" style={{ color: "#E74424", wordBreak: "break-all" }}>{value}</a>
      ) : (
        <span style={{ wordBreak: "break-word" }}>{value}{extra ? <em style={{ color: "rgba(22,35,53,0.5)", fontStyle: "normal" }}> · {extra}</em> : null}</span>
      )}
    </div>
  );
}

function KeyVal({ k, v, accent }: { k: string; v: string | null; accent?: boolean }) {
  if (!v) return null;
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, color: "rgba(22,35,53,0.45)" }}>{k}</div>
      <div style={{ fontSize: 13, lineHeight: 1.5, color: accent ? "#E74424" : "#162335", fontWeight: accent ? 600 : 400 }}>{v}</div>
    </div>
  );
}

function Pill({ meta, small }: { meta: { c: string; bg: string; b: string; label: string }; small?: boolean }) {
  return (
    <span style={{ color: meta.c, background: meta.bg, border: `1px solid ${meta.b}`, borderRadius: 999, padding: small ? "2px 8px" : "3px 10px", fontSize: small ? 11 : 12, fontWeight: 600, whiteSpace: "nowrap" }}>
      {meta.label}
    </span>
  );
}

function DraftBlock({ label, text, multiline }: { label: string; text: string; multiline?: boolean }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, color: "rgba(22,35,53,0.45)" }}>{label}</span>
        <button style={copyBtn} onClick={() => navigator.clipboard?.writeText(text)}>Copy</button>
      </div>
      {multiline ? <pre style={pre}>{text}</pre> : <div style={{ fontSize: 13, fontWeight: 600 }}>{text}</div>}
    </div>
  );
}

const overlay: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(22,35,53,0.35)", display: "flex", justifyContent: "flex-end", zIndex: 50 };
const panel: React.CSSProperties = { width: "min(560px, 100%)", height: "100%", background: "#fff", boxShadow: "-12px 0 40px rgba(22,35,53,0.18)", display: "flex", flexDirection: "column" };
const head: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 22px", borderBottom: "1px solid rgba(22,35,53,0.08)" };
const body: React.CSSProperties = { padding: "0 22px 40px", overflowY: "auto" };
const avatar: React.CSSProperties = { width: 40, height: 40, borderRadius: 10, background: "#162335", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 600, fontSize: 14 };
const iconBtn: React.CSSProperties = { border: "none", background: "transparent", fontSize: 16, cursor: "pointer", color: "rgba(22,35,53,0.6)" };
const primaryBtn: React.CSSProperties = { background: "#162335", color: "#fff", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 12.5, fontWeight: 600, cursor: "pointer" };
const ghostBtn: React.CSSProperties = { background: "transparent", color: "#162335", border: "1px solid rgba(22,35,53,0.2)", borderRadius: 8, padding: "6px 12px", fontSize: 12.5, cursor: "pointer" };
const copyBtn: React.CSSProperties = { ...ghostBtn, padding: "2px 8px", fontSize: 11 };
const input: React.CSSProperties = { border: "1px solid rgba(22,35,53,0.2)", borderRadius: 8, padding: "6px 10px", fontSize: 13, minWidth: 160 };
const select: React.CSSProperties = { border: "1px solid rgba(22,35,53,0.2)", borderRadius: 8, padding: "6px 10px", fontSize: 12.5, background: "#fff" };
const muted: React.CSSProperties = { fontSize: 12.5, color: "rgba(22,35,53,0.5)", margin: 0 };
const callout: React.CSSProperties = { border: "1px solid", borderRadius: 10, padding: "10px 12px", fontSize: 13, margin: "14px 0" };
const barTrack: React.CSSProperties = { height: 6, background: "rgba(22,35,53,0.08)", borderRadius: 4, overflow: "hidden" };
const barFill: React.CSSProperties = { height: "100%", borderRadius: 4 };
const outreachCard: React.CSSProperties = { border: "1px solid rgba(22,35,53,0.1)", borderRadius: 10, padding: 12 };
const pre: React.CSSProperties = { whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: 12.5, lineHeight: 1.5, margin: "6px 0 0", color: "rgba(22,35,53,0.85)" };
const dateLabel: React.CSSProperties = { fontSize: 11, color: "rgba(22,35,53,0.5)", display: "flex", flexDirection: "column", gap: 2 };
const dateInput: React.CSSProperties = { border: "1px solid rgba(22,35,53,0.2)", borderRadius: 6, padding: "3px 6px", fontSize: 12 };
