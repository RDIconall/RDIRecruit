# RDIRecruit — Candidate Triage · Cursor handoff (v2 / app build)

This supersedes the UI direction in `HANDOFF.md`. The **data model, caching, Workable mapping, and compliance firewall in `spec/RDIRecruit_Build_Spec.md` §1–§7 still stand** — only the surface and a few product decisions changed. Where this doc and the old handoff disagree on layout/copy, **this doc + `RDIRecruit (app).dc.html` win**. Where they disagree on endpoints/data, **the Build Spec wins**.

- **Source of truth (pixels + interaction):** `RDIRecruit (app).dc.html` — inline styles, one `class Component` logic block. Open it directly; everything is plain HTML/JS.
- **Target repo:** `RDIconall/rditrialswebsite` (Next.js). Follow its `AGENTS.md`.

---

## 0. What changed from v1 (read this first)

**Design system is OFF for the app.** The RDI Trials brand system (National 2 / Söhne / Tiempos, navy/orange/cream) is for the **marketing site**, not this internal tool. The app uses:
- **Type:** system stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial`); mono = `ui-monospace, 'SF Mono', Menlo, Consolas`. No brand fonts.
- **Color:** ink `#1A1A1A`, secondary `#595959`, muted `#8A8A8A`, hairline `#E6E6E6`/`#EDEDED`; one functional accent **blue `#2563EB`** (links, RO trajectory, Claude); weak/cut **`#C0392B`**. White surfaces, sharp 4–8px radii, no gradients, no emoji.
- Verdict dots: filled = strong, hollow = mixed, red = weak.

**Kept from the v1 spec (do NOT re-add what we cut):**
- Decision vocabulary only — `Interview first · Verify first · Short screen · Hold` (+ `Cut`/`Disqualified`). No numeric scores, tiers, time-cost math, or AI interview plans.
- Workable is the system of record; we link out generously ("Open in Workable ↗").

**Deliberately simplified vs the v1 spec (agreed — keep simple):**
- No "cut-first" failure-type grouping on the pool. Pool is a neutral ranked board grouped by status (below).
- No gated "Run deep analysis anyway" — the full dossier renders for every candidate.
- No inline margin-comment training loop on the cover letter / answers (answers show a side note from the cached read; no reply-to-train UI).

**New in this build (beyond v1):**
- **Activity log + Claude war-room chat** as two distinct surfaces (replaces the old "corrections log").
- **Status-grouped pool** with collapse-disqualified.
- **Résumé Resync-from-Workable** control.

---

## 1. Screens

### A. Pool board (`/jobs/[shortcode]`)
- **One row per candidate**, dense (≈36px rows). Columns: select · avatar · candidate (name + current title) · company · location · experience · salary ask · **Answers** (AI read) · **Vs. spec** (AI read) · RO level · Actions.
- **Grouped by status**, in this fixed order, with a small group header + count: **Interview first → Verify first → Short screen → Hold**. Within each group, sort by **fit** (strong/strong first; fit = ans + spec where strong=2, mixed=1, weak=0), tiebreak stable.
- **Actions cell:** `Workable ↗` (opens native profile in new tab; stop row-click propagation) + **Disqualify** (or **Reinstate** if already out).
- **Selection + bulk:** row checkboxes + header select-all (active rows). When ≥1 selected, a dark bulk bar shows `N selected · Disqualify N · Clear`.
- **Disqualified candidates collapse out of the groups** into a `Show N disqualified ⌄` toggle at the bottom (greyed, struck name, Reinstate per row). Excluded from group counts.
- Responsive: <760px viewport switches the table to stacked cards (same data, same actions); wider scrolls horizontally — never clip/overlap columns.
- **Data:** `candidates ⋈ latest scores ⋈ candidate_overlay`. Status lives in `candidate_overlay.status`. The two AI reads (Answers, Vs-spec) are **cached at ingest** — never re-run on open/sort/disqualify.

### B. Candidate dossier — single scrolling page (`/jobs/[shortcode]/c/[cid]`)
Reads like a Harvard case study — one ~780px reading column. Top to bottom:
1. **Top bar:** `← Pool` · `Open in Workable ↗`.
2. **Header:** avatar, name, `title · company`.
3. **Dossier facts table** (2-col): position, company, location, commute (looked-up, with a real drive-time/relocation note), experience, salary ask, RO level, Answers (AI), Vs-spec (AI), Recommendation.
4. **Claude's assessment** — pinned dark card at the top: one-paragraph verdict, "Reviewed" list, assessed timestamp + `saved to <id>.md` + Download. This is the standing call; it updates from the war room.
5. **The bio** — flowing narrative with **factual** phase lead-ins (e.g. "Roche Molecular Systems · 2009–2015.").
6. **What the application says** — lede + header/paragraph blocks (Target salary, Answers, Cover letter, Against the spec) + a commute line with source/timestamp.
7. **The record** — work table (Years · Org · Role · Tenure · Biggest accomplishment · RO), one row per role, no-wrap with ellipsis; stacked on mobile.
8. **Level over time** — RO progression SVG chart, annotated (education marker hollow, jobs filled), dashed accent projection line.
9. **Résumé, as sent** — viewer with a **navy toolbar**: filename · sync status · **Resync** · **Download**. See §3.
10. **Cover letter.**
11. **Application answers** — in answered order; each Q → answer → Claude's note (verdict + comment) beneath.
12. **Activity log** + **Claude war room** — see §2.

