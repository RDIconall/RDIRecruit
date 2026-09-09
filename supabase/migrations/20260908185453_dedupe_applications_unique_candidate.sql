-- applications.candidate_id was never unique. Concurrent syncs + maybeSingle()
-- failing when >1 row existed caused unbounded INSERT of the same résumé
-- (71k+ excess rows, multi‑GB TOAST). Keep one best row per candidate, then
-- enforce uniqueness so sync can upsert safely.

with ranked as (
  select
    id,
    row_number() over (
      partition by candidate_id
      order by
        (resume_text is not null and length(resume_text) > 0) desc,
        (resume_storage_path is not null) desc,
        resume_ingested_at desc nulls last,
        id desc
    ) as rn
  from applications
)
delete from applications
where id in (select id from ranked where rn > 1);

create unique index if not exists applications_candidate_id_uidx
  on applications (candidate_id);
