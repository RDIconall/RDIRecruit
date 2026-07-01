-- Candidate profile photo (Workable `image_url`).
--
-- Workable's LIST endpoint (/jobs/{shortcode}/candidates) OMITS `image_url`;
-- only the single-candidate endpoint returns it. The bulk mirror overwrites
-- candidates.raw wholesale from the list shape, so any captured photo was wiped
-- on the next mirror (the same class of bug as resume_url). A dedicated column
-- is the durable home: it is never null-clobbered by the mirror and is directly
-- queryable for the photo backfill.

alter table candidates add column if not exists photo_url text;

-- Backfill from any photo still present in raw (single-fetch candidates).
update candidates
set photo_url = raw->>'image_url'
where photo_url is null
  and raw->>'image_url' like 'http%';

-- Lets the photo backfill cheaply find candidates that still need a photo pulled.
create index if not exists idx_candidates_photo_missing on candidates(workable_id) where photo_url is null;
