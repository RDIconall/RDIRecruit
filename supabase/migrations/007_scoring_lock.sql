-- Atomic advisory-style lock for the bulk scoring pass.
-- The 10-minute reconcile cron, a manual sync, and webhook-driven scoring can all
-- race; a read-then-write guard in app code is not atomic, so two passes can both
-- proceed and re-score the same candidates, producing duplicate scores. This claim
-- is a single statement (insert-on-conflict with a staleness WHERE) so exactly one
-- caller can hold the lock at a time. TTL guards against a crashed/timed-out holder.

create or replace function public.try_acquire_scoring_lock(ttl_minutes int default 6)
returns boolean
language plpgsql
as $$
declare
  claimed boolean := false;
begin
  insert into public.sync_state(key, value, updated_at)
  values (
    'scoring_lock',
    jsonb_build_object('at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    now()
  )
  on conflict (key) do update
    set value = excluded.value, updated_at = excluded.updated_at
    where (public.sync_state.value->>'at') is null
       or (public.sync_state.value->>'at')::timestamptz < now() - make_interval(mins => ttl_minutes)
  returning true into claimed;
  return coalesce(claimed, false);
end;
$$;

create or replace function public.release_scoring_lock()
returns void
language sql
as $$
  update public.sync_state
     set value = jsonb_build_object('at', null), updated_at = now()
   where key = 'scoring_lock';
$$;
