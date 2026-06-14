# RDIRecruit

Intelligence layer on top of Workable for RDI Trials recruiting. Workable remains the ATS of record; this app owns ranking, scoring, RO reads, life narratives, and the evidence loop.

## Stack

- **Next.js 16** (App Router) on Vercel
- **Clerk** for login (Vercel Marketplace integration)
- **Supabase** (Postgres + Storage)
- **Claude API** for feature extraction and drafting
- **Workable SPI v3** for sync and write-back

## Agent quality rules

This repo includes [Addy Osmani's agent-skills](https://github.com/addyosmani/agent-skills) in `.cursor/rules/` for TDD, code review, incremental implementation, frontend UI, security, and browser testing. See `AGENTS.md`.

## Local development

```bash
npm install
npm run dev
```

Open [http://localhost:3000/board](http://localhost:3000/board). Without Supabase configured, the app runs with demo candidates so you can explore the UI immediately.

## Environment

Copy `.env.example` to `.env.local` and fill in:

| Variable | Purpose |
|---|---|
| `WORKABLE_SUBDOMAIN` | Your Workable subdomain (e.g. `rditrials`) |
| `WORKABLE_TOKEN` | Workable API token |
| `WORKABLE_WEBHOOK_SECRET` | HMAC secret for webhook verification |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | Database + storage |
| `ANTHROPIC_API_KEY` | LLM scoring extraction |
| `CRON_SECRET` | Protects the nightly reconcile cron |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` | Clerk auth (auto-set via Marketplace) |

## Auth

All pages require login via Clerk. Sign-in: `/sign-in`. Webhooks and cron routes stay public with their own secrets.

Install Clerk on Vercel:

```bash
vercel integration add clerk
vercel env pull .env.local --yes
```

## Database

Run the migration in Supabase SQL editor:

```
supabase/migrations/001_initial_schema.sql
```

## Key routes

| Route | Purpose |
|---|---|
| `/board` | Ranked candidate board |
| `/candidates/[id]` | Detail: claims, RO panel, narrative |
| `/rubrics` | Rubric markdown editor |
| `/api/hooks/workable` | Workable webhook ingress |
| `/api/cron/reconcile` | Nightly Workable → Postgres reconcile |

## Spec docs

- `RDI_Hiring_Layer_Build_Spec (1).md` — full build spec
- `RDI_How_We_Evaluate.md` — evaluation rubric for humans and LLMs

## Build sequence implemented

1. Read-only Workable mirror (webhook + cron reconcile)
2. Fit scorer with rubric-as-data, deterministic math + LLM extraction
3. Write-back queue scaffold (rate-limited)
4. RO module with validation gate
5. Life-narrative generator + claim↔source UI
6. Webhook stubs for VideoAsk and Calendly
7. Rubric editor UI

## Deploy

### One-shot bootstrap

```bash
chmod +x scripts/bootstrap-vercel.sh
./scripts/bootstrap-vercel.sh
```

### Manual

```bash
vercel login
vercel link --yes --project rdi-recruit
vercel integration add clerk    # login + env vars
vercel env pull .env.local --yes
vercel deploy --yes             # preview
vercel deploy --prod --yes      # production
```

Or connect the GitHub repo in the [Vercel dashboard](https://vercel.com/new) — import `RDIconall/RDIRecruit`.

Point Workable webhooks at `https://<your-domain>/api/hooks/workable`.
