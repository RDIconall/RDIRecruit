# New Hires Inbox — Design

## Objective

Give hiring operators a **cross-job inbox of people marked Hired**, with unread/read status like email — so new hires are not missed when they land in different job pools.

Success: open `/hires`, see unread hires first (across all jobs), mark one or all read, and jump into that candidate’s triage dossier.

## Assumptions

1. **Hire signal** = in-app `processStatus === "hired"` (manual Process control), not Workable `hired_at`.
2. **Read state is shared** (team inbox), not per-Clerk-user — matches the legacy `notifications.read` pattern and fits a small hiring team.
3. **Unread by default** when someone is marked Hired; leaving Hired removes them from the inbox.
4. UI lives at **`/hires`**, parallel to `/radar`, with a top-bar link from triage.

## Approaches considered

| Approach | Pros | Cons |
|----------|------|------|
| A. Reuse `notifications` with `type=new_hire` | Existing read flag | Legacy/score-centric; payload awkward for hire summary |
| **B. Dedicated `hire_inbox` table (chosen)** | Clear ownership; hire date + read; easy reconcile | New migration |
| C. Read flag only in `workspace` JSON | No migration | Not queryable cross-job; no shared inbox |

## Architecture

```
setProcessStatus(hired) ──► upsert hire_inbox (unread)
setProcessStatus(other) ──► delete hire_inbox row
/hires loader ───────────► reconcile from working_files + list inbox
markHireRead / markAll   ──► update hire_inbox.read
UI row click ────────────► mark read + link /?job=&c=
```

### Schema (`015_hire_inbox.sql`)

- `candidate_id` PK → `candidates`
- `job_shortcode`, `hired_at`, `read`, `read_at`, `read_by`, `updated_at`
- RLS enabled; service-role policy (same as working files)

### Surfaces

- `src/lib/hires/{types,store,load}.ts` — data layer
- `src/app/actions/hires.ts` — mark read / unread / all read
- `src/app/hires/page.tsx` + `src/components/hires/hires-app.tsx` — inbox UI
- Hook in `setProcessStatus`; deep link `/?job=&c=` on triage home

## Boundaries

- **Always:** Clerk-gated routes; no numeric scores/tiers in UI; service-role DB access only.
- **Ask first:** Per-user read receipts; Workable `hired_at` auto-ingest; email digests of new hires.
- **Never:** Hardcoded secrets; client-side service key; cards/dashboard chrome that fights the existing triage visual system.

## Commands

```
npm run typecheck
npm run lint
npm run build
npm run db:migrate   # applies 015_hire_inbox.sql when DATABASE_URL is set
```
