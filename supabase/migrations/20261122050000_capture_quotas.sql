-- Caps on interview captures: pasted transcripts, VideoAsk answers, Fireflies
-- posts, and activity-log entries. ADDITIVE ONLY.
--
-- The app checks these caps before inserting (src/lib/capture-limits.ts). The
-- triggers below repeat the check under an advisory lock on the counted key so
-- parallel requests cannot each see room under the cap. Keep the numbers here
-- in sync with MAX_CAPTURES and the *_QUOTA_WINDOW_MS constants.
--
--  * A signed-in account (created_by) may add 40 interview-evidence rows per
--    24 hours and 40 activity rows per hour.
--  * Webhook captures (no account) are capped at 40 rows per applicant per
--    source (fireflies, async_video).

alter table evidence add column if not exists created_by text;
alter table activity add column if not exists created_by text;

create index if not exists idx_evidence_created_by
  on evidence (created_by, created_at) where created_by is not null;
create index if not exists idx_activity_created_by
  on activity (created_by, created_at) where created_by is not null;
create index if not exists idx_evidence_candidate_source
  on evidence (candidate_id, source_type);

create or replace function enforce_evidence_capture_quota() returns trigger
language plpgsql
as $$
declare
  existing integer;
begin
  if new.created_by is not null then
    perform pg_advisory_xact_lock(hashtext('capture:evidence:account:' || new.created_by));
    select count(*) into existing
      from evidence
      where created_by = new.created_by
        and created_at >= now() - interval '24 hours';
  elsif new.source_type in ('fireflies', 'async_video') then
    perform pg_advisory_xact_lock(
      hashtext('capture:evidence:candidate:' || coalesce(new.candidate_id, '') || ':' || new.source_type)
    );
    select count(*) into existing
      from evidence
      where candidate_id = new.candidate_id
        and source_type = new.source_type;
  else
    return new;
  end if;

  if existing >= 40 then
    raise exception 'capture_quota_exceeded';
  end if;
  return new;
end;
$$;

create or replace function enforce_activity_capture_quota() returns trigger
language plpgsql
as $$
declare
  existing integer;
begin
  if new.created_by is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext('capture:activity:account:' || new.created_by));
  select count(*) into existing
    from activity
    where created_by = new.created_by
      and created_at >= now() - interval '1 hour';

  if existing >= 40 then
    raise exception 'capture_quota_exceeded';
  end if;
  return new;
end;
$$;

drop trigger if exists evidence_capture_quota on evidence;
create trigger evidence_capture_quota
  before insert on evidence
  for each row execute function enforce_evidence_capture_quota();

drop trigger if exists activity_capture_quota on activity;
create trigger activity_capture_quota
  before insert on activity
  for each row execute function enforce_activity_capture_quota();
