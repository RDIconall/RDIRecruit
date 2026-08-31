-- Forward-only safety net for environments that may have applied an earlier
-- draft of the canonical-analysis migration before its lifecycle hardening.
alter table if exists public.candidate_analyses
  add column if not exists projection_started_at timestamptz,
  add column if not exists projected_at timestamptz;

alter table if exists public.claude_batches
  add column if not exists expires_at timestamptz;

alter table if exists public.candidate_analyses
  drop constraint if exists candidate_analyses_status_check;
alter table if exists public.candidate_analyses
  add constraint candidate_analyses_status_check
  check (status in (
    'pending', 'submitted', 'processing', 'completed',
    'failed', 'obsolete', 'uncertain'
  ));

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
