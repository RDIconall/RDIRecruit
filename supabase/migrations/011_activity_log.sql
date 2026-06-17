-- Per-candidate activity log — the human-authored record (HANDOFF-v2 §2).
-- ADDITIVE ONLY. The log is the system of record (Salesforce-style); the war-room
-- chat (candidate_working_files.workspace.chat) is reasoning OVER this record.
-- Interview entries carry the transcript Claude folds in on "Update assessment".

create table if not exists activity (
  id           uuid primary key default gen_random_uuid(),
  candidate_id text not null references candidates(workable_id) on delete cascade,
  type         text not null default 'note',   -- interview | note | comment
  author       text,
  body         text not null,
  created_at   timestamptz default now()
);

create index if not exists idx_activity_candidate on activity(candidate_id, created_at);

alter table activity enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'activity'
      and policyname = 'service_role_all_activity'
  ) then
    create policy "service_role_all_activity" on activity
      for all using (true) with check (true);
  end if;
end $$;
