# RDIRecruit — Build Spec (our UI on top of Workable)

**For:** Cursor / Claude Code · **Owner:** Conall, RDI Trials
**Stack:** Next.js (App Router) on Vercel · Supabase (Postgres + Auth + Storage) · **Workable API** (system of record) · Claude API (`claude-sonnet-4-6`, ingest-only)

**The UX/CSS contract is `RDIRecruit.dc.html`** (in this `spec/` folder). It is the built, working mock of every screen described here — copy its inline styles, layout, copy, and interactions verbatim. Brand tokens: Navy `#162335`, Orange `#E74424` (one accent, used for the active state / primary CTA / the gap marker / the editorial beat only), Cream `#FAFAF7`; fonts Instrument Sans (body), Instrument Serif (the rare italic citation/beat), a mono (JetBrains Mono stands in for Söhne Mono — data, IDs, dates).

Read this **with** the two prior docs already in the repo: `RDI_Hiring_Layer_Build_Spec (1).md` (the full Workable sync layer, data model, §9a source capture, comms) and `RDI_How_We_Evaluate.md` (the evaluation philosophy these reads encode). This spec is the **delta**: the caching contract, the Workable-first/link-out rule, and the screens as built.

---

## 0. The two hard rules — design everything around these

### Rule 1 — Cache-first. Claude is called **once per piece of evidence, never per page view.**
- Claude runs **only at ingest of a new evidence row** (application parsed, résumé rendered, async video transcribed, reply captured, reference returned). Its output — extracted **features**, **scores**, and the qualitative **reads** (per-role read, dig-in card, verification verdicts, answer grading) — is **persisted to Postgres**.
- Board loads, re-ranks, rubric-weight tweaks, pool math, and every re-render read **from Postgres → zero Claude calls.**
- A rubric **weight/threshold** change = deterministic recompute in TypeScript over the already-stored features (cheap, no model). Only a change to a **category's evidence definition**, or **new raw evidence**, re-calls Claude — and only for the delta.
- Every cached read row is stamped `model_version`, `rubric_version`, `evidence_through uuid[]`. Invalidate **only** when one of those changes. This is the whole cost-control story: §5 of the original spec ("store features separately from the number") is why a re-score is a recompute, not a re-collection.
- **The pool/investment math is plain app code, not Claude** (see §4). It recomputes live from cached `status` + `complement` fields on every render — free.

### Rule 2 — Workable-first. We are a thin UI **on top of** Workable; link out where native build is a pain.
- Workable stays the system of record for **distribution, job posts, EEO/consent capture, candidate email threading + retention, dispositions, and scheduling templates.** Do not rebuild those.
- We own only the **intelligence + review layer**: ranking, scoring, the reads, provenance, the pool/investment view, status overlay.
- **Any feature that is expensive or fiddly to build natively → render a button that opens the exact Workable screen in a new tab** (`target="_blank"`). Examples below. Prefer a deep link over a half-built feature every time.

---

## 1. Own DB — what we persist (so we pay Claude once)

Extends the schema in `RDI_Hiring_Layer_Build_Spec (1).md` §3. Add/confirm:

```sql
-- Our status overlay on top of Workable stage. Drives the pool math (§4).
-- Workable stage is still authoritative for pipeline; this is our review disposition.
create table candidate_overlay (
  candidate_id   text primary key references candidates(workable_id) on delete cascade,
  status         text not null default 'active',   -- active | disqualified | withdrawn
  status_reason  text,                              -- mirrors Workable disqualified_reason when synced
  complement     text,                              -- owner | technician  (the §2 read, cached)
  complement_removes text,                          -- "the science & lab key-person risk …"
  salary_vector  text,                              -- "a fundraise decision, not a budget rejection"
  updated_by     uuid, updated_at timestamptz default now()
);

-- All qualitative reads, computed by Claude ONCE at ingest, re-rendered free.
create table evaluations (
  id             uuid primary key default gen_random_uuid(),
  candidate_id   text references candidates(workable_id) on delete cascade,
  kind           text not null,    -- role_read | dig_in | verification | answer_grade | invest_head
  ref            text,             -- role pos, question id, etc.
  payload        jsonb not null,   -- the read (text, verdict, present[], tells[], …)
  model_version  text, rubric_version int, evidence_through uuid[],
  created_at     timestamptz default now()
);
create index on evaluations(candidate_id, kind);
```

