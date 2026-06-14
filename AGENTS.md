# Agent guidance for RDIRecruit

This project uses [Addy Osmani's agent-skills](https://github.com/addyosmani/agent-skills) for engineering quality. Rules live in `.cursor/rules/`:

- `test-driven-development.md` — TDD and Prove-It pattern
- `code-review-and-quality.md` — Five-axis review
- `incremental-implementation.md` — Small verifiable slices
- `frontend-ui-engineering.md` — UI quality bar
- `security-and-hardening.md` — Security checklist
- `browser-testing-with-devtools.md` — Runtime verification

Follow these when building features, especially scoring, auth, and candidate PII handling.

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
