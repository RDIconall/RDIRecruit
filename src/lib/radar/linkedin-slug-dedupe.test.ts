/**
 * Spec for the Talent Radar LinkedIn dedupe mixup.
 *
 * These tests fail while a profile URL is turned into a LinkedIn slug by an
 * unanchored search for the text "linkedin.com/in/". They pass once a slug is
 * accepted only from the path of a linkedin.com host (or a subdomain of it).
 *
 * importCsvAction, addContactAction, runEnrichmentAction, and
 * runAiSourcingAction all reach this merge, but only after isRadarEnabled()
 * (src/app/actions/radar.ts). The switch is off in this commit, and loading
 * the action module pulls next/cache, which does not run under the test
 * runner. The tests therefore call the same functions those actions call
 * once the switch allows them: csvToRawContacts, the provider mappers,
 * normalizeContact, and upsertContact / upsertMany.
 */
import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { csvToRawContacts } from "./csv.ts";
import { dedupeKey, normalizeContact } from "./normalize.ts";
import type { RawContact, SearchCriteria } from "./types.ts";

// store.ts and the provider modules import "server-only", whose default
// export throws outside a React Server Component. Point that specifier at
// the package's empty build (server-only/empty.js, the "react-server"
// condition) so the real modules load under `tsx --test`.
{
  const require = createRequire(import.meta.url);
  const resolved = require.resolve("server-only");
  const empty = resolved.endsWith("empty.js") ? resolved : resolved.replace(/index\.js$/, "empty.js");
  const emptyUrl = pathToFileURL(empty).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "server-only") return { url: emptyUrl, shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
}

const SLUG = "ada-lovelace-rdi";
const VICTIM_KEY = `li:${SLUG}`;
const REAL_URL = `https://www.linkedin.com/in/${SLUG}`;
const VICTIM_PHONE = "555-0100";
const VICTIM_SUMMARY = "Analytical engines and the first program.";
const ATTACK_PHONE = "555-0199";
const ATTACK_SUMMARY = "Call this number instead.";

const SPOOFED_URLS = [
  `https://evil.example/linkedin.com/in/${SLUG}`,
  `https://evil.example/www.linkedin.com/in/${SLUG}`,
  `https://notlinkedin.com/in/${SLUG}`,
  `https://evil.example/path?next=https://www.linkedin.com/in/${SLUG}`,
  `https://evil.example/LinkedIn.com/in/${SLUG.toUpperCase()}`,
  `https://user:pass@evil.example/linkedin.com/in/${SLUG}#section`,
  `javascript:linkedin.com/in/${SLUG}`,
  `linkedin.com/in/${SLUG}`,
  `https://linkedin.com@evil.example/in/${SLUG}`,
  `https://www.linkedin.com.evil.example/in/${SLUG}`,
  // Host is linkedin.com, but the slug is not the /in/ path segment.
  // A fix that only checks the host and then re-runs the unanchored search
  // still collides on these.
  `https://www.linkedin.com/feed/#linkedin.com/in/${SLUG}`,
  `https://www.linkedin.com/company/acme/linkedin.com/in/${SLUG}`,
  `https://linkedin.com/pub/dir/linkedin.com/in/${SLUG}`,
];

const REAL_URLS = [
  REAL_URL,
  `https://linkedin.com/in/${SLUG}`,
  `https://uk.linkedin.com/in/${SLUG}/`,
  `http://www.linkedin.com/in/${SLUG}?trk=public_profile`,
  `HTTPS://WWW.LINKEDIN.COM/in/${SLUG}/details/experience`,
  `https://www.linkedin.com/in/${SLUG.toUpperCase()}`,
];

function assertNotVictim(url: string) {
  assert.notEqual(dedupeKey({ linkedinUrl: url }), VICTIM_KEY, url);
}

test("real LinkedIn profile hosts share one slug key", () => {
  for (const url of REAL_URLS) {
    assert.equal(dedupeKey({ linkedinUrl: url }), VICTIM_KEY, url);
  }
});

test("a URL that merely contains linkedin.com/in/ is not that person's key", () => {
  for (const url of SPOOFED_URLS) assertNotVictim(url);
});

