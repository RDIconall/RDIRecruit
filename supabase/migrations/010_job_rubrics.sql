-- Per-job grading rubric + role spec, editable in the triage app.
-- The rubric is the markdown a human maintains (e.g. the RDI EA grading rubric);
-- the spec is the role description (seeded from the synced Workable job description
-- when empty). Claude reads both to produce the per-candidate "rubric fit" section.
--
-- No FK to jobs(shortcode): a rubric may be authored before a job row exists, and we
-- never want a missing job mirror to block saving a rubric.
create table if not exists job_rubrics (
  job_shortcode text primary key,
  rubric_md     text,
  spec_md       text,
  updated_at    timestamptz default now(),
  updated_by    text
);
