-- Rate-limit slots for Claude calls started by a person in the app
-- (src/lib/ai/spend-budget.ts). A limit of N for a bucket is N rows keyed by
-- (bucket, slot). A slot is taken with an insert that is ignored on conflict, or
-- with a version compare-and-swap once reserved_until has passed, so concurrent
-- requests can never hold the same slot and a burst cannot exceed N per window.
create table if not exists public.ai_spend_slots (
  bucket text not null,
  slot integer not null check (slot > 0),
  version integer not null default 1 check (version > 0),
  reserved_until timestamptz not null,
  kind text not null,
  user_id text,
  subject text,
  updated_at timestamptz not null default now(),
  primary key (bucket, slot)
);

create index if not exists ai_spend_slots_user_idx
  on public.ai_spend_slots (user_id, updated_at desc);

-- Service-role only (the app writes with the service key); no anon/auth access.
alter table public.ai_spend_slots enable row level security;
