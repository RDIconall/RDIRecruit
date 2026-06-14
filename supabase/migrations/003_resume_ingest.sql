-- Résumé ingest columns (spec §5, §9a)

alter table applications add column if not exists resume_storage_path text;
alter table applications add column if not exists resume_mime text;
alter table applications add column if not exists resume_text text;
alter table applications add column if not exists resume_parsed jsonb;
alter table applications add column if not exists resume_ingested_at timestamptz;
alter table applications add column if not exists resume_source_hash text;

create index if not exists idx_applications_resume_hash on applications(resume_source_hash);
