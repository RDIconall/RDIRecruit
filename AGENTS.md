# Agent guidance for RDIRecruit

This project uses [Addy Osmani's agent-skills](https://github.com/addyosmani/agent-skills) for engineering quality. The full pack of 24 skills (23 lifecycle + 1 meta) is installed as Cursor rules in `.cursor/rules/` — each file is a verbatim copy of the upstream `skills/<name>/SKILL.md`. Provenance and content hashes are pinned in `skills-lock.json` (source `addyosmani/agent-skills`, commit `3a6fc6392823e31e2362091bd4e3cddf5b77af14`).

Follow these when building features, especially the triage decision flow, auth, and candidate PII handling.

## Product

RDIRecruit is a **candidate-triage decision tool** that protects interview time: cut weak candidates first, rank who to interview, then build a deep read only for the ones worth it. There are **no numeric scores and no tiers** — only the decision vocabulary _Interview first · Short screen · Verify first · Hold · Cut · Review blocked_. Workable stays the ATS of record.

- UI: `src/components/triage/` (`triage-app`, `pool-screen`, `candidate-screen`, `use-workspace`, `context`).
- Domain + data: `src/lib/triage/` (`types`, `theme`, `from-supabase` mapper, `load` server loader, `store` + `working-file` for the `.md`, `recalc` for the Claude re-derive).
- The app is **server-fed from Supabase** (`src/app/page.tsx` Server Component → `loadTriagePool`). Real tables: `candidates`, `applications`, `scores`, `ro_assessments`, `evaluations`, `narratives`, `candidate_overlay`, and `candidate_working_files` (migration `009`).
- **No numeric scores/tiers in the UI** — `scores` is used only to derive a decision from the vocabulary; everything surfaced maps from real data or degrades gracefully.
- Human edits persist to Supabase via `src/app/actions/triage.ts`: disqualify → `candidate_overlay`; timeline/replies/corrections/transcripts/run-deep → `candidate_working_files.workspace`. Optimistic in the UI.
- Each candidate has one living `.md` working file in `candidate_working_files.content`; **Save correction & re-analyze / Save transcript & analyze / Run deep analysis** call Claude (server-side, Clerk-gated, resilient) to re-derive the decision read and write it back.
- Connectors are preserved under `src/lib/` and `src/app/api/`; the previous scoring-centric UI/docs live in `archive/`.
- Keep the build Vercel-deployable on `main` (Clerk env-driven, no hardcoded secrets).

**Meta**

- `using-agent-skills.md` — Map incoming work to the right skill and shared operating rules

**Define**

- `interview-me.md` — One-question-at-a-time interview to extract real requirements
- `idea-refine.md` — Divergent/convergent thinking to turn vague ideas into proposals
- `spec-driven-development.md` — Write a PRD before any code

**Plan**

- `planning-and-task-breakdown.md` — Decompose specs into small, verifiable tasks

**Build**

- `incremental-implementation.md` — Thin vertical slices; implement, test, verify, commit
- `test-driven-development.md` — Red-Green-Refactor, test pyramid, Prove-It pattern
- `context-engineering.md` — Feed agents the right context at the right time
- `source-driven-development.md` — Ground framework decisions in official docs
- `doubt-driven-development.md` — Adversarial fresh-context review of risky decisions
- `frontend-ui-engineering.md` — Component architecture, design systems, WCAG 2.1 AA
- `api-and-interface-design.md` — Contract-first design, boundary validation

**Verify**

- `browser-testing-with-devtools.md` — Chrome DevTools MCP for live runtime data
- `debugging-and-error-recovery.md` — Five-step triage: reproduce, localize, reduce, fix, guard

**Review**

- `code-review-and-quality.md` — Five-axis review, change sizing, severity labels
- `code-simplification.md` — Chesterton's Fence, reduce complexity, preserve behavior
- `security-and-hardening.md` — OWASP Top 10, auth, secrets, dependency auditing
- `performance-optimization.md` — Measure-first; Core Web Vitals, profiling, bundles

**Ship**

- `git-workflow-and-versioning.md` — Trunk-based development, atomic commits
- `ci-cd-and-automation.md` — Shift Left, feature flags, quality gate pipelines
- `deprecation-and-migration.md` — Code-as-liability, migration patterns, zombie removal
- `documentation-and-adrs.md` — Architecture Decision Records, document the *why*
- `observability-and-instrumentation.md` — Structured logging, RED metrics, tracing
- `shipping-and-launch.md` — Pre-launch checklists, staged rollouts, rollback

Supabase agent skills (`.agents/skills/`):

- `supabase` — Supabase CLI, MCP, migrations, auth, RLS
- `supabase-postgres-best-practices` — Postgres performance and schema guidance

## Stack

- Next.js 16 App Router on Vercel
- Clerk for authentication (Marketplace integration)
- Supabase for Postgres + storage
- Workable SPI v3 for ATS sync

## Auth

All app routes require Clerk login. Webhooks (`/api/hooks/*`) and cron (`/api/cron/*`) stay public with their own secrets.

## Cursor Cloud specific instructions

- Node 22 + npm; install with `npm install`. Standard commands live in `package.json`: `npm run dev` (Next 16 + Turbopack on `http://localhost:3000`), `npm run build`, `npm run typecheck`, `npm run lint`, `npm run db:migrate`.
- No secrets are needed to boot the app. `src/lib/env.ts` makes every env var optional/defaulted, and Clerk runs in **keyless mode** in dev when `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`/`CLERK_SECRET_KEY` are unset (a "You are running in keyless mode" line prints in the dev log). Supabase, Anthropic, and Workable are all feature-gated (`hasSupabase()`, `hasAnthropic()`, `hasWorkable()`) and degrade gracefully — no crash when unset.
- Without Clerk keys, protected routes are not usable (auth-gated `/` returns 404 in keyless mode, not a redirect). To verify/develop UI without any secrets, use the **public preview harness**: `/preview/pool` renders the real `PoolTable` component with synthetic mock data (search, decision filter pills, row selection, column sorting all work), and `/preview/workflow` embeds a static pipeline mock. `GET /api/health` (public) reports integration status.
- To develop against real data you need Clerk keys (to log in) **and** Supabase (`SUPABASE_URL` + `SUPABASE_SERVICE_KEY`) with migrations applied via `npm run db:migrate` (needs `DATABASE_URL`/`SUPABASE_DB_URL`); add `ANTHROPIC_API_KEY` to exercise the Claude re-derive. With Clerk but no Supabase, the pool loads empty with a "Not connected" health state.
- `typecheck` is the reliable type gate. `npm run lint` currently crashes with `TypeError: Converting circular structure to JSON` from `FlatCompat` in `eslint.config.mjs` (an `eslint-config-next@16` / ESLint 9 flat-config-compat incompatibility) — this is pre-existing and unrelated to app code.
- The `middleware` file convention logs a deprecation warning (Next 16 prefers `proxy`); harmless.