test("email still wins over a spoofed profile URL", () => {
  assert.equal(
    dedupeKey({
      email: "ada@example.com",
      linkedinUrl: SPOOFED_URLS[0],
    }),
    "email:ada@example.com",
  );
  assert.equal(
    dedupeKey({ email: "   ", linkedinUrl: SPOOFED_URLS[0] }),
    dedupeKey({ linkedinUrl: SPOOFED_URLS[0] }),
  );
  assert.notEqual(dedupeKey({ email: "   ", linkedinUrl: SPOOFED_URLS[0] }), VICTIM_KEY);
});

test("normalizeContact stores the host-checked key", () => {
  const spoofed = normalizeContact({
    fullName: "Eve Mallory",
    linkedinUrl: `  ${SPOOFED_URLS[0]}  `,
    email: "",
    phone: ATTACK_PHONE,
    profileSummary: ATTACK_SUMMARY,
  });
  assert.notEqual(spoofed.dedupeKey, VICTIM_KEY);
  assert.equal(spoofed.linkedinUrl, SPOOFED_URLS[0]);

  const real = normalizeContact({
    fullName: "Ada Lovelace",
    linkedinUrl: REAL_URL,
    phone: VICTIM_PHONE,
  });
  assert.equal(real.dedupeKey, VICTIM_KEY);
});

test("CSV import rows keep a spoofed profile URL off the victim slug", () => {
  const csv = [
    "Name,LinkedIn,Email,Phone,Summary",
    `Eve Mallory,${SPOOFED_URLS[0]},,${ATTACK_PHONE},${ATTACK_SUMMARY}`,
    `Ada Lovelace,${REAL_URL},,${VICTIM_PHONE},${VICTIM_SUMMARY}`,
  ].join("\n");
  const rows = csvToRawContacts(csv, "CSV: upload");
  assert.equal(rows.length, 2);
  assert.notEqual(dedupeKey(rows[0]), VICTIM_KEY);
  assert.equal(dedupeKey(rows[1]), VICTIM_KEY);
  assert.equal(rows[0].phone, ATTACK_PHONE);
  assert.equal(rows[0].email, "");
});

interface MemoryRow {
  [column: string]: unknown;
  id: string;
}

/**
 * In-memory stand-in for the PostgREST HTTP API the shipped client speaks.
 *
 * Built from @supabase/postgrest-js 2.108.1 (the version package-lock installs
 * for @supabase/supabase-js 2.108.1):
 * - eq() appends column=eq.<value> (PostgrestFilterBuilder.ts:196)
 * - update() is PATCH and insert() is POST (PostgrestQueryBuilder.ts:1590 and :1112)
 * - the body is JSON.stringify of the values object, which drops undefined
 *   (PostgrestBuilder.ts:339), matching `field ?? undefined` in upsertContact
 * - maybeSingle unwraps a one-element JSON array (PostgrestBuilder.ts:518-536)
 * - select() asks for return=representation (PostgrestTransformBuilder.ts:119)
 *   and single() sets Accept to application/vnd.pgrst.object+json (:675)
 *
 * Equality filters and PATCH-assign are the whole of what upsertContact
 * depends on. Requests whose host is not the placeholder Supabase URL are
 * answered by `foreign`, so provider calls can be stubbed without leaving
 * the process.
 */
