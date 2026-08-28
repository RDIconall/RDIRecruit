import assert from "node:assert/strict";
import { dedupeKey, normalizeContact } from "./normalize";
import { splitLocationTerms } from "./providers/locations";

// ---------------------------------------------------------------------------
// Location classification.
//
// Seamless has no city filter — only contactState, contactCountry and
// contactZipCode. The planner emits a flat list of free-text place names, and
// the old code assigned all of them to contactCountry, so a search for people
// in Los Angeles sent "Los Angeles" as a country and matched nothing.
// ---------------------------------------------------------------------------

const split = splitLocationTerms(["Los Angeles", "California", "United States", "91406"]);
assert.deepEqual(split.countries, ["United States"]);
assert.deepEqual(split.states, ["California"]);
assert.deepEqual(split.cities, ["Los Angeles"]);
assert.deepEqual(split.zips, ["91406"]);

// A city must never leak into the country bucket — that is the original bug.
assert.ok(!split.countries.includes("Los Angeles"));

// Compound terms get classified part by part.
const compound = splitLocationTerms(["Van Nuys, CA, United States"]);
assert.deepEqual(compound.cities, ["Van Nuys"]);
assert.deepEqual(compound.states, ["CA"]);
assert.deepEqual(compound.countries, ["United States"]);

// State codes and full names both resolve to states.
assert.deepEqual(splitLocationTerms(["NY"]).states, ["NY"]);
assert.deepEqual(splitLocationTerms(["new york"]).states, ["new york"]);

// Duplicates collapse case-insensitively so we stay under provider maxItems.
assert.deepEqual(splitLocationTerms(["California", "california"]).states, ["California"]);

// Unrecognised terms fall back to city rather than being dropped silently.
assert.deepEqual(splitLocationTerms(["Van Nuys"]).cities, ["Van Nuys"]);

// Empty and whitespace-only terms are ignored.
const blank = splitLocationTerms(["", "   "]);
assert.equal(blank.cities.length + blank.states.length + blank.countries.length + blank.zips.length, 0);

// ---------------------------------------------------------------------------
// Dedupe keys.
//
// Provider SEARCH responses carry no email address, so without a provider-ref
// tier every re-run of the same search inserted duplicate rows for anyone whose
// name or company was missing.
// ---------------------------------------------------------------------------

// Email always wins when present.
assert.equal(
  dedupeKey({ email: "A.Person@Example.com", linkedinUrl: "https://linkedin.com/in/aperson", providerRef: "x" }),
  "email:a.person@example.com",
);

// Then the LinkedIn slug.
assert.equal(
  dedupeKey({ linkedinUrl: "https://www.linkedin.com/in/A-Person-123/", providerRef: "x", source: "Apollo" }),
  "li:a-person-123",
);

// Then the provider's own record id, namespaced per provider.
assert.equal(dedupeKey({ providerRef: "abc-123", source: "Apollo" }), "ref:apollo:abc-123");
assert.equal(dedupeKey({ providerRef: "abc-123", source: "Seamless.AI" }), "ref:seamlessai:abc-123");

// The same ref from two different providers must not collide.
assert.notEqual(
  dedupeKey({ providerRef: "abc-123", source: "Apollo" }),
  dedupeKey({ providerRef: "abc-123", source: "Seamless.AI" }),
);

// An Apollo search result has no email and an obfuscated surname. It must still
// produce a stable key, or it duplicates on every sourcing run.
const apolloSearchResult = dedupeKey({
  email: null,
  linkedinUrl: null,
  fullName: null,
  firstName: "David",
  lastName: null,
  company: "Labcorp",
  source: "Apollo",
  providerRef: "5f2b8c",
});
assert.equal(apolloSearchResult, "ref:apollo:5f2b8c");

// Two different Davids at the same company are distinct people, so the
// name|company fallback must not be what identifies provider rows.
assert.notEqual(
  dedupeKey({ firstName: "David", company: "Labcorp", source: "Apollo", providerRef: "aaa" }),
  dedupeKey({ firstName: "David", company: "Labcorp", source: "Apollo", providerRef: "bbb" }),
);

// Name|company remains the last resort (a manual add or CSV row).
assert.equal(
  dedupeKey({ fullName: "Jane Roe", company: "RDI" }),
  "nc:jane roe|rdi",
);

// Nothing identifying at all yields no key.
assert.equal(dedupeKey({}), null);

// ---------------------------------------------------------------------------
// Normalization carries the provider ref, and never invents a valid email.
// ---------------------------------------------------------------------------

const sourced = normalizeContact({
  fullName: "Ada Byron",
  title: "Clinical Operations Lead",
  company: "Assay Co",
  source: "Seamless.AI",
  providerRef: "search-result-1",
  email: null,
});
assert.equal(sourced.providerRef, "search-result-1");
assert.equal(sourced.email, null);
// No email means the status stays unknown — not "valid".
assert.equal(sourced.emailStatus, "unknown");
assert.equal(sourced.dedupeKey, "ref:seamlessai:search-result-1");

// Once enrichment supplies an email, the key becomes email-based so the row
// merges with any other source for the same person.
const enriched = normalizeContact({
  fullName: "Ada Byron",
  company: "Assay Co",
  source: "Seamless.AI",
  providerRef: "search-result-1",
  email: "Ada@AssayCo.com",
});
assert.equal(enriched.dedupeKey, "email:ada@assayco.com");
assert.equal(enriched.email, "ada@assayco.com");

// A manual entry with no provider ref still normalizes cleanly.
const manual = normalizeContact({ fullName: "Manual Person", company: "RDI", source: "Manual" });
assert.equal(manual.providerRef, null);
assert.equal(manual.dedupeKey, "nc:manual person|rdi");

console.log("radar sourcing tests passed");