- `scores`, `score_inputs`, `ro_assessments`, `evidence`, `narratives` — exactly as the original spec. **Never update a score row**; each re-score is a new row → full history + re-rank + "91 under v3 / 88 under v4" diffs.
- Résumé/source files live in a **private** Supabase Storage bucket, signed URLs only, every read `audit_log`-tracked (it is PII).

**Invalidation cheat-sheet**
| Changed | Recompute | Claude? |
|---|---|---|
| Rubric weight / tier cutoff | deterministic over stored features | no |
| Candidate DQ'd / withdrew | pool math only (app) | no |
| Page viewed / re-ranked | read from Postgres | no |
| New video / reply / reference | extract delta + re-score that candidate | yes (delta only) |
| Rubric **category** definition | re-extract that feature over stored raw evidence | yes (one feature) |

---

## 2. Workable mapping + the link-out escape hatches

| Capability | How we do it |
|---|---|
| Job posting, distribution, careers page | **Workable** — link out to the job. |
| EEO / consent capture, GDPR retention | **Workable** — never rebuild. |
| Candidate email send (templates + tailored) | **Workable** — we move the stage via API and Workable fires the stage-bound template. Tailored one-off → **"Open in Workable to send"** button. |
| Candidate reply threading | **Workable** + connected Gmail (read-only) → we attach as an `evidence(answer)` row. |
| Scheduling | **Calendly** link in the Workable template (as the original spec). |
| Disposition / reject reasons | write status via API; **"Set reason in Workable"** link-out for the structured reason. |
| Stage move (Advance / Hold / Async) | **our API** → write-back queue (10 req/10s) → Workable fires the template. |
| Ranking, scoring, reads, pool view, provenance | **us** (this app). |

**Deep-link helpers** — build these once and use everywhere a feature is a pain:

```ts
const WB = `https://${process.env.WORKABLE_SUBDOMAIN}.workable.com/backend`;
export const wbCandidate = (jobShortcode: string, cid: string) =>
  `${WB}/jobs/${jobShortcode}/candidates/${cid}`;            // full native profile
export const wbCandidateEmail = (jobShortcode: string, cid: string) =>
  `${wbCandidate(jobShortcode, cid)}#email`;                 // send tailored email
export const wbCandidateTimeline = (jobShortcode: string, cid: string) =>
  `${wbCandidate(jobShortcode, cid)}#timeline`;              // full activity