---

## 2. Activity log + Claude war room (the core new pattern)

Two separate surfaces. The log is the **record**; the war room is **reasoning over the record**.

### Activity log (system of record — Salesforce-style)
- A composer with **type tabs: Interview · Note · Comment**, a textarea, a Name field, and **Log to record**. Interview type also shows **Pull from Fireflies** (fills the textarea from the matched meeting transcript).
- Below: a timeline, oldest→newest. Each entry: avatar + `<Name> logged an interview · 2 days ago` (relative time) + the content. Type colors: interview = accent, comment = ink, note = muted.
- This is human-authored only. **Claude does not auto-reply here.** Anyone on the team can add.
- **Persistence:** one row per entry — `activity(id, candidate_id, type, author, body, created_at)`. The interview transcript body is the same artifact the Build Spec §interview wires to Fireflies.

### Claude war room (chat)
- A chat panel. Claude messages (accent avatar "C") + user messages. Seeded with Claude's opening read.
- Header states what Claude can see: **the activity log (N entries), the résumé, the application answers, and the job spec.**
- Composer: free-text **Ask Claude** + a **↻ Factor in the latest activity** shortcut.
- Claude replies in context (references the log); a reply may carry an **Update assessment →** button. Clicking it **regenerates the pinned assessment** (§B.4) and logs a "Claude updated the assessment" line + a `regen` timestamp.
- **Wire to real Claude:** each send = a call with the **cached `EvalOutput` + activity-log rows + résumé text + JD/spec** as context. "Update assessment" re-runs the evaluator over the delta (new activity) and re-persists the assessment per the Build Spec §1 caching/invalidation contract. Free-chat turns do **not** re-persist scores — they're advisory unless the user hits Update.
- **Persistence:** `warroom_messages(id, candidate_id, role, body, created_at, show_update)`.

---

## 3. Résumé — pull the real file + Resync

- Show the candidate's **actual résumé**, not typed-out prose. At ingest store the original in Storage (`captures/{cid}/resume.pdf`); if Workable holds docx, convert once (LibreOffice headless / Gotenberg). Render with `pdf.js` or an `<iframe>` to the signed URL inside the viewer chrome. **Download** = signed URL.
- **Resync control (new):** the toolbar shows `Synced from Workable · <relative time>` and a **Resync** button. Resync = **re-pull the candidate's résumé (and application fields) from the Workable API → store in Supabase Storage/Postgres → re-render**. States: idle (`Synced …`) → `Pulling from Workable…` → `Stored in Supabase · synced <timestamp>`. Make it idempotent (upsert by `cid`); it does **not** re-run Claude on its own.

---

## 4. State / persistence map (prototype → production)

All of the following are React state in the mock — move to the DB:
| Mock state | Production home |
|---|---|
| `disq{}` / `sel{}` (disqualify, selection) | `candidate_overlay.status` (write via API; optional Workable disposition link-out). Selection is client-only. |
| `activity{}` | `activity` table (§2). |
| `chat{}` / `regen{}` | `warroom_messages` + the assessment re-persist (§2, Build Spec §1). |
| `sync{}` | derived from the résumé capture row's `synced_at`. |
| Working file `<id>.md` (`buildMd()` / Download) | the intended "one candidate = one living case file" record. |

---

## 5. Build order (unchanged from Build Spec §7, with this UI)
1. Read-only Workable mirror + `job_context` + the **grouped pool board** (Open-in-Workable links first — instant value, zero AI).
2. The evaluator (one cached Claude pass → `EvalOutput`) + deterministic scorer → assessment card + the two pool reads.
3. Status overlay → disqualify/reinstate + bulk + collapse.
4. Résumé capture + **Resync**; activity log.
5. War-room chat (reads cached eval + log + résumé + spec; Update re-persists).
6. Rubric editor + version history + audit (Build Spec §6).

**Watch (from Build Spec):** idempotent sync upserts + cron reconcile; rate-limited write-back queue; the §6 extraction compliance firewall (strip protected attributes, including from transcripts); cache-invalidation stamps (`evidence_through`, `rubric_version`) so you don't pay Claude on every render or serve stale reads.

---

*The mock (`RDIRecruit (app).dc.html`) is the contract for layout, copy, and interaction. `spec/RDIRecruit_Build_Spec.md` is the contract for data, caching, Workable-vs-us, and compliance. This file records the v2 product decisions that sit on top.*
