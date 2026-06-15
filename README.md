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

The app is a single client surface (`src/components/triage/`) that switches between two views:

- **Pool** (`PoolScreen`) — pool read + counts, a grouped **cut list** to clear first, and an **interview-priority** table with decision/reviewer-signal/why/ask·RO/risk/next-action columns and decision filters.
- **Candidate** (`CandidateScreen`) — red-flag banner (for cuts), the short decision read, reviewer signal, optional human re-analysis, a gated deep analysis (ask vs RO level + editable RO time progression), annotated cover letter and application answers, a logistics check, interview summary + Fireflies transcripts, and a per-candidate **working file** you can download as `.md`.

Human edits (disqualifications, timeline overrides, comment replies, corrections, pulled transcripts) persist to `localStorage` under `rdi-recruit-ws-v1`. This is the prototype persistence layer — wire it to Supabase server-side next.

## Where the code lives

| Path | Purpose |
|---|---|
| `src/app/page.tsx` | Mounts the triage app (Clerk-protected) |
| `src/components/triage/` | `triage-app`, `pool-screen`, `candidate-screen`, `use-workspace` |
| `src/lib/triage/` | `types`, `data` (mock pool), `theme` (tokens + decision/signal maps), `workspace` (localStorage + Workable deeplinks + `.md` builder) |
| `src/lib/workable/` | Workable client + link helpers (reused connector) |
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