export const wbJob = (jobShortcode: string) => `${WB}/jobs/${jobShortcode}`;
```

Every candidate header carries an **"Open in Workable ↗"** button (`target="_blank"`). Rule of thumb: if a feature would take more than ~a day to build well and Workable already does it, ship the link instead.

---

## 3. Screens — mapped to data + endpoints (the `.dc.html` is the pixel contract)

### A. Ranked board  (`/jobs/[shortcode]`)
- **Source:** `candidates` ⋈ latest `scores` ⋈ `candidate_overlay`. Sort: active first, then `total` desc.
- 3 live layouts (Ledger / Evidence / Tiers) — segmented control, client-side.
- Tier filter = text tabs (All / Strong / Consider / Hold / Deny / New), **counts are active-only**.
- Bulk select → **Advance / Hold** (stage move via API) · **Disqualify** (sets `overlay.status='disqualified'` + optional Workable disposition link-out).
- Disqualified/withdrawn rows: greyed, struck through, stage shows the status, **excluded from active counts**.
- Verdict strip is dynamic: `{active} live · {strong} strong · {new} new · {out} out · seat IVc–IVb`.

### B. Candidate profile — single page  (`/jobs/[shortcode]/c/[cid]`)
Top-to-bottom, exactly as the mock:
1. **Identity** — name, role · company, RO/seat/trajectory/basis/location, fit number, tier, confidence.
2. **Investment read** (the top summary, §4) — `investHead` ("Risk off the company" / "Work off the desk") + `investText` (the §2 trade) + live `Pool · N active · M disqualified · K withdrawn`, and a **prominent Target-salary panel** (`$215k`, value word, **salary-as-vector** line). **Recomputes on every status change — no Claude.**
3. **Actions** — Compose invite (→ §C) · Advance · Hold · **Disqualify** · **Mark withdrawn** · Restore (when inactive) · **Open in Workable ↗**.
4. **Career, stratum & the life timeline** — ONE component = the chronology + RO climb + résumé evidence, oldest→newest (you scroll forward in time). A stratum-over-time **chart** at top (annotated with school · role, Ph.D. marker, the **education gap shaded**); below, the reversed timeline with a **fixed left time-axis**, an explicit **gap** block, and per role: a **rubric read** (`evaluations.kind='role_read'`, level/register + burden) with a **Show source** toggle revealing the **raw résumé line** (highlighted spans = `score_inputs`).
5. **Verification & flags** — clean verdict→category→explanation table; conflict quotes only on `DISCREPANCY`. Pull `[NEEDS YOU]` items to the top (résumé-vs-profile contradictions, auth-walled profiles). Claims, not the person. **Verification only — never touches the fit number.**
6. **The application — in full** (one view, no tabs): **Dig-in card** (evidence quality, owned/surface/evasive, integrity gate, settle-live) → **screening answers graded** OWNED/SURFACE/EVASIVE on substance vs concept key (not fluency) → **cover letter** → **résumé as a PDF viewer** (§5).

### C. Compose invite  (`/jobs/[shortcode]/c/[cid]/compose`)
- AI-suggested risk questions (cached), checkable → auto-built email insert.
- Template picker + gated send: **the app moves the stage; Workable sends the mail.** Tailored one-off → **"Open in Workable to send" ↗**.
- VideoAsk (intro video reused + answer slots) + Calendly per the original spec.

---

## 4. Evaluation fields — what's Claude-cached vs computed live

| Field | Source | When |
|---|---|---|
| `complement` (owner/technician), `complement_removes`, `salary_vector` | Claude read, stored in `candidate_overlay` | ingest |
| per-role `role_read` | Claude, `evaluations` | ingest |
| `dig_in`, `verification`, `answer_grade` | Claude, `evaluations` | ingest |
| `total`, `category_scores`, `confidence`, RO stratum | scorer (deterministic + cached features) | ingest / rubric recompute |
| **`investHead` / `investText` / pool counts / rank** | **plain TypeScript over cached `status`+`complement`+`total`** | **every render — free** |

The investment text is templated in code (see `complementMap` + the pool math in `RDIRecruit.dc.html`'s logic class): it reads the active pool, the candidate's complement type, owners-active count, and rank, and writes the §2 trade. Disqualify/withdraw anywhere → it rewrites itself. **Do not send this to Claude on render.**

---

## 5. Résumé PDF viewer — store once, never regenerate

- At ingest, store the candidate's original résumé in Storage (`captures/{cid}/resume.pdf`). If Workable holds it as docx, convert **once** to PDF on ingest (LibreOffice headless / Gotenberg) — or, if conversion is a pain, **link out to Workable's résumé view** per Rule 2.
- Render with `pdf.js` (or a plain `<iframe>` to the signed URL) inside the viewer chrome from the mock (navy toolbar, page count, zoom, **Download** = signed URL). The reader never re-renders text we typed — it shows the real file.

---

## 6. Compliance firewall (carry forward, non-negotiable)
- Job-relevant evidence only. **Strip protected/non-job attributes at extraction** (age, race, national origin, religion, gender, orientation, disability, health, family status, photos, appearance) — including from transcripts.
- Verification uses the **public professional profile only**; no social trawl. Public/async text is self-reported and possibly AI-written → treat polish as weak evidence, push load onto live demonstration.
- Integrity & ego are **gates, not scores** — a material misrepresentation or ego/effort signal is a hard no regardless of fit. Never blend dimensions into one number.

---

## 7. Build sequence (each step usable alone)
1. **Read-only mirror** (Workable webhook + cron → Postgres) + **board** reading the mock's Ledger layout. Add the **Open-in-Workable** links now — instant value, zero AI.
2. **Cached scorer** (Claude once → `scores` + features + `score_inputs`) + ranked board + candidate identity.
3. **Status overlay** (`candidate_overlay`) → Disqualify/withdraw → **pool math + investment summary** (pure app code).
4. **Write-back** (stage moves through the queue) + **Compose** (stage→template) + tailored-send link-out.
5. **The reads** (`evaluations`): per-role reads, dig-in, verification, answer grading — Claude at ingest, cached. Career timeline + résumé PDF viewer + the highlight↔source overlay.
6. **Rubric editor** + score/RO version history + audit log (per the original spec §5a, §7).

**Watch:** sync integrity (idempotent upserts + cron reconcile); the rate-limited write queue; the §6 validation gate (demote AI-likely text, lean on tenure/role-level/references, never auto-reject); the extraction compliance firewall; and **the cache-invalidation stamps** — if `evidence_through`/`rubric_version` are wrong you'll either pay for Claude on every load or serve stale reads.

---

*The mock (`RDIRecruit.dc.html`) is the source of truth for layout, copy, and interaction. This spec is the source of truth for data, caching, and what's Workable vs us. When they disagree on a pixel, the mock wins; on an endpoint, this spec wins.*
