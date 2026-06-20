-- Unify the per-job rubric + spec into a single canonical doc.
--
-- The triage app no longer maintains two separate job-level docs (rubric_md +
-- spec_md). There is now ONE "job spec & rubric" doc per job, stored in
-- rubric_md. spec_md is deprecated: the app reads/writes the unified doc from
-- rubric_md and falls back to spec_md (then the synced Workable job description)
-- at read time, so no backfill is strictly required for the app to work.
--
-- This backfill copies spec_md into rubric_md only where the unified doc is
-- still empty, so existing spec-only jobs keep their content without a code-side
-- merge. Jobs that already have rubric_md are left untouched (the read-time
-- fallback combines any leftover spec_md until the doc is next saved).
update job_rubrics
   set rubric_md = spec_md
 where coalesce(nullif(btrim(rubric_md), ''), '') = ''
   and coalesce(nullif(btrim(spec_md), ''), '') <> '';

comment on column job_rubrics.rubric_md is
  'Unified per-job "job spec & rubric" doc (markdown). Canonical doc the grader reads.';
comment on column job_rubrics.spec_md is
  'Deprecated: legacy role-spec column. Retained for read-time fallback only; no longer written by the app.';
