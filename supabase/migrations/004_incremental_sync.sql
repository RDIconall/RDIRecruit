-- Incremental Workable sync: cursors, change detection, richer job cache

create table if not exists sync_state (
  key         text primary key,
  value       jsonb not null default '{}',
  updated_at  timestamptz not null default now()
);

alter table jobs
  add column if not exists department text,
  add column if not exists location text,
  add column if not exists raw jsonb,
  add column if not exists workable_updated_at timestamptz;

alter table candidates
  add column if not exists workable_updated_at timestamptz,
  add column if not exists analysis_hash text;

create index if not exists idx_candidates_job_updated
  on candidates (job_shortcode, workable_updated_at desc);

create index if not exists idx_candidates_analysis_hash
  on candidates (analysis_hash);

insert into sync_state (key, value)
values ('workable_events', '{"since": null}'::jsonb)
on conflict (key) do nothing;
