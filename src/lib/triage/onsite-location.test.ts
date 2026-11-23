/**
 * Applicant-controlled Workable addresses must not be described as near the
 * Van Nuys office, or as US-based, unless the address actually supports that.
 *
 * These tests fail while location text is classified by a substring / trailing
 * two-letter match. They are the spec for the fix.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { CandidateRow } from "../types";
import type { DecisionRead } from "./types";

process.env.WORKABLE_TOKEN = "placeholder-workable-token";
process.env.WORKABLE_SUBDOMAIN = "example";
process.env.SUPABASE_URL = "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_KEY = "placeholder-service-key";
delete process.env.WORKABLE_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

interface StructuredLocation {
  location_str?: string;
  country?: string;
  country_code?: string;
  region?: string;
  region_code?: string;
  city?: string;
  zip_code?: string;
}

interface AppliedAddress {
  /** Free-text address an applicant can type on a public Workable posting. */
  address: string;
  /** Parsed location object returned by the single-candidate endpoint, when present. */
  location?: StructuredLocation;
  /** "show" uses GET /jobs/{shortcode}/candidates/{id}. "list" uses the mirror list. */
  via: "show" | "list";
}

interface StoredCandidate {
  location: unknown;
  source: unknown;
  raw: Record<string, unknown> | null;
  row: Record<string, unknown>;
}

let modulesPromise: Promise<{
  getCandidate: typeof import("../workable/client").getCandidate;
  upsertCandidateFromWorkable: typeof import("../sync/workable-sync").upsertCandidateFromWorkable;
  syncChangedCandidatesForJob: typeof import("../sync/workable-sync").syncChangedCandidatesForJob;
  mapCandidate: typeof import("./from-supabase").mapCandidate;
}> | null = null;

function loadModules() {
  modulesPromise ??= Promise.all([
    import("../workable/client"),
    import("../sync/workable-sync"),
    import("./from-supabase"),
  ]).then(([workable, sync, triage]) => ({
    getCandidate: workable.getCandidate,
    upsertCandidateFromWorkable: sync.upsertCandidateFromWorkable,
    syncChangedCandidatesForJob: sync.syncChangedCandidatesForJob,
    mapCandidate: triage.mapCandidate,
  }));
  return modulesPromise;
}

function appliedCandidate(id: string, address: string, location?: StructuredLocation) {
  return {
    id,
    name: "Applicant Example",
    firstname: "Applicant",
    lastname: "Example",
    headline: "",
    account: { subdomain: "example", name: "Example" },
    job: { shortcode: "JOB1", title: "Executive Assistant" },
    stage: "applied",
    disqualified: false,
    disqualification_reason: null,
    hired_at: null,
    sourced: false,
    profile_url: "https://example.workable.com/backend/jobs/1/candidates/1",
    address,
    phone: "",
    email: "applicant@example.com",
    created_at: "2026-01-15T00:00:00.000Z",
    updated_at: "2026-01-16T00:00:00.000Z",
    ...(location ? { location } : {}),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Network stand-in for the two HTTP boundaries the product actually calls.
 * Workable responses use the documented candidate envelope. Supabase responses
 * are empty successes so the real client can finish the upsert it already built.
 */
async function withBoundary(
  candidate: ReturnType<typeof appliedCandidate>,
  captures: Record<string, unknown>[],
  run: () => Promise<void>,
) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname.endsWith(".workable.com")) {
      const parts = url.pathname.split("/").filter(Boolean);
      const at = parts.indexOf("candidates");
      const next = at >= 0 ? parts[at + 1] : undefined;
      if (next && next !== "activities") {
        return jsonResponse({ candidate });
      }
      if (at >= 0 && !next) {
        return jsonResponse({ candidates: [candidate], paging: { next: null } });
      }
      throw new Error(`unexpected Workable path ${url.pathname}`);
    }
    if (url.hostname === "127.0.0.1" && url.pathname.includes("/candidates")) {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && init?.body) {
        captures.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      }
      return jsonResponse([]);
    }
    if (url.hostname === "127.0.0.1") return jsonResponse([]);
    throw new Error(`unexpected host ${url.hostname}`);
  };
  try {
    await run();
  } finally {
    globalThis.fetch = previous;
  }
}

