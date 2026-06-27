"use client";

import { useRef, useState, useTransition } from "react";
import {
  addContactAction,
  createSearchAction,
  importCsvAction,
  saveScorecardAction,
  updateSearchAction,
} from "@/app/actions/radar";
import { EMPTY_CRITERIA, type Pipeline, type RadarSearch, type SearchCriteria } from "@/lib/radar/types";

function splitList(v: string): string[] {
  return v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontSize: 17 }}>{title}</h2>
          <button style={iconBtn} onClick={onClose} aria-label="Close">✕</button>
        </header>
        {children}
      </div>
    </div>
  );
}

export function NewSearchModal({
  pipeline,
  search,
  onClose,
  onDone,
}: {
  pipeline: Pipeline;
  search?: RadarSearch | null;
  onClose: () => void;
  onDone: (id: string) => void;
}) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [title, setTitle] = useState(search?.title ?? "");
  const [c, setC] = useState<SearchCriteria>(search?.criteria ?? { ...EMPTY_CRITERIA });
  const isEdit = Boolean(search);

  function submit() {
    setErr(null);
    if (!title.trim()) { setErr("Give the search a name."); return; }
    start(async () => {
      const res = search
        ? await updateSearchAction({ id: search.id, title: title.trim(), pipeline, criteria: c })
        : await createSearchAction({ title: title.trim(), pipeline, criteria: c });
      if (!res.ok || !res.searchId) { setErr(res.error ?? "Failed"); return; }
      onDone(res.searchId);
    });
  }

  const field = (label: string, key: keyof SearchCriteria, placeholder: string) => (
    <label style={fieldWrap}>
      <span style={fieldLabel}>{label}</span>
      <textarea
        placeholder={placeholder}
        rows={2}
        defaultValue={(c[key] as string[]).join(", ")}
        onChange={(e) => setC((p) => ({ ...p, [key]: splitList(e.target.value) }))}
        style={textarea}
      />
    </label>
  );

  return (
    <Modal title={`${isEdit ? "Edit" : "New"} ${pipeline === "bd" ? "BD" : "recruiting"} search`} onClose={onClose}>
      <label style={fieldWrap}>
        <span style={fieldLabel}>Search name</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Clinical Ops Lead — IVD, LA" style={input} />
      </label>
      {field("Target titles", "titles", "Clinical Operations Lead, Study Manager, CTM")}
      {field("Keywords", "keywords", "site activation, monitoring, IVD, assay validation")}
      {field("Target companies", "companies", "small CROs, diagnostics sponsors")}
      {field("Locations", "locations", "Los Angeles, Greater LA, California")}
      {field("Must-have terms", "mustHave", "clinical operations, GCP")}
      {field("Exclude terms", "exclude", "recruiter, intern, student")}
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, margin: "6px 0 14px" }}>
        <input type="checkbox" defaultChecked={c.relocationAllowed} onChange={(e) => setC((p) => ({ ...p, relocationAllowed: e.target.checked }))} />
        Relocation allowed
      </label>
      {err && <p style={errText}>{err}</p>}
      <div style={actions}>
        <button style={ghostBtn} onClick={onClose}>Cancel</button>
        <button style={primaryBtn} disabled={pending} onClick={submit}>{pending ? "Saving..." : isEdit ? "Save search" : "Create search"}</button>
      </div>
    </Modal>
  );
}

export function ImportModal({ pipeline, searchId, onClose, onDone }: { pipeline: Pipeline; searchId: string | null; onClose: () => void; onDone: (msg: string) => void }) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [source, setSource] = useState("CSV: Sales Navigator");
  const fileRef = useRef<HTMLInputElement>(null);

  function submit() {
    setErr(null);
    const file = fileRef.current?.files?.[0];
    if (!file) { setErr("Choose a CSV file."); return; }
    start(async () => {
      const text = await file.text();
      const res = await importCsvAction({ pipeline, searchId, filename: file.name, source, csv: text });
      if (!res.ok) { setErr(res.error ?? "Import failed"); return; }
      onDone(`Imported ${res.inserted} new, ${res.duplicates} merged (of ${res.total} rows).`);
    });
  }

  return (
    <Modal title="Import CSV" onClose={onClose}>
      <p style={{ fontSize: 13, color: "rgba(22,35,53,0.65)", marginTop: 0 }}>
        Upload an exported list (LinkedIn Sales Navigator, a recruiter list, Clay, or your own). We auto-map common
        columns (name, title, company, location, LinkedIn, email, phone). We never scrape — only ingest what you provide.
      </p>
      <label style={fieldWrap}>
        <span style={fieldLabel}>Source label (provenance)</span>
        <input value={source} onChange={(e) => setSource(e.target.value)} style={input} />
      </label>
      <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ fontSize: 13, margin: "6px 0 14px" }} />
      {err && <p style={errText}>{err}</p>}
      <div style={actions}>
        <button style={ghostBtn} onClick={onClose}>Cancel</button>
        <button style={primaryBtn} disabled={pending} onClick={submit}>{pending ? "Importing…" : "Import"}</button>
      </div>
    </Modal>
  );
}

