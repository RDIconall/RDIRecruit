# RDIRecruit — Build Notes (real-data triage + Claude working file)

**Audience:** external reviewers (Claude design + ChatGPT) checking the build against the handoff spec.
**Scope of this document:** what was actually built when the mocked triage prototype was turned into a real, Supabase-backed app with a per-candidate markdown working file that Claude uses to re-derive decisions.

**Stack:** Next.js 16 (App Router) on Vercel · React 19 · TypeScript · Clerk (auth) · Supabase (Postgres) · Anthropic SDK (`claude-sonnet-4-6`, server-side only).

**The one hard rule that shapes the whole UI:** the triage product speaks **decision vocabulary only** — `Interview first · Short screen · Verify first · Hold · Cut · Review blocked`. There are **no numeric scores, tiers, points, percentages, or grades anywhere in the UI**. The `scores` table still exists and is used *internally* to pick a decision bucket, but no score value is ever placed in a field that reaches a screen.

---

## 1. Architecture overview

### 1.1 Server Component data flow

```
/  (src/app/page.tsx, Server Component, force-dynamic)
│   reads ?job=<shortcode> (default = Clinical Data Manager)
│   └─ loadTriagePool(job)                      [src/lib/triage/load.ts, server-only]
│        ├─ getPublishedJobs() / getJobByShortcode()   → job switcher options + title
│        ├─ getBoardFromSupabase(job)                  → candidates ⋈ latest scores ⋈ overlay
│        ├─ batch fetch (one query each, by candidate-id IN list):
│        │     applications · evaluations · narratives · evidence · candidate_working_files
│        └─ mapCandidate(...) per row                  [src/lib/triage/from-supabase.ts]
│             → Candidate[] view model (decision vocabulary only)
│
└─ <TriageApp pool={pool} key={meta.jobShortcode}>   [client component]
     ├─ <TriageDataProvider>  (React context: candidates, meta, jobs)
     ├─ useWorkspace(pool.workspace, candidates, applyRead)  → optimistic edits
     ├─ <PoolScreen>          (reads context)
     └─ <CandidateScreen>     (reads context; triggers server actions)
```

- The page is a **Server Component** (`export const dynamic = "force-dynamic"`) — every load reads from Postgres, no Claude call. Switching jobs changes the `?job=` query param; `TriageApp` is keyed on `meta.jobShortcode`, so a job switch fully resets client state.
- All persistence + recalculation happens through **server actions** (`src/app/actions/triage.ts`) so the Anthropic key and service-role Supabase key never reach the client.
- Claude is called **only on a human triage action** (save correction / paste transcript / run deep analysis) — never on render. This honours the spec's cache-first rule (Claude at evidence/edit time, free re-renders from Postgres).

### 1.2 File map (new / rewritten)

| File | Role |
|---|---|
| `src/lib/triage/types.ts` | View-model types. Added `WorkspaceSlice`, `DecisionRead`, `PoolMeta`, `JobOption`; added `workableUrl` to `Candidate`; `DecisionRead.reanalysis` for before→after. |
| `src/lib/triage/from-supabase.ts` | **Mapper.** Supabase rows → `Candidate`. Houses `deriveDecision()` (score→vocabulary, internal-only) and all field mappers. |
| `src/lib/triage/load.ts` | **Server loader.** `loadTriagePool(job)` (batch) and `loadOneCandidate(id)` (targeted). Builds `PoolMeta` + job options. |
| `src/lib/triage/store.ts` | Read/write `candidate_working_files` (`getWorkingFiles`, `getWorkingFile`, `upsertWorkingFile`). |
| `src/lib/triage/working-file.ts` | **`renderWorkingFile()`** — the living `.md` case file. Faithful port of the spec's `buildMd()`. |
| `src/lib/triage/recalc.ts` | **`recalculateRead()`** — Anthropic call, system/user prompts, JSON parse, resilient fallback. |
| `src/app/actions/triage.ts` | Server actions: `saveCorrection`, `saveTranscript`, `runDeepAnalysis`, `saveReply`, `saveTimeline`, `setDisqualified`, `bulkDisqualify`, `getWorkingFileContent`. |
| `src/components/triage/context.tsx` | `TriageDataProvider` / `useTriageData` (pool data to client tree). |
| `src/components/triage/triage-app.tsx` | Client shell: job switcher, candidate state, `applyRead` after recalc. |
| `src/components/triage/use-workspace.ts` | Server-backed optimistic edit hook (debounced timeline/reply saves; `busy`/`notice`). |
| `src/components/triage/pool-screen.tsx` / `candidate-screen.tsx` | Consume context + server actions; deep-analysis gating; re-analysis block. |
| `src/app/page.tsx` | Server Component entry. |
| `supabase/migrations/009_working_files.sql` | Additive migration (the working-file table). |

