-- Comment sync timestamp + dedupe evidence by Workable activity id

alter table candidates
  add column if not exists comments_synced_at timestamptz;

create unique index if not exists idx_evidence_candidate_raw_ref
  on evidence (candidate_id, raw_ref)
  where raw_ref is not null;
