-- In-app invitations — emails granted access to RDIRecruit. Additive to the
-- APP_ALLOWED_EMAILS env allowlist: when the allowlist is enforced, middleware
-- lets a signed-in user through if their email is in the env list OR here.
-- Rows are written by the in-app "Invite" flow (src/app/actions/invites.ts).

create table if not exists app_users (
  email      text primary key,
  invited_by text,
  created_at timestamptz default now()
);

alter table app_users enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'app_users'
      and policyname = 'service_role_all_app_users'
  ) then
    create policy "service_role_all_app_users" on app_users
      for all using (true) with check (true);
  end if;
end $$;
