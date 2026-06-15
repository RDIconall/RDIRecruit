-- Per-candidate living markdown working file + persisted human triage edits.
-- ADDITIVE ONLY: creates one new table, no destructive DDL on existing data.
--
-- "One candidate = one living case file." This table stores:
--   - content:   the rendered markdown working file (the .md the UI downloads)
--   - read:      Claude's re-derived decision read (decision vocabulary only — no
--                numeric scores: { decision, why, risk, next, timelineNote, flags })
--   - workspace: human triage edits that don't belong on candidate_overlay —
--                timeline overrides, comment replies, corrections log, transcripts,
--                and the run-deep flag. (Disqualify still lives on candidate_overlay.)

create table if not exists candidate_working_files (
  candidate_id text primary key references candidates(workable_id) on delete cascade,
  content      text,
  read         jsonb,
  workspace    jsonb not null default '{}'::jsonb,
  updated_at   timestamptz default now(),
  updated_by   text
);

alter table candidate_working_files enable row level security;

-- Service-role access only (the app reads/writes via the service key server-side,
-- mirroring candidate_overlay / evaluations policies in migration 002).
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'candidate_working_files'
      and policyname = 'service_role_all_working_files'
  ) then
    create policy "service_role_all_working_files" on candidate_working_files
      for all using (true) with check (true);
  end if;
end $$;