Deleted: `src/lib/triage/data.ts` (mock candidates) and `src/lib/triage/workspace.ts` (localStorage + mock deeplinks).

---

## 2. Real-data mapping

### 2.1 Which Supabase columns feed which triage fields

| Triage field (`Candidate`) | Source table.column |
|---|---|
| `id`, `name` | `candidates.workable_id`, `candidates.name` |
| `role`, `company` | latest `evaluations(kind=role_read).payload.role/.company`, else `ro_assessments.per_role[last]` |
| `salary`, `salaryNum` | `evaluations(kind=invest_head).payload.ask` |
| `askTier`, `askNote` | `scores.salary_value` → tier label; `invest_head.payload.vector` |
| `roLevel`, `roVsPool` | `ro_assessments.current_capability` / `.seat_stratum`; `.trajectory` |
| `why` | `read.why` (if recalculated) → `dig_in.payload.careerRead` → first sentence of `invest_head.summary` |
| `flag` (main risk) | `read.risk` → `dig_in.integrityNote` / `.resolve[0]` → `verification.read` |
| `next` | `read.next` → derived from decision |
| `timeline[]` | `narratives.segments[]` (role/edu/gap), enriched with matching `role_read` (level + read) |
| `cover` | `applications.cover_letter` |
| `answers[]` | `evaluations(kind=answer_grade)` (OWNED/SURFACE/EVASIVE → good/thin/flag), else raw `applications.answers` |
| `logistics` | `candidates.location` / `raw.address`; `verification.claims[category=local]` |
| `fireflies[]` | `evidence` rows whose `source_type ∈ INTERVIEW_EVIDENCE_TYPES` with a transcript |
| `redFlags[]` | `dig_in.integrity=material*` + `verification.claims[verdict=DISCREPANCY]` |
| `cutGroup/cutReason/cite/cutMatters` | (only when decision=`cut`) `dig_in`, `narratives`, `overlay.status_reason` |
| `workableUrl` | `candidates.raw.profile_url` if absolute, else `wbCandidate(jobShortcode, id)` |
| `decision` | **derived** — see §2.2 |
| `reanalysis` | `candidate_working_files.read.reanalysis` (set when a human note moved the decision) |

Pool header (`PoolMeta`) counts are computed in `deriveMeta()` purely from the decision distribution — no scores, no Claude.

### 2.2 Internal score → decision-vocabulary derivation

`deriveDecision()` in `from-supabase.ts`. The numeric `total` and salary bands stay **internal**; they only choose a bucket. A persisted Claude read overrides everything (the human-driven re-derivation wins).

```
1. read.decision present?            → use it (Claude re-derivation wins)
2. no invest_head OR no score row    → "blocked"   (materials incomplete / unparsed)
3. human disqualified (overlay/flag) → "cut"
4. dig_in.integrity starts "material"→ "cut"        (integrity is a GATE, not a score)
5. score.total < 55                  → "cut"
6. verification has a DISCREPANCY    → "verify"
7. salary unstated AND total < 82    → "verify"
8. total >= 82                       → "interview"
9. total >= 68                       → "short"
10. else                             → "hold"
```

Verdict bands mirror the evaluator (`85+/70–84/55–69/<55`, tuned to `82/68/55` for the triage cut), with **integrity and verification gates layered on top** so a material misrepresentation or a contradiction can't be out-scored. **None of these numbers appear in the UI** — only the resulting decision word.

---

## 3. `candidate_working_files` (migration 009) + the `.md` template

### 3.1 Schema (additive only)

