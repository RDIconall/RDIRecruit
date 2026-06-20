-- Talent Radar: sourcing, enrichment, scoring, and outreach for target roles.
-- ADDITIVE ONLY: all new tables, no destructive DDL on existing data.
--
-- This is a SHARED contacts + outreach core. A single person (radar_contacts row)
-- can belong to more than one pipeline at once via `pipeline text[]`:
--   - 'recruiting' = a candidate for a target hire (e.g. Clinical Ops Lead)
--   - 'bd'         = a business-development / partnership contact
-- That overlap is intentional: BD outreach and recruiting profiles are the same
-- underlying people, sourced and contacted the same way. Scoring is per-scorecard
-- so the same contact can be graded against the recruiting scorecard AND a BD one.
--
-- IMPORTANT (consent / compliance, see AGENTS.md + product spec):
--   - We do NOT scrape. Rows arrive only from permitted APIs (Seamless/Apollo) or
--     manual CSV/exported lists. `source` records provenance on every row.
--   - `opt_out` + opt-out tracking gate all outbound. A contact that opted out is
--     never eligible for a new outreach send.

-- ---------------------------------------------------------------------------
-- radar_searches: a saved set of target-role criteria the user searches against
-- ---------------------------------------------------------------------------
create table if not exists radar_searches (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  pipeline    text not null default 'recruiting', -- 'recruiting' | 'bd'
  -- criteria jsonb: { titles[], keywords[], companies[], locations[],
  --   relocation_allowed bool, must_have[], exclude[] }
  criteria    jsonb not null default '{}'::jsonb,
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- radar_scorecards: the private RDI scorecard a pipeline is graded against
-- ---------------------------------------------------------------------------
-- One active scorecard per pipeline. `content` is the markdown the LLM grades by;
-- `dimensions` lists the scored dimension keys/labels for the UI.
create table if not exists radar_scorecards (
  id          uuid primary key default gen_random_uuid(),
  pipeline    text not null default 'recruiting',
  name        text not null,
  content     text not null,
  dimensions  jsonb not null default '[]'::jsonb,
  active      boolean not null default true,
  updated_by  text,
  updated_at  timestamptz not null default now()
);
create index if not exists idx_radar_scorecards_active on radar_scorecards(pipeline, active);

-- ---------------------------------------------------------------------------
-- radar_contacts: the unified person record (candidate AND/OR BD contact)
-- ---------------------------------------------------------------------------
create table if not exists radar_contacts (
  id              uuid primary key default gen_random_uuid(),
  search_id       uuid references radar_searches(id) on delete set null,
  pipeline        text[] not null default '{recruiting}',
  full_name       text,
  first_name      text,
  last_name       text,
  title           text,
  company         text,
  location        text,
  linkedin_url    text,
  email           text,
  phone           text,
  -- where this row came from: e.g. 'Apollo', 'Seamless.AI', 'CSV: Sales Navigator',
  -- 'Clay', 'Manual'. Never blank — provenance is required.
  source          text not null default 'Manual',
  profile_summary text,
  raw             jsonb not null default '{}'::jsonb,
  -- enrichment / deliverability
  email_status    text not null default 'unknown', -- unknown|valid|risky|invalid|bounced
  -- consent / compliance
  consent_status  text not null default 'unknown', -- unknown|implied|explicit|withdrawn
  opt_out         boolean not null default false,
  opt_out_at      timestamptz,
  opt_out_reason  text,
  -- ownership: the recruiter / BD owner responsible for this person
  owner           text,
  -- dedupe: lowercased email, else linkedin slug, else name|company
  dedupe_key      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists uq_radar_contacts_dedupe on radar_contacts(dedupe_key) where dedupe_key is not null;
create index if not exists idx_radar_contacts_search on radar_contacts(search_id);
create index if not exists idx_radar_contacts_owner on radar_contacts(owner);
create index if not exists idx_radar_contacts_pipeline on radar_contacts using gin(pipeline);

-- ---------------------------------------------------------------------------
-- radar_scores: LLM scorecard result for a contact (per scorecard/pipeline)
-- ---------------------------------------------------------------------------
create table if not exists radar_scores (
  id                uuid primary key default gen_random_uuid(),
  contact_id        uuid not null references radar_contacts(id) on delete cascade,
  pipeline          text not null default 'recruiting',
  scorecard_name    text,
  -- dimensions jsonb: [{ key, label, score (1-5), rationale, is_risk bool }]
  dimensions        jsonb not null default '[]'::jsonb,
  overall           numeric,            -- weighted 1-5 (audit/ranking only)
  recommendation    text,               -- short verdict label
  summary           text,
  strongest_signal  text,
  biggest_concern   text,
  next_action       text,
  model             text,
  created_at        timestamptz not null default now()
);
create index if not exists idx_radar_scores_contact on radar_scores(contact_id, created_at desc);

-- ---------------------------------------------------------------------------
-- radar_outreach: one row per drafted/sent message + its tracking state
-- ---------------------------------------------------------------------------
create table if not exists radar_outreach (
  id                uuid primary key default gen_random_uuid(),
  contact_id        uuid not null references radar_contacts(id) on delete cascade,
  pipeline          text not null default 'recruiting',
  channel           text not null default 'email', -- email | linkedin
  -- not_started | drafted | sent | replied | bounced | opted_out | no_response | meeting
  status            text not null default 'drafted',
  owner             text,
  subject           text,
  body              text,
  last_contact_date date,
  next_follow_up_date date,
  response          text,
  -- per-message unsubscribe token embedded in outbound email footer
  unsubscribe_token uuid not null default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_radar_outreach_contact on radar_outreach(contact_id, created_at desc);
create unique index if not exists uq_radar_outreach_unsub on radar_outreach(unsubscribe_token);
create index if not exists idx_radar_outreach_followup on radar_outreach(next_follow_up_date) where status not in ('opted_out','replied','meeting');

-- ---------------------------------------------------------------------------
-- radar_import_batches: provenance for each CSV/manual import
-- ---------------------------------------------------------------------------
create table if not exists radar_import_batches (
  id           uuid primary key default gen_random_uuid(),
  filename     text,
  source       text not null default 'CSV',
  pipeline     text not null default 'recruiting',
  row_count    integer not null default 0,
  inserted     integer not null default 0,
  duplicates   integer not null default 0,
  imported_by  text,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RLS: service-role only, mirroring candidate_working_files / activity (009/011)
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'radar_searches','radar_scorecards','radar_contacts',
    'radar_scores','radar_outreach','radar_import_batches'
  ] loop
    execute format('alter table %I enable row level security;', t);
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t
        and policyname = 'service_role_all_' || t
    ) then
      execute format(
        'create policy %I on %I for all using (true) with check (true);',
        'service_role_all_' || t, t
      );
    end if;
  end loop;
end $$;
