-- The app talks to Postgres only through the service key, server-side. Several
-- tables (score_inputs, scores, ro_assessments, ...) were created without RLS,
-- and the "service_role_all_*" policies in 002/009/011/013 are `using (true)`
-- for every role. Supabase's init grants anon/authenticated full privileges on
-- new public tables, so all of them were readable and writable through the
-- Data API with the anon key.
--
-- Lock every public table to the service role: enable RLS and revoke the Data
-- API roles' privileges. service_role bypasses RLS and keeps its grants.

do $$
declare t text;
begin
  for t in
    select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('revoke all on public.%I from anon, authenticated;', t);
  end loop;
end $$;

revoke all on all sequences in schema public from anon, authenticated;

-- Tables created by later migrations start without Data API access.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
