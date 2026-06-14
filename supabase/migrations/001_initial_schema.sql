-- RDI Hiring Layer schema (Supabase / Postgres)

create extension if not exists "pgcrypto";

create table if not exists jobs (
  shortcode        text primary key,
  workable_job_id  text,
  title            text not null,
  status           text,
  synced_at        timestamptz default now()
);

create table if not exists app_users (
  id          uuid primary key,
  name        text,
  email       text,
  role        text not null default 'recruiter'
);

create table if not exists candidates (
  workable_id      text primary key,
  job_shortcode    text references jobs(shortcode),
  name             text,
  email            text,
  phone            text,
  location         text,
  stage            text,
  stage_kind       text,
  disqualified     boolean default false,
  source           text,
  assignee_id      uuid references app_users(id),
  raw              jsonb,
  created_at       timestamptz,
  synced_at        timestamptz default now()
);

create table if not exists applications (
  id                uuid primary key default gen_random_uuid(),
  candidate_id      text references candidates(workable_id) on delete cascade,
  answers           jsonb,
  cover_letter      text,
  resume_url        text,
  parsed_experience jsonb,
  parsed_education  jsonb
);

create table if not exists rubrics (
  id               uuid primary key default gen_random_uuid(),
  job_shortcode    text references jobs(shortcode),
  version          int not null,
  name             text,
  raw_md           text not null,
  definition       jsonb not null,
  weights          jsonb not null,
  active           boolean default false,
  created_at       timestamptz default now()
);

create table if not exists scores (
  id               uuid primary key default gen_random_uuid(),
  candidate_id     text references candidates(workable_id) on delete cascade,
  rubric_version   int not null,
  category_scores  jsonb not null,
  total            int not null,
  salary_value     text,
  model_version    text,
  evidence_through uuid[],
  confidence       text,
  created_at       timestamptz default now()
);

create table if not exists score_inputs (
  id               uuid primary key default gen_random_uuid(),
  score_id         uuid references scores(id) on delete cascade,
  category         text,
  claim            text,
  source_type      text,
  source_ref       text,
  quote            text,
  capture_kind     text,
  capture_path     text,
  capture_locator  jsonb,
  capture_status   text default 'pending'
);

create table if not exists ro_assessments (
  id                   uuid primary key default gen_random_uuid(),
  candidate_id         text references candidates(workable_id) on delete cascade,
  per_role             jsonb not null,
  seat_stratum         text,
  current_capability   text,
  trajectory           text,
  text_confidence      text,
  basis                text,
  created_at           timestamptz default now()
);

create table if not exists evidence (
  id               uuid primary key default gen_random_uuid(),
  candidate_id     text references candidates(workable_id) on delete cascade,
  source_type      text not null,
  author           text,
  captured_at      timestamptz,
  raw_ref          text,
  transcript       text,
  extracted        jsonb,
  ai_likelihood    numeric,
  created_at       timestamptz default now()
);

create table if not exists narratives (
  id               uuid primary key default gen_random_uuid(),
  candidate_id     text references candidates(workable_id) on delete cascade,
  segments         jsonb not null,
  generated_at     timestamptz default now()
);

create table if not exists comms_log (
  id               uuid primary key default gen_random_uuid(),
  candidate_id     text references candidates(workable_id) on delete cascade,
  channel          text,
  direction        text,
  template         text,
  subject          text,
  body             text,
  status           text,
  workable_logged  boolean default false,
  approved_by      text,
  sent_at          timestamptz
);

create table if not exists events (
  id               uuid primary key default gen_random_uuid(),
  source           text,
  type             text,
  payload          jsonb,
  processed        boolean default false,
  received_at      timestamptz default now()
);

create table if not exists audit_log (
  id         uuid primary key default gen_random_uuid(),
  actor      text,
  action     text,
  entity     text,
  entity_id  text,
  detail     jsonb,
  at         timestamptz default now()
);

create table if not exists job_members (
  job_shortcode text references jobs(shortcode),
  user_id       uuid references app_users(id),
  role          text,
  primary key (job_shortcode, user_id)
);

create table if not exists notifications (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references app_users(id),
  type         text,
  candidate_id text references candidates(workable_id),
  channel      text,
  payload      jsonb,
  read         boolean default false,
  created_at   timestamptz default now(),
  sent_at      timestamptz
);

create index if not exists idx_candidates_job on candidates(job_shortcode);
create index if not exists idx_scores_candidate on scores(candidate_id, created_at desc);
create index if not exists idx_evidence_candidate on evidence(candidate_id);
create index if not exists idx_events_unprocessed on events(processed) where processed = false;

alter table candidates enable row level security;
alter table applications enable row level security;
alter table evidence enable row level security;
alter table comms_log enable row level security;
alter table narratives enable row level security;