async function storeAppliedAddress(input: AppliedAddress): Promise<StoredCandidate> {
  const mods = await loadModules();
  const id = `applied_${input.via}_${Buffer.from(input.address).toString("hex").slice(0, 24)}`;
  const candidate = appliedCandidate(id, input.address, input.location);
  const captures: Record<string, unknown>[] = [];
  await withBoundary(candidate, captures, async () => {
    if (input.via === "show") {
      const fetched = await mods.getCandidate("JOB1", id);
      assert.equal(fetched.address, input.address);
      assert.equal(fetched.sourced, false);
      const result = await mods.upsertCandidateFromWorkable(fetched, "JOB1", {
        analyze: false,
        syncComments: false,
      });
      assert.equal(result.skipped, false);
      assert.equal(result.metadataUpdated, true);
    } else {
      const result = await mods.syncChangedCandidatesForJob("JOB1");
      assert.equal(result.failed, 0);
      assert.equal(result.changed, 1);
    }
  });
  const row = captures.find((item) => item.workable_id === id);
  assert.ok(row, `candidate upsert did not store ${input.address}`);
  assert.equal(row.location, input.address);
  assert.equal(row.source, "applied");
  const raw = (row.raw ?? null) as Record<string, unknown> | null;
  assert.equal(raw?.address, input.address);
  return { location: row.location, source: row.source, raw, row };
}

function candidateRow(stored: StoredCandidate, location: string | null): CandidateRow {
  const row = stored.row;
  return {
    workable_id: String(row.workable_id),
    job_shortcode: String(row.job_shortcode),
    name: (row.name as string) ?? null,
    email: (row.email as string) ?? null,
    phone: (row.phone as string) ?? null,
    location,
    stage: (row.stage as string) ?? null,
    stage_kind: null,
    disqualified: Boolean(row.disqualified),
    source: (row.source as string) ?? null,
    assignee_id: null,
    raw: stored.raw,
    photo_url: (row.photo_url as string) ?? null,
    created_at: (row.created_at as string) ?? null,
    synced_at: String(row.synced_at),
  };
}

async function dossierFor(stored: StoredCandidate, location: string | null, read: DecisionRead | null = null) {
  const { mapCandidate } = await loadModules();
  return mapCandidate({
    candidate: candidateRow(stored, location),
    score: null,
    ro: null,
    overlay: null,
    application: null,
    narrative: [],
    evals: {
      invest: null,
      dig: null,
      verification: null,
      roleReads: [],
      answerGrades: [],
      fitRead: null,
    },
    interviewEvidence: [],
    read,
    rank: 1,
    jobLocation: "Van Nuys, CA",
    jobShortcode: "JOB1",
  });
}

function assertNotUsOnsite(read: string, likelihood: string, label: string) {
  assert.notEqual(likelihood, "High", label);
  assert.notEqual(likelihood, "Medium", label);
  assert.doesNotMatch(read, /in or near California/, label);
  assert.doesNotMatch(read, /on-site ask is realistic/, label);
  assert.doesNotMatch(read, /US-based/, label);
}

function assertCalifornia(read: string, likelihood: string, label: string) {
  assert.equal(likelihood, "High", label);
  assert.match(read, /in or near California/, label);
  assert.match(read, /on-site ask is realistic/, label);
  assert.doesNotMatch(read, /US-based but outside California/, label);
}

function assertUsOutsideCalifornia(read: string, likelihood: string, label: string) {
  assert.equal(likelihood, "Medium", label);
  assert.match(read, /US-based but outside California/, label);
  assert.doesNotMatch(read, /on-site ask is realistic/, label);
}

test("foreign and non-California applicant addresses are not an on-site Van Nuys signal", async (t) => {
  const foreign: AppliedAddress[] = [
    { via: "show", address: "London, CA", location: { city: "London", region: "Ontario", country: "Canada", country_code: "CA", location_str: "London, Ontario, Canada" } },
    { via: "list", address: "London, CA" },
    { via: "show", address: "Baja California, Mexico", location: { city: "Mexicali", region: "Baja California", country: "Mexico", country_code: "MX", location_str: "Mexicali, Baja California, Mexico" } },
    { via: "list", address: "Baja California" },
    { via: "list", address: "Baja California Sur, Mexico" },
    { via: "show", address: "Berlin, de", location: { city: "Berlin", country: "Germany", country_code: "DE", location_str: "Berlin, Germany" } },
    { via: "list", address: "Berlin, de" },
    { via: "list", address: "Paris, fr" },
    { via: "list", address: "London, UK" },
    { via: "list", address: "Tokyo, jp" },
    { via: "list", address: "Dublin, ie" },
    { via: "list", address: "Mexico City, mx" },
    { via: "list", address: "Montreal, QC, CA" },
    { via: "list", address: "Vancouver, BC, CA" },
    { via: "list", address: "London, Ontario, CA" },
    { via: "list", address: "Toronto, ON, CA" },
  ];

  for (const input of foreign) {
    await t.test(`${input.via} address ${JSON.stringify(input.address)} is not US on-site`, async () => {
      const stored = await storeAppliedAddress(input);
      const view = await dossierFor(stored, String(stored.location));
      assert.equal(view.logistics.location, input.address);
      assert.equal(stored.source, "applied");
      if (input.location?.country_code) {
        const parsed = stored.raw?.location as StructuredLocation | undefined;
        assert.equal(parsed?.country_code, input.location.country_code);
      }
      assertNotUsOnsite(view.logistics.read, view.logistics.likelihood, input.address);
      // cityState rewrites some of these into a US state abbreviation that the
      // dossier prints as Location. That is the same trailing-code mistake.
      if (input.address === "Berlin, de") assert.notEqual(view.locationShort, "Berlin, DE");
      if (/Ontario|QC|BC|ON/.test(input.address)) assert.doesNotMatch(view.locationShort, /, CA$/);
      // The dossier prints this likelihood on its own, even when a later
      // commute paragraph exists. See candidate-dossier.tsx facts and FactLine.
      const withNote = await dossierFor(stored, String(stored.location), {
        decision: "backup",
        why: "Hold for a screen.",
        risk: "",
        next: "Short screen",
        assessment: {
          bio: "",
          application: "",
          commute: "The written commute note says this person is not near Van Nuys.",
        },
      });
      assert.equal(withNote.assessment?.commute?.includes("not near Van Nuys"), true);
      assertNotUsOnsite(withNote.logistics.read, withNote.logistics.likelihood, `${input.address} likelihood`);
    });
  }
});

