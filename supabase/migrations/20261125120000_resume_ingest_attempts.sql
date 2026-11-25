-- Résumé ingest attempt tracking.
--
-- resume_storage_path is only written after a successful ingest, so a résumé that
-- fails (or kills the function) every time was retried by the backfill cron, the
-- recapture job and readiness repair on every pass. The attempt counter is bumped
-- before each download and reset on success; after a few failures the résumé is
-- paused for a cooldown instead of being re-downloaded and re-parsed forever.

alter table applications add column if not exists resume_ingest_attempts integer not null default 0;
alter table applications add column if not exists resume_ingest_attempted_at timestamptz;
alter table applications add column if not exists resume_ingest_error text;
