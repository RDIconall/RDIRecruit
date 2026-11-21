-- The pool board now reads only small keys from candidate_working_files.workspace
-- (never the corrections, transcript, replies, timeline edits, or chat), so the
-- reviewer signal it derives from the latest correction is kept in its own
-- compact key, workspace.reviewerSignal. New corrections write it; this copies it
-- once from the latest reviewer-attributed correction already on file.
-- ADDITIVE ONLY: adds one key to rows that lack it; nothing else is changed.

with latest as (
  select distinct on (f.candidate_id)
    f.candidate_id,
    e.c
  from candidate_working_files f
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(f.workspace -> 'corrections') = 'array'
      then f.workspace -> 'corrections'
      else '[]'::jsonb
    end
  ) with ordinality as e(c, ord)
  where jsonb_typeof(e.c) = 'object'
    and coalesce(e.c ->> 'reviewerKind', '') <> ''
    and not (f.workspace ? 'reviewerSignal')
  order by f.candidate_id, e.ord desc
)
update candidate_working_files w
set workspace = w.workspace || jsonb_build_object(
  'reviewerSignal',
  jsonb_strip_nulls(jsonb_build_object(
    'kind', latest.c ->> 'reviewerKind',
    'label', latest.c ->> 'reviewerLabel',
    'note', left(coalesce(latest.c ->> 'text', ''), 200),
    'ts', coalesce(latest.c ->> 'ts', '')
  ))
)
from latest
where w.candidate_id = latest.candidate_id;
