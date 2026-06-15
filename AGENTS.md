# Agent guidance for RDIRecruit

This project uses [Addy Osmani's agent-skills](https://github.com/addyosmani/agent-skills) for engineering quality. The full pack of 24 skills (23 lifecycle + 1 meta) is installed as Cursor rules in `.cursor/rules/` — each file is a verbatim copy of the upstream `skills/<name>/SKILL.md`. Provenance and content hashes are pinned in `skills-lock.json` (source `addyosmani/agent-skills`, commit `3a6fc6392823e31e2362091bd4e3cddf5b77af14`).

Follow these when building features, especially the triage decision flow, auth, and candidate PII handling.

## Product

RDIRecruit is a **candidate-triage decision tool** that protects interview time: cut weak candidates first, rank who to interview, then build a deep read only for the ones worth it. There are **no numeric scores and no tiers** — only the decision vocabulary _Interview first · Short screen · Verify first · Hold · Cut · Review blocked_. Workable stays the ATS of record.

- UI: `src/components/triage/` (`triage-app`, `pool-screen`, `candidate-screen`, `use-workspace`).
- Domain + data: `src/lib/triage/` (`types`, `data`, `theme`, `workspace`).
- Human edits persist to `localStorage` (`rdi-recruit-ws-v1`) in the prototype — wire to Supabase server-side next.
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
