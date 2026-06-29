"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { runEnrichmentAction, scoreAllAction } from "@/app/actions/radar";
import type { RadarData } from "@/lib/radar/load";
import { PIPELINES, type Pipeline, type RadarContact } from "@/lib/radar/types";
import { ContactDrawer } from "./contact-drawer";
import { AddContactModal, AiSourcingModal, ImportModal, NewSearchModal, ScorecardModal } from "./forms";
import { initials, outreachMeta, recMeta, scoreColor } from "./ui";

type SortKey = "score" | "name" | "outreach";

export function RadarApp({ data, viewer }: { data: RadarData; viewer: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [selected, setSelected] = useState<RadarContact | null>(null);
  const [modal, setModal] = useState<null | "search" | "editSearch" | "aiSearch" | "import" | "add" | "scorecard">(null);
  const [toast, setToast] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("score");

  const activeSearch = data.searches.find((s) => s.id === data.searchId) || null;

  // Re-fetch server data; the open drawer re-syncs via `liveSelected` below.
  const refresh = () => router.refresh();

  function go(params: { pipeline?: Pipeline; search?: string | null }) {
    const sp = new URLSearchParams();
    sp.set("pipeline", params.pipeline ?? data.pipeline);
    const search = params.search === undefined ? data.searchId : params.search;
    if (search) sp.set("search", search);
    router.push(`/radar?${sp.toString()}`);
  }

  const flash = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 4000); };

  const contacts = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = data.contacts;
    if (q) {
      list = list.filter((c) =>
        [c.fullName, c.title, c.company, c.location, c.email].some((v) => v?.toLowerCase().includes(q)),
      );
    }
    const sorted = [...list];
    if (sort === "score") sorted.sort((a, b) => (b.score?.overall ?? -1) - (a.score?.overall ?? -1));
    else if (sort === "name") sorted.sort((a, b) => (a.fullName ?? "").localeCompare(b.fullName ?? ""));
    else sorted.sort((a, b) => (a.outreach?.[0]?.status ?? "z").localeCompare(b.outreach?.[0]?.status ?? "z"));
    return sorted;
  }, [data.contacts, query, sort]);

  const unscored = data.contacts.filter((c) => !c.score).length;
  const activeSearchBrief = activeSearch
    ? [
      activeSearch.title,
      activeSearch.criteria.titles.length ? `Titles: ${activeSearch.criteria.titles.join(", ")}` : "",
      activeSearch.criteria.keywords.length ? `Keywords: ${activeSearch.criteria.keywords.join(", ")}` : "",
      activeSearch.criteria.mustHave.length ? `Must have: ${activeSearch.criteria.mustHave.join(", ")}` : "",
      activeSearch.criteria.exclude.length ? `Avoid: ${activeSearch.criteria.exclude.join(", ")}` : "",
    ].filter(Boolean).join("\n")
    : "";

  function doEnrich() {
    if (!activeSearch) { flash("Select or create a search first."); return; }
    start(async () => {
      const res = await runEnrichmentAction({ searchId: activeSearch.id, pipeline: data.pipeline, criteria: activeSearch.criteria });
      if (!res.ok) { flash(res.error ?? "Enrichment failed"); return; }
      flash(`Enrichment: ${res.inserted} new, ${res.duplicates} merged.`);
      refresh();
    });
  }

  function doScoreAll() {
    start(async () => {
      const res = await scoreAllAction({ pipeline: data.pipeline, searchId: data.searchId, onlyUnscored: true, limit: 25 });
      if (!res.ok) { flash(res.error ?? "Scoring failed"); return; }
      flash(`Scored ${res.scored} contact${res.scored === 1 ? "" : "s"}.`);
      refresh();
    });
  }

  const exportHref = `/api/radar/export?pipeline=${data.pipeline}${data.searchId ? `&search=${data.searchId}` : ""}`;
  // keep the drawer in sync with refreshed data
  const liveSelected = selected ? data.contacts.find((c) => c.id === selected.id) ?? null : null;

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto", padding: "28px 24px 80px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 12, letterSpacing: 1, textTransform: "uppercase", color: "rgba(22,35,53,0.45)" }}>RDI Clinical Ops</div>
          <h1 style={{ margin: "2px 0 0", fontSize: 26, fontWeight: 700 }}>Talent Radar</h1>
          <p style={{ margin: "4px 0 0", fontSize: 13.5, color: "rgba(22,35,53,0.6)" }}>
            Source, enrich, score, and track candidates and BD contacts — one shared pool.
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Link href="/" style={navLink}>← Triage</Link>
          <span style={{ fontSize: 12.5, color: "rgba(22,35,53,0.55)" }}>{viewer}</span>
        </div>
      </header>

      {!data.configured && (
        <Banner tone="warn">Supabase isn’t configured, so nothing can be saved yet. Set <code>SUPABASE_URL</code> and <code>SUPABASE_SERVICE_KEY</code>, then run the migrations.</Banner>
      )}

      {/* Pipeline tabs */}
      <div style={{ display: "flex", gap: 4, marginTop: 18, borderBottom: "1px solid rgba(22,35,53,0.1)" }}>
        {PIPELINES.map((p) => (
          <button
            key={p.id}
            onClick={() => go({ pipeline: p.id, search: null })}
            style={{
              border: "none", background: "transparent", cursor: "pointer", padding: "10px 14px",
              fontSize: 14, fontWeight: 600,
              color: p.id === data.pipeline ? "#162335" : "rgba(22,35,53,0.5)",
              borderBottom: p.id === data.pipeline ? "2px solid #E74424" : "2px solid transparent",
            }}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Controls */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", margin: "16px 0" }}>
        <select
          value={data.searchId ?? ""}
          onChange={(e) => go({ search: e.target.value || null })}
          style={control}
        >
          <option value="">All contacts</option>
          {data.searches.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
        </select>
        <button style={ghostBtn} onClick={() => setModal("search")}>+ New search</button>
        {activeSearch && <button style={ghostBtn} onClick={() => setModal("editSearch")}>Edit search</button>}
        <button
          style={{ ...primaryBtn, opacity: data.providers.any && activeSearch ? 1 : 0.5 }}
          disabled={pending || !data.providers.any || !activeSearch}
          onClick={doEnrich}
          title={data.providers.any ? "Query Seamless/Apollo for this search" : "No provider API keys configured"}
        >
          {pending ? "Working…" : "Run enrichment"}
        </button>
        <button
          style={{ ...primaryBtn, opacity: data.hasLlm && data.providers.any ? 1 : 0.5 }}
          disabled={!data.hasLlm || !data.providers.any}
          onClick={() => setModal("aiSearch")}
          title={!data.hasLlm ? "Needs ANTHROPIC_API_KEY" : !data.providers.any ? "Needs Seamless/Apollo key" : "Let Claude generate and run provider searches"}
        >
          Run AI search
        </button>

        <div style={{ flex: 1 }} />

        <input placeholder="Filter…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ ...control, minWidth: 160 }} />
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} style={control}>
          <option value="score">Sort: Score</option>
          <option value="name">Sort: Name</option>
          <option value="outreach">Sort: Outreach</option>
        </select>
        <button style={ghostBtn} onClick={() => setModal("import")}>Import CSV</button>
        <button style={ghostBtn} onClick={() => setModal("add")}>+ Add</button>
        <button style={ghostBtn} disabled={pending || !data.hasLlm || unscored === 0} onClick={doScoreAll} title={data.hasLlm ? "" : "Needs ANTHROPIC_API_KEY"}>
          Score {unscored || ""} unscored
        </button>
        <a href={exportHref} style={ghostBtn}>Export CSV</a>
        <button style={ghostBtn} onClick={() => setModal("scorecard")}>Scorecard</button>
      </div>

      {/* Provider/LLM status */}
      <div style={{ display: "flex", gap: 14, fontSize: 12, color: "rgba(22,35,53,0.5)", marginBottom: 10, flexWrap: "wrap" }}>
        <Dot on={data.providers.seamless} label="Seamless.AI" />
        <Dot on={data.providers.apollo} label="Apollo" />
        <Dot on={data.hasLlm} label="LLM scoring" />
        <span>· {data.contacts.length} contacts{activeSearch ? ` in “${activeSearch.title}”` : ""}</span>
      </div>

      {/* Table */}
      {contacts.length === 0 ? (
        <Empty pipeline={data.pipeline} onAdd={() => setModal("add")} onImport={() => setModal("import")} />
      ) : (
        <div style={{ border: "1px solid rgba(22,35,53,0.1)", borderRadius: 12, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
            <thead>
              <tr style={{ background: "rgba(22,35,53,0.03)", textAlign: "left" }}>
                <Th>Person</Th>
                <Th>Location</Th>
                <Th>Score</Th>
                <Th>Recommendation</Th>
                <Th>Outreach</Th>
                <Th>Owner</Th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => {
                const o = outreachMeta(c.outreach?.[0]?.status);
                const r = recMeta(c.score?.recommendation);
                return (
                  <tr key={c.id} onClick={() => setSelected(c)} style={{ cursor: "pointer", borderTop: "1px solid rgba(22,35,53,0.07)" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(22,35,53,0.02)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                    <Td>
                      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                        <div style={avatar}>{initials(c.fullName)}</div>
                        <div>
                          <div style={{ fontWeight: 600 }}>{c.fullName ?? "Unnamed"}{c.optOut ? <span style={{ color: "#9E3B28", fontWeight: 500 }}> · opted out</span> : null}</div>
                          <div style={{ fontSize: 12, color: "rgba(22,35,53,0.55)" }}>{[c.title, c.company].filter(Boolean).join(" · ") || "—"}</div>
                        </div>
                      </div>
                    </Td>
                    <Td>{c.location ?? "—"}</Td>
                    <Td>
                      <span style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums", color: scoreColor(c.score?.overall) }}>
                        {c.score?.overall != null ? c.score.overall.toFixed(1) : "—"}
                      </span>
                    </Td>
                    <Td><Chip meta={r} /></Td>
                    <Td><Chip meta={o} /></Td>
                    <Td style={{ color: "rgba(22,35,53,0.65)" }}>{c.owner ?? "—"}</Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {liveSelected && (
        <ContactDrawer
          key={liveSelected.id + (liveSelected.score?.createdAt ?? "")}
          contact={liveSelected}
          pipeline={data.pipeline}
          hasLlm={data.hasLlm}
          onClose={() => setSelected(null)}
          onRefresh={refresh}
        />
      )}

      {modal === "search" && <NewSearchModal pipeline={data.pipeline} onClose={() => setModal(null)} onDone={(id) => { setModal(null); go({ search: id }); }} />}
      {modal === "editSearch" && activeSearch && <NewSearchModal pipeline={data.pipeline} search={activeSearch} onClose={() => setModal(null)} onDone={(id) => { setModal(null); go({ search: id }); refresh(); flash("Search updated."); }} />}
      {modal === "aiSearch" && <AiSourcingModal pipeline={data.pipeline} searchId={data.searchId} defaultBrief={activeSearchBrief} onClose={() => setModal(null)} onDone={(id, msg) => { setModal(null); go({ search: id }); refresh(); flash(msg); }} />}
      {modal === "import" && <ImportModal pipeline={data.pipeline} searchId={data.searchId} onClose={() => setModal(null)} onDone={(msg) => { setModal(null); flash(msg); refresh(); }} />}
      {modal === "add" && <AddContactModal pipeline={data.pipeline} searchId={data.searchId} onClose={() => setModal(null)} onDone={() => { setModal(null); flash("Contact added."); refresh(); }} />}
      {modal === "scorecard" && <ScorecardModal pipeline={data.pipeline} name={data.scorecard.name} content={data.scorecard.content} onClose={() => setModal(null)} onDone={() => { setModal(null); flash("Scorecard saved."); refresh(); }} />}

      {toast && <div style={toastStyle}>{toast}</div>}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th style={{ padding: "10px 14px", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: "rgba(22,35,53,0.5)", fontWeight: 600 }}>{children}</th>;
}
function Td({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <td style={{ padding: "10px 14px", verticalAlign: "middle", ...style }}>{children}</td>;
}
function Chip({ meta }: { meta: { c: string; bg: string; b: string; label: string } }) {
  return <span style={{ color: meta.c, background: meta.bg, border: `1px solid ${meta.b}`, borderRadius: 999, padding: "3px 9px", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>{meta.label}</span>;
}
function Dot({ on, label }: { on: boolean; label: string }) {
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
    <span style={{ width: 7, height: 7, borderRadius: 999, background: on ? "#E74424" : "rgba(22,35,53,0.2)" }} />{label}
  </span>;
}
function Banner({ tone, children }: { tone: "warn"; children: React.ReactNode }) {
  return <div style={{ marginTop: 14, border: "1px solid rgba(231,68,36,0.3)", background: "rgba(231,68,36,0.06)", borderRadius: 10, padding: "10px 14px", fontSize: 13 }}>{children}</div>;
}
function Empty({ pipeline, onAdd, onImport }: { pipeline: Pipeline; onAdd: () => void; onImport: () => void }) {
  return (
    <div style={{ textAlign: "center", padding: "60px 20px", border: "1px dashed rgba(22,35,53,0.18)", borderRadius: 14, color: "rgba(22,35,53,0.6)" }}>
      <p style={{ margin: "0 0 14px", fontSize: 15 }}>No {pipeline === "bd" ? "BD contacts" : "candidates"} yet.</p>
      <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
        <button style={primaryBtn} onClick={onImport}>Import a CSV</button>
        <button style={ghostBtn} onClick={onAdd}>Add one manually</button>
      </div>
    </div>
  );
}

const control: React.CSSProperties = { border: "1px solid rgba(22,35,53,0.2)", borderRadius: 8, padding: "7px 10px", fontSize: 13, background: "#fff" };
const primaryBtn: React.CSSProperties = { background: "#162335", color: "#fff", border: "none", borderRadius: 8, padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" };
const ghostBtn: React.CSSProperties = { background: "#fff", color: "#162335", border: "1px solid rgba(22,35,53,0.2)", borderRadius: 8, padding: "7px 12px", fontSize: 13, cursor: "pointer", textDecoration: "none", display: "inline-block" };
const navLink: React.CSSProperties = { fontSize: 13, color: "rgba(22,35,53,0.6)", textDecoration: "none" };
const avatar: React.CSSProperties = { width: 32, height: 32, borderRadius: 8, background: "#162335", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 600, fontSize: 12, flexShrink: 0 };
const toastStyle: React.CSSProperties = { position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "#162335", color: "#fff", padding: "10px 18px", borderRadius: 10, fontSize: 13.5, boxShadow: "0 10px 30px rgba(22,35,53,0.3)", zIndex: 70 };