function createMemoryPostgrest(foreign?: (url: URL, init: RequestInit | undefined) => Promise<Response> | Response) {
  const tables = new Map<string, MemoryRow[]>();
  let seq = 0;
  const requests: { method: string; href: string; body: unknown }[] = [];

  function rowsFor(url: URL): MemoryRow[] {
    const name = url.pathname.split("/").filter(Boolean).pop() ?? "";
    let rows = tables.get(name);
    if (!rows) {
      rows = [];
      tables.set(name, rows);
    }
    return rows;
  }

  function matches(row: MemoryRow, url: URL): boolean {
    for (const [column, raw] of url.searchParams.entries()) {
      if (column === "select" || column === "columns" || column === "on_conflict") continue;
      if (!raw.startsWith("eq.")) continue;
      if (String(row[column]) !== raw.slice(3)) return false;
    }
    return true;
  }

  function header(init: RequestInit | undefined, name: string): string {
    const headers = init?.headers;
    if (!headers) return "";
    if (headers instanceof Headers) return headers.get(name) ?? "";
    if (Array.isArray(headers)) {
      const found = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
      return found ? String(found[1]) : "";
    }
    const record = headers as Record<string, string>;
    const key = Object.keys(record).find((item) => item.toLowerCase() === name.toLowerCase());
    return key ? String(record[key]) : "";
  }

  function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const href =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    const method = (
      init?.method ?? (typeof input !== "string" && !(input instanceof URL) ? input.method : "GET")
    ).toUpperCase();
    if (url.hostname !== "127.0.0.1") {
      if (!foreign) throw new Error(`unexpected request ${method} ${href}`);
      return foreign(url, init);
    }
    const rawBody = typeof init?.body === "string" ? init.body : null;
    const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : null;
    requests.push({ method, href: url.pathname + url.search, body });
    const rows = rowsFor(url);
    const asObject = header(init, "accept").includes("application/vnd.pgrst.object+json");

    if (method === "GET" || method === "HEAD") {
      const found = rows.filter((row) => matches(row, url));
      return json(found);
    }
    if (method === "POST") {
      const row: MemoryRow = { id: `contact-${++seq}`, ...(body ?? {}) };
      rows.push(row);
      return json(asObject ? row : [row], 201);
    }
    if (method === "PATCH") {
      const found = rows.filter((row) => matches(row, url));
      for (const row of found) Object.assign(row, body ?? {});
      return json(asObject ? (found[0] ?? null) : found);
    }
    return json({ message: `unsupported ${method}` }, 400);
  };

  return {
    fetchImpl,
    requests,
    table(name: string) {
      return tables.get(name) ?? [];
    },
    reset() {
      tables.clear();
      requests.length = 0;
      seq = 0;
    },
  };
}

const memory = createMemoryPostgrest();

async function loadRadar() {
  process.env.SUPABASE_URL ??= "http://127.0.0.1:54321";
  process.env.SUPABASE_SERVICE_KEY ??= "placeholder-not-a-secret";
  process.env.SEAMLESS_API_KEY ??= "placeholder-not-a-secret";
  process.env.APOLLO_API_KEY ??= "placeholder-not-a-secret";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = memory.fetchImpl;
  const [{ upsertContact, upsertMany }, { searchSeamless }, { searchApollo }] = await Promise.all([
    import("./store.ts"),
    import("./providers/seamless.ts"),
    import("./providers/apollo.ts"),
  ]);
  return { upsertContact, upsertMany, searchSeamless, searchApollo, originalFetch };
}

function victimContact(over: Partial<RawContact> = {}): RawContact {
  return {
    fullName: "Ada Lovelace",
    company: "Analytical Engines",
    linkedinUrl: REAL_URL,
    email: null,
    phone: VICTIM_PHONE,
    profileSummary: VICTIM_SUMMARY,
    source: "Manual",
    ...over,
  };
}

function attackerContact(url: string, over: Partial<RawContact> = {}): RawContact {
  return {
    fullName: "Eve Mallory",
    company: "Other Co",
    linkedinUrl: url,
    email: null,
    phone: ATTACK_PHONE,
    profileSummary: ATTACK_SUMMARY,
    source: "Manual",
    ...over,
  };
}

async function seedVictim(upsertContact: Awaited<ReturnType<typeof loadRadar>>["upsertContact"]) {
  memory.reset();
  const seeded = await upsertContact(victimContact(), { pipeline: "recruiting", owner: "RDI" });
  assert.equal(seeded.inserted, true);
  const row = memory.table("radar_contacts").find((item) => item.id === seeded.id);
  assert.ok(row);
  assert.equal(row.dedupe_key, VICTIM_KEY);
  assert.equal(row.phone, VICTIM_PHONE);
  return seeded;
}

