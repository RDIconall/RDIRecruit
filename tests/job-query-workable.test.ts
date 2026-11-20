/**
 * Spec for the triage home-page job query.
 *
 * These tests fail while a signed-in viewer can put an arbitrary `job` query
 * value on the Workable request path with the account token. They pass once
 * that value is resolved only against jobs already stored for the account,
 * codes containing slashes, question marks, backslashes, or dot segments are
 * refused before any Workable call, and stage lists for a stored job are not
 * fetched again on every view.
 *
 * The stand-in for Workable is the runtime's own Request parser (the same
 * constructor global fetch uses) and then a local 404. No request is sent to
 * the Workable host. Supabase is the shipped client talking to a local server
 * that only answers the jobs already stored for this account.
 */
import assert from "node:assert/strict";
import http from "node:http";
import Module from "node:module";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseUrl } from "next/dist/shared/lib/router/utils/parse-url.js";

const serverOnlyEmpty = fileURLToPath(new URL("../node_modules/server-only/empty.js", import.meta.url));

type ModuleHooks = typeof Module & {
  _resolveFilename: (request: string, parent: unknown, isMain: boolean, options?: unknown) => string;
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const moduleHooks = Module as ModuleHooks;

const resolveFilename = moduleHooks._resolveFilename;
moduleHooks._resolveFilename = function (request, parent, isMain, options) {
  if (request === "server-only") return serverOnlyEmpty;
  return resolveFilename.call(this, request, parent, isMain, options);
};

const loadModule = moduleHooks._load;
moduleHooks._load = function (request, parent, isMain) {
  if (request === "@clerk/nextjs/server") {
    return {
      auth: async () => ({ userId: "user_test" }),
      currentUser: async () => ({
        id: "user_test",
        firstName: "Test",
        lastName: "User",
        emailAddresses: [{ emailAddress: "test@example.com" }],
      }),
    };
  }
  return loadModule.call(this, request, parent, isMain);
};

const ACCOUNT_TOKEN = "placeholder-workable-token";
const SERVICE_KEY = "placeholder-service-key";
const SUBDOMAIN = "fixture-subdomain";
const STORED_SHORTCODE = "STOREDJOB1";

const STORED_JOB = {
  shortcode: STORED_SHORTCODE,
  title: "Stored role",
  status: "published",
  department: "Clinical",
  location: "Van Nuys",
};

type WorkableCall = {
  method: string;
  host: string;
  pathname: string;
  search: string;
  tokenAttached: boolean;
};

const workableCalls: WorkableCall[] = [];
const supabaseMutations: string[] = [];

let server: http.Server;
let homePage: (props: {
  searchParams: Promise<{ job?: string }>;
}) => Promise<unknown>;

function jobFromRequest(requestPath: string): string | undefined {
  // Next 16 parses the incoming request with parseUrl, which decodes the query
  // through URLSearchParams (see base-server and parse-relative-url).
  const parsed = parseUrl(requestPath);
  const job = parsed.query.job;
  if (Array.isArray(job)) return job[0];
  return job;
}

async function openHome(requestPath: string): Promise<void> {
  const job = jobFromRequest(requestPath);
  await homePage({ searchParams: Promise.resolve({ job }) });
}

function assertNoWorkableCall(label: string): void {
  assert.deepEqual(
    workableCalls.map((call) => ({
      method: call.method,
      host: call.host,
      pathname: call.pathname,
      search: call.search,
      tokenAttached: call.tokenAttached,
    })),
    [],
    `${label} must not call Workable`,
  );
  assert.deepEqual(
    supabaseMutations,
    [],
    `${label} must not write a job before refusing the query`,
  );
}

function resetCaptures(): void {
  workableCalls.length = 0;
  supabaseMutations.length = 0;
}

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" && req.method !== "HEAD") {
      supabaseMutations.push(`${req.method} ${url.pathname}`);
      res.writeHead(201, { "content-type": "application/json" });
      res.end("{}");
      return;
    }

    if (url.pathname === "/rest/v1/jobs") {
      const shortcode = url.searchParams.get("shortcode");
      let rows = [STORED_JOB];
      if (shortcode?.startsWith("eq.")) {
        rows = shortcode.slice(3) === STORED_SHORTCODE ? [STORED_JOB] : [];
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(rows));
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end("[]");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  process.env.WORKABLE_TOKEN = ACCOUNT_TOKEN;
  process.env.WORKABLE_SUBDOMAIN = SUBDOMAIN;
  delete process.env.WORKABLE_API_KEY;
  delete process.env.WORKABLE_MEMBER_ID;
  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_KEY = SERVICE_KEY;

  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    // Node's fetch constructs a Request before dispatching url.pathname.
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === `${SUBDOMAIN}.workable.com` || url.hostname.endsWith(".workable.com")) {
      workableCalls.push({
        method: request.method,
        host: url.host,
        pathname: url.pathname,
        search: url.search,
        tokenAttached: request.headers.get("authorization") === `Bearer ${ACCOUNT_TOKEN}`,
      });
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input, init);
  };

  const page = await import("../src/app/page.tsx");
  homePage = page.default;
});

