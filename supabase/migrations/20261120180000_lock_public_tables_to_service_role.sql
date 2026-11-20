-- Close the Supabase Data API (PostgREST) on every app table.
--
-- The app only talks to Postgres through the service-role client
-- (src/lib/supabase/server.ts getServiceSupabase), which bypasses RLS. The
-- anon and authenticated roles inherited full table privileges from the
-- platform's default grants, and several tables (scores, jobs, rubrics,
-- score_inputs, ro_assessments, notifications, sync_state, calibration, ...)
-- had no RLS at all, so anyone holding the public anon key could read and
-- rewrite applicant grades. Others relied on `using (true)` policies that
-- apply to every role.
--
-- No Data API policy is added on purpose: with RLS on and no policy for
-- anon/authenticated, those roles see nothing even if a grant reappears.

do $$
declare
  t record;
begin
  for t in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r', 'p')
  loop
    execute format('alter table public.%I enable row level security', t.relname);
    execute format('revoke all on table public.%I from anon, authenticated', t.relname);
  end loop;
end $$;

revoke all on all sequences in schema public from anon, authenticated;

-- Existing "service_role_all_*" policies were created without a role, so they
-- applied to anon/authenticated too. Pin them to service_role.
do $$
declare
  p record;
begin
  for p in
    select policyname, tablename
      from pg_policies
     where schemaname = 'public'
       and roles && array['public', 'anon', 'authenticated']::name[]
  loop
    execute format(
      'alter policy %I on public.%I to service_role',
      p.policyname, p.tablename
    );
  end loop;
end $$;

revoke all on function public.try_acquire_scoring_lock(int)
  from public, anon, authenticated;
grant execute on function public.try_acquire_scoring_lock(int) to service_role;

revoke all on function public.release_scoring_lock()
  from public, anon, authenticated;
grant execute on function public.release_scoring_lock() to service_role;

-- Tables, sequences, and functions created by later migrations (run as the
-- same role) must not be handed to the Data API roles again.
alter default privileges in schema public
  revoke all on tables from anon, authenticated;
alter default privileges in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges in schema public
  revoke all on functions from anon, authenticated;
-- PUBLIC's EXECUTE default is global; a schema-scoped revoke cannot remove it.
alter default privileges revoke execute on functions from public;
