-- Keep the Data API roles (anon, authenticated) out of every app table.
--
-- Earlier migrations created "service_role_all_*" policies `for all using (true)
-- with check (true)` without a `to` clause. service_role bypasses RLS, so those
-- policies only ever applied to anon and authenticated, which the project's
-- default grants let read and write candidate case files, interview notes,
-- overlays, evaluations, calibration and Talent Radar rows. Several tables from
-- 001 never enabled RLS at all. The app reads and writes every table through the
-- server-side service key, so no policy is needed for it.

drop policy if exists "service_role_all_overlay" on public.candidate_overlay;
drop policy if exists "service_role_all_evaluations" on public.evaluations;
drop policy if exists service_role_all_calibration on public.calibration;
drop policy if exists service_role_all_calibration_feedback on public.calibration_feedback;
drop policy if exists "service_role_all_working_files" on public.candidate_working_files;
drop policy if exists "service_role_all_activity" on public.activity;
drop policy if exists service_role_all_radar_searches on public.radar_searches;
drop policy if exists service_role_all_radar_scorecards on public.radar_scorecards;
drop policy if exists service_role_all_radar_contacts on public.radar_contacts;
drop policy if exists service_role_all_radar_scores on public.radar_scores;
drop policy if exists service_role_all_radar_outreach on public.radar_outreach;
drop policy if exists service_role_all_radar_import_batches on public.radar_import_batches;

do $$
declare
  t text;
begin
  for t in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r', 'p')
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- Tables created later by this role must not pick up Data API grants either.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

revoke all on function public.try_acquire_scoring_lock(int) from public, anon, authenticated;
grant execute on function public.try_acquire_scoring_lock(int) to service_role;
revoke all on function public.release_scoring_lock() from public, anon, authenticated;
grant execute on function public.release_scoring_lock() to service_role;
