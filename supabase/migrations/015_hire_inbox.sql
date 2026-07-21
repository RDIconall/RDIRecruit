-- Cross-job New Hires inbox with shared Read/Unread status.
-- ADDITIVE ONLY: one new table, no destructive DDL.
--
-- Rows appear when a candidate's in-app processStatus is set to 'hired'
-- (see setProcessStatus → upsertHireInbox). Leaving Hired removes the row.
-- Read is a shared team flag (not per-user), matching the legacy notifications
-- pattern used by the small hiring team.

create table if not exists hire_inbox (
  candidate_id   text primary key references candidates(workable_id) on delete cascade,
  job_shortcode  text not null references jobs(shortcode),
  hired_at       timestamptz not null default now(),
  read           boolean not null default false,
  read_at        timestamptz,
  read_by        text,
  updated_at     timestamptz not null default now()
);

create index if not exists idx_hire_inbox_unread
  on hire_inbox (read, hired_at desc);

create index if not exists idx_hire_inbox_job
  on hire_inbox (job_shortcode);

alter table hire_inbox enable row level security;

-- Service-role access only (app reads/writes via the service key server-side).
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'hire_inbox'
      and policyname = 'service_role_all_hire_inbox'
  ) then
    create policy "service_role_all_hire_inbox" on hire_inbox
      for all using (true) with check (true);
  end if;
end $$;
