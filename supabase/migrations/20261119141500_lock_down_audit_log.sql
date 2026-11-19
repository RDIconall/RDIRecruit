-- audit_log records who ingested and viewed which applicant's résumé (actor,
-- candidate id, storage path). It is written only by server-side code through
-- the service key; the Data API roles must not read or rewrite it, even if the
-- project's default grants change.
alter table public.audit_log enable row level security;

revoke all on public.audit_log from public, anon, authenticated;

-- Append-only: the service role may add and read entries but never alter or
-- remove them. Maintenance that genuinely needs to prune runs as the owner.
revoke all on public.audit_log from service_role;
grant select, insert on public.audit_log to service_role;