after(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test("the cross-role inbox does not send the job query to Workable", async () => {
  resetCaptures();
  await openHome("/");
  await openHome("/?job=all");
  assertNoWorkableCall("cross-role inbox");
});

test("a stored job is read from Workable only at its own stage path, and not on every view", async () => {
  resetCaptures();
  const requestPath = `/?job=${encodeURIComponent(STORED_SHORTCODE)}`;
  await openHome(requestPath);
  await openHome(requestPath);
  assert.deepEqual(supabaseMutations, []);
  assert.ok(workableCalls.length <= 1, `repeated views issued ${workableCalls.length} Workable calls`);
  for (const call of workableCalls) {
    assert.equal(call.method, "GET");
    assert.equal(call.host, `${SUBDOMAIN}.workable.com`);
    assert.equal(call.pathname, `/spi/v3/jobs/${STORED_SHORTCODE}/stages`);
    assert.equal(call.search, "");
    assert.equal(call.tokenAttached, true);
  }
});

test("an unknown job code does not call Workable or store a job", async () => {
  resetCaptures();
  await openHome(`/?job=${encodeURIComponent("NOT-A-STORED-JOB")}`);
  assertNoWorkableCall("unknown job code");
});

test("a dot-dot job code is not requested on another Workable path with the account token", async () => {
  resetCaptures();
  await openHome(`/?job=${encodeURIComponent("../../members")}`);
  await openHome(`/?job=${encodeURIComponent("../../../members")}`);
  assertNoWorkableCall("dot-dot job code");
});

test("a backslash dot-dot job code is not requested on another Workable path", async () => {
  resetCaptures();
  await openHome(`/?job=${encodeURIComponent("..\\..\\members")}`);
  assertNoWorkableCall("backslash job code");
});

test("a slash in the job code is not appended to the Workable path", async () => {
  resetCaptures();
  await openHome(`/?job=${encodeURIComponent("foo/bar")}`);
  assertNoWorkableCall("slashed job code");
});

test("a question mark in the job code is not added to the Workable query", async () => {
  resetCaptures();
  await openHome(`/?job=${encodeURIComponent("foo?limit=1")}`);
  assertNoWorkableCall("question-mark job code");
});

test("a stored shortcode does not authorize a different path built from the same query", async () => {
  resetCaptures();
  await openHome(`/?job=${encodeURIComponent(`${STORED_SHORTCODE}/../../members`)}`);
  assertNoWorkableCall("stored shortcode used as a path prefix");
});

test("parallel views with distinct unknown job codes do not call Workable", async () => {
  resetCaptures();
  const paths = Array.from({ length: 12 }, (_, index) => `/?job=${encodeURIComponent(`UNKNOWN${index}`)}`);
  await Promise.all(paths.map((path) => openHome(path)));
  assertNoWorkableCall("parallel unknown job codes");
});

async function asSignedIn(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (workableCalls.length === 0) throw error;
  }
}

test("advance does not look up stages for a job code that is not stored", async () => {
  resetCaptures();
  const { advanceCandidate } = await import("../src/app/actions/candidates.ts");
  await asSignedIn(() =>
    advanceCandidate({
      jobShortcode: jobFromRequest(`/?job=${encodeURIComponent("../../members")}`) ?? "",
      candidateId: "cand_test",
    }),
  );
  assertNoWorkableCall("advance");
});

test("send to screen does not look up stages for a job code that is not stored", async () => {
  resetCaptures();
  const { sendCandidateToScreen } = await import("../src/app/actions/triage.ts");
  await asSignedIn(() =>
    sendCandidateToScreen({
      jobShortcode: jobFromRequest(`/?job=${encodeURIComponent("NOT-A-STORED-JOB")}`) ?? "",
      candidateId: "cand_test",
    }),
  );
  assertNoWorkableCall("send to screen");
});

test("disqualify does not fetch a candidate through an unsanitized job code", async () => {
  resetCaptures();
  const { denyCandidate } = await import("../src/app/actions/candidates.ts");
  await asSignedIn(() =>
    denyCandidate({
      jobShortcode: jobFromRequest(`/?job=${encodeURIComponent("../../members")}`) ?? "",
      candidateId: "cand_test",
    }),
  );
  assertNoWorkableCall("disqualify");
});
