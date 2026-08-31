-- One canonical Claude analysis per material version of a candidate.
--
-- The input hash includes candidate materials, interview evidence, human
-- corrections/replies, and the active method/rubric/calibration versions. A
-- duplicate webhook or repeated button press therefore reuses the same row;
-- genuinely new evidence creates exactly one new row.
create table if not exists public.candidate_analyses (
  id uuid primary key default gen_random_uuid(),
  candidate_id text not null references public.candidates(workable_id) on delete cascade,
  input_hash text not null,
  status text not null default 'pending'
    check (status in ('pending', 'submitted', 'processing', 'completed', 'failed', 'obsolete', 'uncertain')),
  trigger text not null default 'automatic',
  model text not null,
  input_snapshot jsonb not null,
  result jsonb,
  error text,
  batch_id text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  usage jsonb,
  cost_usd numeric(12, 6),
  requested_at timestamptz not null default now(),
  submitted_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  projection_started_at timestamptz,
  projected_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (candidate_id, input_hash)
);

create index if not exists candidate_analyses_pending_idx
  on public.candidate_analyses (status, requested_at)
  where status in ('pending', 'failed');

create index if not exists candidate_analyses_batch_idx
  on public.candidate_analyses (batch_id)
  where batch_id is not null;

create index if not exists candidate_analyses_candidate_completed_idx
  on public.candidate_analyses (candidate_id, completed_at desc)
  where status = 'completed';

-- Durable provider-batch lifecycle. Results can take up to 24 hours; keeping the
-- provider id in Postgres lets later Vercel cron invocations resume polling.
create table if not exists public.claude_batches (
  id text primary key,
  status text not null
    check (status in ('in_progress', 'canceling', 'ended', 'results_processed', 'failed')),
  request_count integer not null check (request_count > 0),
  request_counts jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  ended_at timestamptz,
  results_processed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists claude_batches_active_idx
  on public.claude_batches (status, created_at)
  where status in ('in_progress', 'canceling', 'ended');

alter table public.candidate_analyses
  drop constraint if exists candidate_analyses_batch_id_fkey;
alter table public.candidate_analyses
  add constraint candidate_analyses_batch_id_fkey
  foreign key (batch_id) references public.claude_batches(id) on delete set null;

alter table public.candidate_analyses enable row level security;
alter table public.claude_batches enable row level security;

-- These rows contain candidate PII and model reads. The app accesses them only
-- through the server-side service key (which bypasses RLS); explicitly keep the
-- Data API roles out even if the project's default grants change.
revoke all on public.candidate_analyses from anon, authenticated;
revoke all on public.claude_batches from anon, authenticated;

-- Atomically claim an unbatched analysis for a synchronous recruiter action.
-- Returns true only to the caller that changed pending/failed -> processing.
create or replace function public.claim_candidate_analysis(p_analysis_id uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  claimed boolean := false;
begin
  update public.candidate_analyses
     set status = 'processing',
         started_at = now(),
         updated_at = now(),
         attempt_count = attempt_count + 1,
         error = null
   where id = p_analysis_id
     and batch_id is null
     and status in ('pending', 'failed')
  returning true into claimed;
  return coalesce(claimed, false);
end;
$$;

revoke all on function public.claim_candidate_analysis(uuid) from public, anon, authenticated;
grant execute on function public.claim_candidate_analysis(uuid) to service_role;

-- Attach requests only after Anthropic accepted the batch. The existing global
-- scoring lock serializes submitters; this statement keeps the local lifecycle
-- transition and retry count atomic.
create or replace function public.attach_candidate_analyses_to_batch(
  p_batch_id text,
  p_analysis_ids uuid[]
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  attached integer := 0;
begin
  update public.candidate_analyses
     set status = 'submitted',
         batch_id = p_batch_id,
         submitted_at = now(),
         updated_at = now(),
         error = null
   where id = any(p_analysis_ids)
     and batch_id is null
     and status = 'processing';
  select count(*)::integer
    into attached
    from public.candidate_analyses
   where id = any(p_analysis_ids)
     and batch_id = p_batch_id
     and status = 'submitted';
  return attached;
end;
$$;

revoke all on function public.attach_candidate_analyses_to_batch(text, uuid[])
  from public, anon, authenticated;
grant execute on function public.attach_candidate_analyses_to_batch(text, uuid[])
  to service_role;

-- Projection is a separate, replayable side effect. Claim it atomically so
-- overlapping cron invocations cannot both delete/reinsert the compatibility
-- score rows. A stale claim can be recovered after a crashed Vercel invocation.
create or replace function public.claim_candidate_analysis_projection(
  p_analysis_id uuid,
  p_stale_minutes integer default 15
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  claimed boolean := false;
begin
  update public.candidate_analyses
     set projection_started_at = now(),
         updated_at = now()
   where id = p_analysis_id
     and status = 'completed'
     and projected_at is null
     and (
       projection_started_at is null
       or projection_started_at < now() - make_interval(mins => p_stale_minutes)
     )
  returning true into claimed;
  return coalesce(claimed, false);
end;
$$;

revoke all on function public.claim_candidate_analysis_projection(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_candidate_analysis_projection(uuid, integer)
  to service_role;
