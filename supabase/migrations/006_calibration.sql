-- Calibration: per-job and global "learned" guidance the evaluator reads,
-- plus the raw reviewer feedback events it is distilled from.

create table if not exists public.calibration (
  id uuid primary key default gen_random_uuid(),
  scope text not null,                       -- 'global' or a job_shortcode
  version integer not null default 1,
  markdown text not null default '',
  active boolean not null default true,
  updated_at timestamptz not null default now()
);
create index if not exists calibration_scope_idx on public.calibration(scope) where active;
alter table public.calibration disable row level security;

create table if not exists public.calibration_feedback (
  id uuid primary key default gen_random_uuid(),
  candidate_id text,
  job_shortcode text,
  reviewer text,
  direction text,                            -- 'higher' | 'lower' | 'right' | 'note'
  corrected_total integer,
  note text not null default '',
  lesson text,                               -- the distilled, durable rule
  lesson_scope text,                         -- 'global' | 'role'
  created_at timestamptz not null default now()
);
create index if not exists calibration_feedback_candidate_idx on public.calibration_feedback(candidate_id);
alter table public.calibration_feedback disable row level security;

-- Permissive policies in case RLS is re-enabled by tooling and the configured
-- key is not a true service-role key.
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='calibration' and policyname='service_role_all_calibration') then
    create policy service_role_all_calibration on public.calibration for all to public using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='calibration_feedback' and policyname='service_role_all_calibration_feedback') then
    create policy service_role_all_calibration_feedback on public.calibration_feedback for all to public using (true) with check (true);
  end if;
end $$;