```sql
create table if not exists candidate_working_files (
  candidate_id text primary key references candidates(workable_id) on delete cascade,
  content      text,                               -- rendered .md (the downloadable file)
  read         jsonb,                              -- Claude's DecisionRead (no scores)
  workspace    jsonb not null default '{}'::jsonb, -- human edits not on candidate_overlay
  updated_at   timestamptz default now(),
  updated_by   text
);
alter table candidate_working_files enable row level security;
-- service-role-only policy (server reads/writes via service key), mirroring migration 002.
```

- **`content`** — the living markdown (`renderWorkingFile`), re-rendered on every human edit / recalc.
- **`read`** — `DecisionRead { decision, why, risk, next, timelineNote?, flags?, reanalysis?, recalculatedAt?, model? }`. Decision vocabulary only.
- **`workspace`** — `WorkspaceSlice { ovr?, replies?, corrections?, transcript?, deep? }`. **Disqualify deliberately lives on `candidate_overlay`** (the spec's status overlay that drives pool math), not here.

Applied via the Supabase MCP `apply_migration`; additive (one `create table if not exists`), so the 219 candidates / 5 jobs were untouched.

### 3.2 The `.md` template (exactly what `renderWorkingFile` emits)

Section order is verbatim to the spec's `buildMd()`: header → RO time progression → Corrections → Notes to Claude → Interview summary (if any) → Pasted transcript (if any).

```markdown
# Candidate: {name}

- Role applied: {role}
- Current company: {company}
- Salary ask: {salary}
- RO level: {roLevel}
- Decision: {Decision label}{ (DISQUALIFIED) if disqualified}
- Workable: {workableUrl}
- Last updated: {Mon DD, YYYY HH:MM AM/PM}

## RO time progression

| Period | Org/School | Role | Tenure | Scope | Signal |
|---|---|---|---|---|---|
| {period} | {org} | {role} | {tenure} | {scope} | {signal} |

## Corrections (human, persisted)

- [{ts}] {text}        (or "- none")

## Notes to Claude (replies on its comments)

- ({key}) {reply}      (or "- none")

## Interview summary           ← only if an interview summary exists

{interview.title}

{interview.fit}

## Pasted transcript           ← only if a transcript was pasted

{transcript}
```

### 3.3 A real example (Clinical Data Manager pool)

```markdown
# Candidate: Marcus Fillmore

- Role applied: Clinical Data Manager — Data Integrity & Investigation
- Current company: Huntsman Cancer Institute
- Salary ask: $185k
- RO level: Reads RO-4, climbing toward RO-5
- Decision: Verify first
- Workable: https://rditrials.workable.com/backend/jobs/379AA16E8F/candidates/8f2c...
- Last updated: Jun 14, 2026 08:12 PM

## RO time progression

| Period | Org/School | Role | Tenure | Scope | Signal |
|---|---|---|---|---|---|
| 2015 – 2022 | Huntsman Cancer Institute | Director, Research & Science | 7.0 yrs | Owned assay validation across CLSI EP17/EP05; led design control. | Positive |
| 2011 – 2015 | Myriad Genetics | Senior Scientist | 4.0 yrs | Method comparison + lot-to-lot bridging on banked samples. | Positive |
| 2007 – 2011 | University of Utah | Ph.D., Molecular Biology | — | Academic background | Connected |

## Corrections (human, persisted)

- [Jun 14, 2026 07:55 PM] Confirmed he has NOT left Huntsman — profile is current, application date was stale.

## Notes to Claude (replies on its comments)

- (stale-end-date) Resolved on the screening call; treat Huntsman as current.

## Interview summary

Short screen — 25 min

Strong on analytical validation; deflected on people-management scope. Worth a full panel.

## Pasted transcript

Q: Walk me through validating a new assay end to end...
A: I start with analytical validation — LoB, LoD and precision to CLSI EP17 and EP05 ...
```

*(Header values, RO rows, and reads are filled from the live tables in §2.1; the example shows the rendered shape.)*

---

## 4. Claude integration contract

### 4.1 When it triggers

| UI action | Server action | Recalc? | Re-analysis trigger label |
|---|---|---|---|
| Save correction & re-analyze | `saveCorrection` | yes | `Human correction` |
| Paste interview/screen transcript | `saveTranscript` | yes | `Interview transcript` |
| Run deep analysis (anyway) | `runDeepAnalysis` | yes | `Deep analysis` |
| Reply to an AI comment | `saveReply` | no (persist only) | — |
| Edit timeline row | `saveTimeline` | no (persist only) | — |
| Disqualify / restore | `setDisqualified` / `bulkDisqualify` | no (overlay + pool math) | — |

Recalc never runs on page load. Replies/timeline edits persist and are folded into the next recalc's `.md`.

### 4.2 Clerk gating + key safety

Every action calls `requireAuth()` (`auth()` from `@clerk/nextjs/server`) before touching data. Recalc runs only inside server actions; `ANTHROPIC_API_KEY` and the Supabase service key are server-only and never serialized to the client.

### 4.3 Input payload

`recalculateRead({ candidate, workingFile, corrections, transcript, replies })`:
- **`workingFile`** — the candidate's stored/rendered `.md` (the living case file), capped at 8k chars, injected verbatim at the top of the prompt.
- **materials** — career timeline, cover letter, application answers, prior read (decision/why/risk/next), salary ask, RO level, logistics.
- **latest human signal** — corrections (authoritative, override the AI's earlier parse), reviewer replies, interview/screen transcript (weighted heavily).

### 4.4 System message (verbatim)

> You are the candidate-triage decision engine for RDI Trials. Your job is to protect interview time: cut weak candidates first, decide who is worth a screen, and flag who needs verification before any human time is spent.
>
> OUTPUT IS A DECISION, NOT A SCORE. You must NEVER produce, mention, or imply a numeric score, points, percentage, grade, or tier. The ONLY status language allowed is this fixed decision vocabulary:
> - "interview" = Interview first · "short" = Short screen · "verify" = Verify first · "hold" = Hold · "cut" = Cut · "blocked" = Review blocked
>
> Read ACTIONS and evidence, not adjectives. Weigh the human corrections and any interview transcript HEAVILY — a human correction overrides the AI's earlier parse of the materials. Integrity problems and clear contradictions are gates: they push to cut regardless of fit.
>
> Return JSON only … `{ decision, why, risk, next, timelineNote }`.

### 4.5 Expected structured output

```json
{
  "decision": "interview | short | verify | hold | cut | blocked",
  "why":  "one or two sentences — the decisive reason, grounded in materials/corrections",
  "risk": "the single main risk / the one thing a human must settle",
  "next": "Screen | Short screen | Verify | Hold | Reject | Re-sync",
  "timelineNote": "what changed vs the prior read, or empty"
}
```

Parsing is defensive: extract the first `{...}` block, validate `decision` against the fixed vocabulary (else keep the prior decision), trim fields, stamp `recalculatedAt` + `model`.

### 4.6 Re-analysis (before → after)

After a recalc, if `read.decision !== priorDecision`, the action attaches `reanalysis = { reviewer: <trigger label>, before: <prior decision label>, after: <new decision label>, rec: timelineNote||why }`. The candidate screen renders the spec's **"Re-analysis · human signal — {reviewer}"** block: previous decision struck through → new decision, with the note. This is persisted in `read.reanalysis` so it survives reload.

### 4.7 Graceful degradation

- No `ANTHROPIC_API_KEY` (`hasAnthropic()` false) → `recalculateRead` returns `null`; the human edit is **still persisted**, and the UI shows *"Saved. Claude re-analysis unavailable (no API key or transient error)."*
- API/parse error → caught, logged, returns `null` (same path) — the page never crashes.
- No Supabase → actions return a friendly "not configured" message; the page renders an empty pool with a "Not connected" health read.

---

## 5. Known data gaps (and how they degrade)

| Gap | Behaviour |
|---|---|
| **Reviewer signal** (who/how a human rated) | No reviewer-rating source in the DB. `rev`/`revNote` default to "No human review yet"; the human-signal *reviewer* on re-analysis is the trigger label (Human correction / Interview transcript / Deep analysis), not a person record. |
| **Commute distance** | `candidates.location` exists but no geocoded distance. `logistics.distance = "—"`; likelihood (High/Medium/Low) is inferred from location text against the Van Nuys, CA base; the read asks the human to confirm the commute. |
| **Interview summaries** | No structured interview-summary table. `interview` is undefined → the `## Interview summary` section is omitted from the `.md` and the screen block is hidden until a transcript/summary exists. |
| **~17 missing narratives** | Candidates without a `narratives` row get a single placeholder timeline row ("Materials not parsed — re-sync from Workable") and, combined with a missing score/invest read, fall to `blocked` rather than fabricating a chronology. |

Nothing is fabricated; every gap renders an explicit "—" / "confirm" / "re-sync" rather than inventing data.

---

## 6. Spec conformance

| Spec requirement (handoff) | Status | Where / note |
|---|---|---|
| **Screens** — Pool screen + single Candidate screen, layout/copy per mock | Met | `pool-screen.tsx`, `candidate-screen.tsx`; brand tokens preserved in `theme.ts`. |
| **Decision vocabulary only** (Interview first · Short screen · Verify first · Hold · Cut · Review blocked) | Met | `Decision` union; `deriveDecision`; system prompt forbids any number; no score field reaches UI. |
| **No numeric scores / tiers / grades** | Met | Scores used only internally in `deriveDecision`; never mapped to a UI field; Claude prompt bans them. |
| **Mocked → real services** (Supabase-backed) | Met | `data.ts` mock deleted; server loader reads `candidates/applications/scores/ro_assessments/evaluations/narratives/evidence/candidate_overlay`. |
| **Job switcher, default Clinical Data Manager** | Met | `DEFAULT_JOB_SHORTCODE = 379AA16E8F`; all 5 published jobs in the switcher; `?job=` + keyed remount. |
| **Persistence across users/devices** | Met | Disqualify → `candidate_overlay`; other edits → `candidate_working_files.workspace`; optimistic UX in `use-workspace.ts`. |
| **`.md` working file = buildMd() layout/order** | Met (fixed this pass) | `renderWorkingFile` now matches header → RO time progression → Corrections → Notes to Claude → Interview summary → Pasted transcript. |
| **Download .md works from stored content** | Met | `getWorkingFileContent` server action returns the stored/rendered `content`. |
| **Claude inputs = stored .md + materials + latest corrections/transcript/replies** | Met (fixed this pass) | `recalc.ts` now injects the stored `.md` plus all materials/human signals. |
| **Claude output contract = decision + why + risk + next, no numbers** | Met | §4.4–4.5. |
| **Re-analysis when a human note changes the decision (before→after, human-signal reviewer)** | Met (wired this pass) | Action builds `reanalysis` on decision change; rendered in the candidate screen; persisted in `read`. |
| **Deep analysis gating** (auto for Interview/Short/Verify; behind "Run deep analysis anyway" for Cut/Hold/Blocked) | Met | `aShowDeep = ["interview","short","verify"].includes(decision) || ws.deep[id]`. |
| **Open in Workable deeplinks** (real ids) | Met | `workableUrl` from `raw.profile_url` else `wbCandidate(shortcode, id)`. |
| **Clerk-gated, server-side Claude, key never client-side** | Met | `requireAuth()` in every action; recalc server-only. |
| **Cache-first (Claude at edit/ingest, not per render)** | Met | Page is a Server Component reading Postgres; recalc only on human action. |
| **Additive migration, data intact (219/5)** | Met | `009_working_files.sql` is `create table if not exists` + RLS only. |
| **Vercel-deployable, env-driven, typecheck + build green** | Met | `npm run typecheck` and `npm run build` pass; no hardcoded secrets. |
| **Out-of-scope** (Workable as system of record; EEO/GDPR/scheduling/email send stay in Workable) | Honoured | We add only the review/intelligence + working-file layer; everything else link-outs to Workable. |

### Intentional differences from the older `RDIRecruit_Build_Spec.md`

That spec is the **scoring-centric board** (fit numbers, tiers, ranked ledger). The current product is the **candidate-triage decision tool** — the explicit product pivot (see `AGENTS.md`): **no scores, no tiers, decision vocabulary only**. Where the two disagree, the triage direction wins; the scoring tables are retained but used solely as internal inputs to `deriveDecision`. The legacy mock (`spec/RDIRecruit.dc.html`) is the older board UI and is not the layout target for the triage screens.

---

*Built additively on the existing Workable sync layer; Workable stays the system of record. Claude is called once per human edit, never per render.*
