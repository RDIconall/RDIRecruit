-- Interview evidence: an optional human label / round for each evidence row
-- (e.g. "Phone screen", "Onsite 1", "VideoAsk answers"). Lets a candidate carry
-- multiple distinct interviews — each its own row — that stay legible in the UI.

alter table evidence
  add column if not exists label text;