test("import merge writes a real LinkedIn re-import onto the same contact and refuses a spoofed one", async () => {
  const { upsertContact, upsertMany, searchSeamless, searchApollo, originalFetch } = await loadRadar();
  try {
    const seeded = await seedVictim(upsertContact);
    const again = await upsertContact(
      victimContact({
        linkedinUrl: `https://uk.linkedin.com/in/${SLUG}`,
        phone: "555-0101",
        profileSummary: "Updated from the same profile.",
      }),
      { pipeline: "recruiting", owner: "RDI" },
    );
    assert.equal(again.inserted, false);
    assert.equal(again.id, seeded.id);
    const merged = memory.table("radar_contacts").find((item) => item.id === seeded.id);
    assert.ok(merged);
    assert.equal(merged.phone, "555-0101");
    assert.equal(memory.table("radar_contacts").length, 1);

    for (const url of SPOOFED_URLS) {
      const victimSeed = await seedVictim(upsertContact);
      const result = await upsertContact(attackerContact(url), { pipeline: "recruiting", owner: "attacker" });
      const victim = memory.table("radar_contacts").find((item) => item.id === victimSeed.id);
      assert.ok(victim, url);
      assert.equal(victim.phone, VICTIM_PHONE, url);
      assert.equal(victim.linkedin_url, REAL_URL, url);
      assert.equal(victim.profile_summary, VICTIM_SUMMARY, url);
      assert.notEqual(result.id, victimSeed.id, url);
      const patches = memory.requests.filter(
        (request) => request.method === "PATCH" && request.href.includes(`id=eq.${victimSeed.id}`),
      );
      assert.equal(patches.length, 0, url);
    }

    const csvSeed = await seedVictim(upsertContact);
    const csv = [
      "Name,Company,LinkedIn,Phone,Summary",
      `Eve Mallory,Other Co,${SPOOFED_URLS[0]},${ATTACK_PHONE},${ATTACK_SUMMARY}`,
    ].join("\n");
    const csvResult = await upsertMany(csvToRawContacts(csv, "CSV: upload"), {
      pipeline: "recruiting",
      owner: "attacker",
    });
    assert.equal(csvResult.duplicates, 0);
    assert.notEqual(csvResult.ids[0], csvSeed.id);

    const criteria = {
      titles: [],
      keywords: [],
      companies: [],
      locations: [],
      relocationAllowed: true,
      mustHave: [],
      exclude: [],
    } satisfies SearchCriteria;

    globalThis.fetch = async (input, init) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(href);
      if (url.hostname === "api.seamless.ai") {
        return new Response(
          JSON.stringify({
            contacts: [
              {
                fullName: "Eve Mallory",
                companyName: "Other Co",
                liUrl: SPOOFED_URLS[1],
                phone: ATTACK_PHONE,
                seniority: ATTACK_SUMMARY,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.hostname === "api.apollo.io") {
        return new Response(
          JSON.stringify({
            people: [
              {
                name: "Eve Mallory",
                linkedin_url: SPOOFED_URLS[3],
                headline: ATTACK_SUMMARY,
                organization: { name: "Other Co" },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return memory.fetchImpl(input, init);
    };

    const seamless = await searchSeamless(criteria, 5);
    assert.equal(seamless.length, 1);
    assert.equal(seamless[0].linkedinUrl, SPOOFED_URLS[1]);
    assert.equal(seamless[0].phone, ATTACK_PHONE);
    assert.equal(seamless[0].email ?? null, null);
    const seamlessResult = await upsertMany(seamless, { pipeline: "recruiting", owner: "attacker" });
    assert.notEqual(seamlessResult.ids[0], csvSeed.id);

    const apollo = await searchApollo(criteria, 5);
    assert.equal(apollo.length, 1);
    assert.equal(apollo[0].linkedinUrl, SPOOFED_URLS[3]);
    assert.equal(apollo[0].email ?? null, null);
    const apolloResult = await upsertMany(apollo, { pipeline: "recruiting", owner: "attacker" });
    assert.notEqual(apolloResult.ids[0], csvSeed.id);

    const victim = memory.table("radar_contacts").find((item) => item.id === csvSeed.id);
    assert.ok(victim);
    assert.equal(victim.phone, VICTIM_PHONE);
    assert.equal(victim.linkedin_url, REAL_URL);
    assert.equal(victim.profile_summary, VICTIM_SUMMARY);

    const sameName = await seedVictim(upsertContact);
    const sameNameResult = await upsertContact(
      attackerContact(SPOOFED_URLS[0], {
        fullName: "Ada Lovelace",
        company: "Analytical Engines",
      }),
      { pipeline: "recruiting", owner: "attacker" },
    );
    const sameNameVictim = memory.table("radar_contacts").find((item) => item.id === sameName.id);
    assert.ok(sameNameVictim);
    assert.equal(sameNameVictim.phone, VICTIM_PHONE);
    assert.equal(sameNameVictim.linkedin_url, REAL_URL);
    assert.notEqual(sameNameResult.id, sameName.id);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
