-- Talent Radar: remember the provider's own record id for each sourced contact.
--
-- Both Seamless and Apollo return contact details (email, phone) only from a
-- SECOND, credit-consuming call keyed on an id from the search response
-- (Seamless `searchResultId`, Apollo person `id`). Without persisting that id a
-- sourced contact can never be enriched after the search request ends, which is
-- why sourced rows had no email addresses and outreach had nothing to send to.
--
-- ADDITIVE ONLY: new nullable column plus a partial index.
alter table radar_contacts
  add column if not exists provider_ref text;

-- Enrichment sweeps look for "sourced from a provider, still no email".
create index if not exists idx_radar_contacts_provider_ref
  on radar_contacts (provider_ref)
  where provider_ref is not null;

create index if not exists idx_radar_contacts_needs_email
  on radar_contacts (source)
  where email is null and provider_ref is not null and opt_out = false;
