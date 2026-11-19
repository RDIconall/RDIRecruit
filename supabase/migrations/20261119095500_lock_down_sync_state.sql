-- sync_state holds the delta-scan cursor, scoring epochs, and the scoring lock.
-- Only the service role (server-side sync) may touch it; the Data API roles get
-- no table access and cannot call the lock functions.
alter table public.sync_state enable row level security;

revoke all on public.sync_state from public, anon, authenticated;
grant all on public.sync_state to service_role;

revoke all on function public.try_acquire_scoring_lock(integer) from public, anon, authenticated;
grant execute on function public.try_acquire_scoring_lock(integer) to service_role;

revoke all on function public.release_scoring_lock() from public, anon, authenticated;
grant execute on function public.release_scoring_lock() to service_role;

-- The app now only honors scoring epochs it signed (src/lib/sync/sync-state.ts);
-- unsigned rows are ignored, so drop them rather than leave dead state behind.
delete from public.sync_state
 where key like 'scoring_epoch:%'
   and not (value ? 'sig');
