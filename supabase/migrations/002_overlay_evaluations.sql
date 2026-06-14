-- Overlay, evaluations, storage, and indexes (spec/RDIRecruit_Build_Spec.md §1)

create table if not exists candidate_overlay (
  candidate_id       text primary key references candidates(workable_id) on delete cascade,
  status             text not null default 'active',
  status_reason      text,
  complement         text,
  complement_removes text,
  salary_vector      text,
  updated_by         text,
  updated_at         timestamptz default now()
);

create table if not exists evaluations (
  id               uuid primary key default gen_random_uuid(),
  candidate_id     text references candidates(workable_id) on delete cascade,
  kind             text not null,
  ref              text,
  payload          jsonb not null,
  model_version    text,
  rubric_version   int,
  evidence_through uuid[],
  created_at       timestamptz default now()
);

create index if not exists idx_evaluations_candidate_kind on evaluations(candidate_id, kind);

alter table jobs add column if not exists department text;
alter table jobs add column if not exists seat_stratum text;
alter table jobs add column if not exists rubric_weights text;

insert into storage.buckets (id, name, public)
values ('captures', 'captures', false)
on conflict (id) do nothing;

alter table candidate_overlay enable row level security;
alter table evaluations enable row level security;

create policy "service_role_all_overlay" on candidate_overlay
  for all using (true) with check (true);

create policy "service_role_all_evaluations" on evaluations
  for all using (true) with check (true);