export function AddContactModal({ pipeline, searchId, onClose, onDone }: { pipeline: Pipeline; searchId: string | null; onClose: () => void; onDone: () => void }) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useState({ fullName: "", title: "", company: "", location: "", linkedinUrl: "", email: "", phone: "", profileSummary: "" });
  const upd = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF((p) => ({ ...p, [k]: e.target.value }));

  function submit() {
    setErr(null);
    if (!f.fullName.trim() && !f.email.trim() && !f.linkedinUrl.trim()) { setErr("Add at least a name, email, or LinkedIn URL."); return; }
    start(async () => {
      const res = await addContactAction({ pipeline, searchId, contact: { ...f, source: "Manual" } });
      if (!res.ok) { setErr(res.error ?? "Failed"); return; }
      onDone();
    });
  }

  const row = (label: string, key: keyof typeof f, placeholder = "") => (
    <label style={fieldWrap}>
      <span style={fieldLabel}>{label}</span>
      <input value={f[key]} onChange={upd(key)} placeholder={placeholder} style={input} />
    </label>
  );

  return (
    <Modal title="Add a contact" onClose={onClose}>
      {row("Name", "fullName")}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {row("Title", "title")}
        {row("Company", "company")}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {row("Location", "location")}
        {row("Phone", "phone")}
      </div>
      {row("Email", "email")}
      {row("LinkedIn URL", "linkedinUrl")}
      <label style={fieldWrap}>
        <span style={fieldLabel}>Profile summary / notes</span>
        <textarea value={f.profileSummary} onChange={upd("profileSummary")} rows={3} style={textarea} />
      </label>
      {err && <p style={errText}>{err}</p>}
      <div style={actions}>
        <button style={ghostBtn} onClick={onClose}>Cancel</button>
        <button style={primaryBtn} disabled={pending} onClick={submit}>{pending ? "Adding…" : "Add contact"}</button>
      </div>
    </Modal>
  );
}

export function ScorecardModal({ pipeline, name, content, onClose, onDone }: { pipeline: Pipeline; name: string; content: string; onClose: () => void; onDone: () => void }) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [n, setN] = useState(name);
  const [md, setMd] = useState(content);

  function submit() {
    setErr(null);
    start(async () => {
      const res = await saveScorecardAction({ pipeline, name: n.trim() || name, content: md });
      if (!res.ok) { setErr(res.error ?? "Failed"); return; }
      onDone();
    });
  }

  return (
    <Modal title="Edit scorecard" onClose={onClose}>
      <label style={fieldWrap}>
        <span style={fieldLabel}>Name</span>
        <input value={n} onChange={(e) => setN(e.target.value)} style={input} />
      </label>
      <label style={fieldWrap}>
        <span style={fieldLabel}>Scorecard (markdown — the LLM grades against this)</span>
        <textarea value={md} onChange={(e) => setMd(e.target.value)} rows={16} style={{ ...textarea, fontFamily: "var(--font-mono, monospace)", fontSize: 12.5 }} />
      </label>
      {err && <p style={errText}>{err}</p>}
      <div style={actions}>
        <button style={ghostBtn} onClick={onClose}>Cancel</button>
        <button style={primaryBtn} disabled={pending} onClick={submit}>{pending ? "Saving…" : "Save scorecard"}</button>
      </div>
    </Modal>
  );
}

const overlay: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(22,35,53,0.4)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "6vh 16px", zIndex: 60, overflowY: "auto" };
const modal: React.CSSProperties = { width: "min(620px, 100%)", background: "#fff", borderRadius: 16, padding: 24, boxShadow: "0 24px 60px rgba(22,35,53,0.25)" };
const iconBtn: React.CSSProperties = { border: "none", background: "transparent", fontSize: 16, cursor: "pointer", color: "rgba(22,35,53,0.6)" };
const fieldWrap: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, marginBottom: 12 };
const fieldLabel: React.CSSProperties = { fontSize: 12, color: "rgba(22,35,53,0.6)", fontWeight: 500 };
const input: React.CSSProperties = { border: "1px solid rgba(22,35,53,0.2)", borderRadius: 8, padding: "8px 10px", fontSize: 13.5, width: "100%" };
const textarea: React.CSSProperties = { border: "1px solid rgba(22,35,53,0.2)", borderRadius: 8, padding: "8px 10px", fontSize: 13.5, width: "100%", resize: "vertical", lineHeight: 1.5 };
const actions: React.CSSProperties = { display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 6 };
const primaryBtn: React.CSSProperties = { background: "#162335", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" };
const ghostBtn: React.CSSProperties = { background: "transparent", color: "#162335", border: "1px solid rgba(22,35,53,0.2)", borderRadius: 8, padding: "8px 16px", fontSize: 13, cursor: "pointer" };
const errText: React.CSSProperties = { color: "#9E3B28", fontSize: 13, margin: "0 0 10px" };
