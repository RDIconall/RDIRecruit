# RDIRecruit — Candidate triage

A decision tool that sits on top of Workable and **protects interview time**. It does three things, in order:

1. **Cut the weak candidates first** — clear application-care failures, evidence contradictions, career-pattern risks, and role mismatches before anyone spends a minute on them.
2. **Rank who is worth interviewing** — a single priority table with a decision, a reason, the main risk, and the next action.
3. **Build a deep read only for candidates worth it** — an RO-style time progression, cover-letter and answer annotations, logistics, and interview/Fireflies notes.

There are **no numeric scores and no tiers** — only a shared decision vocabulary: _Interview first · Short screen · Verify first · Hold · Cut · Review blocked_. Workable stays the ATS of record.

## Stack

- **Next.js 16** (App Router, Turbopack) on Vercel
- **Clerk** for login (Vercel Marketplace integration)
- **Supabase** (Postgres + Storage) — connectors preserved for server wiring
- **Claude API** for feature extraction and drafting — connector preserved
- **Workable SPI v3** for sync and deeplinks

## Product surfaces

The app is server-fed from Supabase. `src/app/page.tsx` is a Server Component that loads the selected job's candidates — mapping the real `candidates` / `applications` / `scores` / `ro_assessments` / `evaluations` / `narratives` rows into the triage view model (`src/lib/triage/from-supabase.ts`) — and hands a fully-populated pool to the client surface (`src/components/triage/`), which switches between two views:

- **Pool** (`PoolScreen`) — pool read + counts, a grouped **cut list** to clear first, and an **interview-priority** table with decision/reviewer-signal/why/ask·RO/risk/next-action columns and decision filters.
- **Candidate** (`CandidateScreen`) — red-flag banner (for cuts), the short decision read, reviewer signal, optional human re-analysis, a gated deep analysis (ask vs RO level + editable RO time progression), annotated cover letter and application answers, a logistics check, interview summary + Fireflies transcripts, and a per-candidate **working file** you can download as `.md`.

A **job switcher** in the top bar lists all five published jobs (default: _Clinical Data Manager — Data Integrity & Investigation_); selecting one reloads the pool server-side via `/?job=<shortcode>`.

> **No numeric scores ever reach the UI.** The `scores` table is read only to _derive_ a decision (verdict bands + integrity/verification gates → the decision vocabulary). Decision, why, risk, next, RO capability, logistics, cover, answers, and timeline are mapped faithfully from the real data; fields the DB doesn't have yet degrade gracefully rather than being fabricated.

### Data persistence

Human triage edits persist to Supabase (across users/devices), no longer to `localStorage`:

- **Disqualify** → `candidate_overlay.status` (`active` / `disqualified`), reusing the existing overlay table.
- **Timeline overrides, comment replies, corrections log, pulled/pasted transcripts, run-deep flag** → `candidate_working_files.workspace` (jsonb).

Edits are optimistic in the UI and written through the server actions in `src/app/actions/triage.ts`. "Open in Workable" deeplinks use the real `candidates.raw.profile_url` (falling back to `src/lib/workable/links.ts`).

### Per-candidate working file + recalculate (Claude)

Each candidate has **one living markdown case file** stored in Supabase (`candidate_working_files.content`), rendered by `src/lib/triage/working-file.ts` from the candidate's real materials plus human corrections / replies / transcripts. It is re-rendered every time a human saves an edit, and the **Download .md** button streams the stored content.

The deep buttons — **Save correction & re-analyze**, **Save transcript & analyze**, and **Run deep analysis** — trigger a server-side **recalculate** (`src/lib/triage/recalc.ts`):

1. loads the candidate's stored `.md` + materials + the latest human corrections / transcript / replies,
2. calls **Claude** (Anthropic SDK) to re-derive the decision read — **Decision** (from the fixed vocabulary), **Why**, **Main risk**, **Next action**, and a change note — with **no numeric scores**,
3. writes the read back to `candidate_working_files.read` and appends it into the working-file content,
4. the UI reflects the new decision immediately (optimistic), and the pool refreshes.

It is gated behind Clerk auth and runs entirely server-side, so the API key never reaches the client. If `ANTHROPIC_API_KEY` is missing or Claude errors, the human edit is still saved and the UI shows a non-blocking notice instead of crashing.

## Where the code lives

| Path | Purpose |
|---|---|
| `src/app/page.tsx` | Server Component: loads the pool from Supabase, mounts the triage app (Clerk-protected) |
| `src/components/triage/` | `triage-app`, `pool-screen`, `candidate-screen`, `use-workspace`, `context` |
| `src/lib/triage/` | `types`, `theme` (tokens + decision/signal maps), `from-supabase` (DB→view-model mapper), `load` (server batch loader), `store` (working-file read/write), `working-file` (`.md` renderer), `recalc` (Claude re-derive) |
| `src/app/actions/triage.ts` | Server actions: persist edits, disqualify, recalculate, download `.md` |
| `src/lib/data/` | Board/overlay queries (`board`, `board-queries`, `overlay`) reused as the data layer |
| `src/lib/workable/` | Workable client + link helpers (reused connector) |
| `supabase/migrations/` | `001`–`008` original schema; **`009_working_files.sql`** adds `candidate_working_files` (additive) |
| `src/app/api/` | Workable webhook, cron reconcile/migrate, Fireflies/Gmail ingest, candidate resume (preserved server infra) |
| `archive/` | Previous scoring-centric UI, components, and docs |

## Local development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). All routes require Clerk login, so set Clerk env vars (below) before running.

## Environment

Copy `.env.example` to `.env.local` and fill in (auto-provisioned on Vercel):

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` | Clerk auth (auto-set via Marketplace) |
| `WORKABLE_SUBDOMAIN` | Your Workable subdomain (e.g. `rditrials`) |
| `WORKABLE_TOKEN` | Workable API token |
| `WORKABLE_WEBHOOK_SECRET` | HMAC secret for webhook verification |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | Database + storage |
| `ANTHROPIC_API_KEY` | LLM extraction / drafting |
| `CRON_SECRET` | Protects the cron routes |

No secrets are hardcoded; the build is env-driven and deploys to the `rdi-recruit` Vercel project from `main`.

## Auth

All pages require login via Clerk (`src/middleware.ts`). Sign-in: `/sign-in`. Webhooks (`/api/hooks/*`), cron (`/api/cron/*`), and ingest (`/api/ingest/*`) stay public with their own secrets.

## Deploy

```bash
vercel link --yes --project rdi-recruit
vercel env pull .env.local --yes
vercel deploy --prod --yes
```

Or connect `RDIconall/RDIRecruit` in the [Vercel dashboard](https://vercel.com/new); production builds from `main`. Point Workable webhooks at `https://<your-domain>/api/hooks/workable`.

## Spec & history

- `spec/` — the original handoff (`RDIRecruit.dc.html`, build spec) used as the source of truth for layout, copy, and behavior.
- `archive/` — the previous scoring/rubric UI and docs, kept for reference and connector reuse.