test("a US town whose name contains California is not the state of California", async () => {
  const stored = await storeAppliedAddress({ via: "list", address: "California, Pennsylvania" });
  const view = await dossierFor(stored, String(stored.location));
  assert.equal(view.logistics.location, "California, Pennsylvania");
  assert.notEqual(view.logistics.likelihood, "High");
  assert.doesNotMatch(view.logistics.read, /in or near California/);
  assert.doesNotMatch(view.logistics.read, /on-site ask is realistic/);
  assertUsOutsideCalifornia(view.logistics.read, view.logistics.likelihood, "California, Pennsylvania");
});

test("an empty location column still classifies the address stored on the raw Workable payload", async () => {
  const stored = await storeAppliedAddress({ via: "show", address: "Berlin, de", location: { city: "Berlin", country: "Germany", country_code: "DE" } });
  const view = await dossierFor(stored, null);
  assert.equal(view.logistics.location, "Berlin, de");
  assertNotUsOnsite(view.logistics.read, view.logistics.likelihood, "raw.address fallback");
});

test("real California and other US addresses stay classified", async (t) => {
  const california = [
    "Los Angeles, California",
    "Pasadena, California, USA",
    "Los Angeles, CA",
    "Beverly Hills, CA",
    "San Jose, CA 95123",
    "Simi Valley, CA 93063",
    "Ontario, CA",
  ];
  for (const address of california) {
    await t.test(address, async () => {
      const stored = await storeAppliedAddress({
        via: "show",
        address,
        location: { country: "United States", country_code: "US", region: "California", region_code: "CA", location_str: address },
      });
      const view = await dossierFor(stored, String(stored.location));
      assert.equal(view.logistics.location, address);
      assertCalifornia(view.logistics.read, view.logistics.likelihood, address);
      if (address === "Los Angeles, California") assert.equal(view.locationShort, "Los Angeles, CA");
    });
  }

  const elsewhere = ["Austin, TX", "332 Clemmie Roads, Colorado, USA", "New York, NY"];
  for (const address of elsewhere) {
    await t.test(address, async () => {
      const stored = await storeAppliedAddress({ via: "list", address });
      const view = await dossierFor(stored, String(stored.location));
      assert.equal(view.logistics.location, address);
      assertUsOutsideCalifornia(view.logistics.read, view.logistics.likelihood, address);
    });
  }
});

test("the short location label does not turn a country code into a US state", async (t) => {
  await t.test("Berlin, de is not Delaware", async () => {
    const stored = await storeAppliedAddress({ via: "list", address: "Berlin, de" });
    const view = await dossierFor(stored, String(stored.location));
    assert.notEqual(view.locationShort, "Berlin, DE");
  });

  await t.test("London, Ontario, CA is not Ontario, California", async () => {
    const stored = await storeAppliedAddress({ via: "list", address: "London, Ontario, CA" });
    const view = await dossierFor(stored, String(stored.location));
    assert.notEqual(view.locationShort, "Ontario, CA");
    assert.doesNotMatch(view.locationShort, /, CA$/);
  });

  await t.test("Los Angeles, California still shortens to Los Angeles, CA", async () => {
    const stored = await storeAppliedAddress({ via: "list", address: "Los Angeles, California" });
    const view = await dossierFor(stored, String(stored.location));
    assert.equal(view.locationShort, "Los Angeles, CA");
  });
});

test("a missing address is not described as US-based or near California", async () => {
  const stored = await storeAppliedAddress({ via: "list", address: "" });
  const view = await dossierFor(stored, "");
  assert.equal(view.logistics.likelihood, "—");
  assert.match(view.logistics.read, /Location not stated/);
  assert.doesNotMatch(view.logistics.read, /US-based|in or near California|on-site ask is realistic/);
});
