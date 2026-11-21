/**
 * Spec for the uncapped bulk-cut server actions.
 *
 * These tests fail while one authenticated call walks an entire caller-supplied
 * id list and performs a Workable write for every id. They pass once a single
 * invocation refuses or defers everything past a small cap (25) before those
 * writes, and hands back the ids it did not process.
 *
 * Network, Supabase, and Clerk are not contacted. The stand-ins below only
 * replace those edges. bulkDisqualify / bulkCandidateAction, the write queue,
 * and workableFetch all run as shipped.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, mock, test } from "node:test";

const require = createRequire(__filename);

const LIMIT = 25;
const SUPABASE_ORIGIN = "https://placeholder.supabase.co";
const CANDIDATE_UPDATED = "2024-01-01T00:00:00.000Z";
const PLACEHOLDER_USER = "user_placeholder";

process.env.WORKABLE_TOKEN = "placeholder-token";
process.env.WORKABLE_MEMBER_ID = "placeholder-member";
process.env.WORKABLE_SUBDOMAIN = "placeholder";
process.env.SUPABASE_URL = SUPABASE_ORIGIN;
process.env.SUPABASE_SERVICE_KEY = "placeholder-service-key";

let signedIn = true;

// Next resolves this package to an empty module for server components
// (server-only/package.json "react-server" export). The test runner hits the
// client throw, so stand in with that empty module.
const clerkAuth = {
  auth: async () => ({ userId: signedIn ? PLACEHOLDER_USER : null }),
  currentUser: async () => null,
  clerkMiddleware: () => () => {},
  createRouteMatcher: () => () => false,
};
// tsx compiles this file to CommonJS. Node's module mock matches the resolved
// filename for a package export, so register that path once.
mock.module(require.resolve("server-only"), { namedExports: {}, defaultExport: {} });
mock.module(require.resolve("@clerk/nextjs/server"), { namedExports: clerkAuth });
mock.module(require.resolve("next/cache"), {
  namedExports: { revalidatePath: () => {}, revalidateTag: () => {} },
});

interface WorkableCall {
  method: string;
  path: string;
  authorization: string | null;
}

const workableCalls: WorkableCall[] = [];
const overlayIds: string[] = [];

const realSetTimeout = globalThis.setTimeout.bind(globalThis);
let virtualNow = 1_800_000_000_000;
const RealDate = Date;

function installClock() {
  function PatchedDate(this: Date, ...args: unknown[]) {
    if (!new.target) {
      return new RealDate(virtualNow).toString();
    }
    if (args.length === 0) return new RealDate(virtualNow);
    return new RealDate(...(args as ConstructorParameters<typeof Date>));
  }
  PatchedDate.now = () => virtualNow;
  PatchedDate.parse = RealDate.parse;
  PatchedDate.UTC = RealDate.UTC;
  PatchedDate.prototype = RealDate.prototype;
  globalThis.Date = PatchedDate as DateConstructor;

  globalThis.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
    const delay = typeof ms === "number" && ms > 0 ? ms : 0;
    return realSetTimeout(() => {
      virtualNow += delay;
      if (typeof fn === "function") fn(...args);
    }, 0);
  }) as typeof setTimeout;
}

installClock();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function emptyResponse(status: number): Response {
  return new Response("", { status });
}

function candidatePayload(id: string) {
  return {
    id,
    name: "Visible Candidate",
    firstname: "Visible",
    lastname: "Candidate",
    headline: "",
    account: { subdomain: "placeholder", name: "Placeholder" },
    job: { shortcode: "job-1", title: "Role" },
    stage: "applied",
    disqualified: false,
    disqualification_reason: null,
    hired_at: null,
    sourced: false,
    profile_url: "",
    address: "",
    phone: "",
    email: "visible@example.com",
    created_at: CANDIDATE_UPDATED,
    updated_at: CANDIDATE_UPDATED,
    tags: [] as string[],
  };
}

function installFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    const parsed = new URL(url);
    const authHeader = new Headers(init?.headers).get("authorization");

    if (parsed.hostname.endsWith(".workable.com")) {
      const path = parsed.pathname;
      workableCalls.push({ method, path, authorization: authHeader });
      if (path.endsWith("/disqualify") || path.endsWith("/revert") || path.endsWith("/move") || path.endsWith("/comments")) {
        return emptyResponse(200);
      }
      if (path.endsWith("/tags")) {
        if (method === "GET" || path.includes("/candidates/") && !path.endsWith("/tags")) {
          const id = path.split("/").pop() ?? "cand";
          return jsonResponse({ candidate: candidatePayload(id) });
        }
        return emptyResponse(200);
      }
      if (path.endsWith("/stages")) {
        return jsonResponse({
          stages: [
            { slug: "applied", name: "Applied", kind: "sourced", position: 0 },
            { slug: "phone", name: "Phone", kind: "interview", position: 1 },
          ],
        });
      }
      if (parsed.pathname.includes("/candidates") && !parsed.pathname.endsWith("/candidates")) {
        const id = parsed.pathname.split("/").pop() ?? "cand";
        return jsonResponse({ candidate: candidatePayload(id) });
      }
      if (parsed.pathname.includes("/candidates")) {
        return jsonResponse({ candidates: [], paging: { next: null } });
      }
      return jsonResponse({});
    }

    if (parsed.origin === SUPABASE_ORIGIN) {
      if (parsed.pathname.endsWith("/candidate_overlay") && method === "POST") {
        const raw = typeof init?.body === "string" ? init.body : "{}";
        const body = JSON.parse(raw) as { candidate_id?: string };
        if (body.candidate_id) overlayIds.push(body.candidate_id);
        return jsonResponse([], 201);
      }
      if (parsed.pathname.endsWith("/candidates") && method === "GET") {
        const select = parsed.searchParams.get("select") ?? "";
        if (select.includes("job_shortcode")) {
          return jsonResponse([{ job_shortcode: "job-1" }]);
        }
        return jsonResponse([
          { analysis_hash: "same", workable_updated_at: CANDIDATE_UPDATED, photo_url: null },
        ]);
      }
      return jsonResponse([], method === "GET" ? 200 : 201);
    }

    throw new Error(`unexpected fetch ${method} ${parsed.origin}${parsed.pathname}`);
  }) as typeof fetch;
}

installFetch();

function resetEdges() {
  workableCalls.length = 0;
  overlayIds.length = 0;
  virtualNow += 11_000;
  signedIn = true;
}

function disqualifyCalls(): WorkableCall[] {
  return workableCalls.filter((call) => call.method === "POST" && call.path.endsWith("/disqualify"));
}

function moveCalls(): WorkableCall[] {
  return workableCalls.filter((call) => call.method === "POST" && call.path.endsWith("/move"));
}

function tagPuts(): WorkableCall[] {
  return workableCalls.filter((call) => call.method === "PUT" && call.path.endsWith("/tags"));
}

async function drainTimers() {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => realSetTimeout(resolve, 0));
  }
}

interface BoundedResult {
  ok: boolean;
  count: number;
  remaining?: string[];
}

function assertOverLimitStopped(ids: string[], writes: number, outcome: { result?: BoundedResult; thrown?: unknown }) {
  assert.ok(
    writes <= LIMIT,
    `one request performed ${writes} Workable writes; the cap is ${LIMIT} and the rest must be returned unprocessed`,
  );
  assert.ok(overlayIds.length <= LIMIT, `one request wrote ${overlayIds.length} overlays before stopping`);
  if (outcome.thrown) {
    assert.equal(writes, 0, "a refusal must happen before any Workable write");
    assert.equal(overlayIds.length, 0, "a refusal must happen before any overlay write");
    return;
  }
  const result = outcome.result;
  assert.ok(result, "bulk action returned no result");
  assert.equal(result.ok, true);
  assert.equal(result.count, writes);
  assert.ok(writes < ids.length, "an over-limit list must not be fully processed");
  assert.deepEqual(result.remaining, ids.slice(writes));
}

const loaded = (async () => {
  const actions = await import("../src/app/actions/triage.ts");
  const candidateActions = await import("../src/app/actions/candidates.ts");
  const workable = await import("../src/lib/workable/client.ts");
  return { actions, candidateActions, workable };
})();

function repeatedIds(count: number): string[] {
  return Array.from({ length: count }, () => "cand-visible");
}

function candidateIdFromPath(path: string): string | undefined {
  const match = path.match(/\/candidates\/([^/]+)/);
  return match?.[1];
}

describe("uncapped bulk Workable writes", { concurrency: false }, () => {
test("a signed-in bulk cut of a repeated visible id stops at 25 Workable disqualifies", async () => {
  const { actions } = await loaded;
  resetEdges();
  const ids = repeatedIds(LIMIT + 5);
  let result: BoundedResult | undefined;
  let thrown: unknown;
  try {
    result = await actions.bulkDisqualify({ candidateIds: ids, disqualified: true });
  } catch (error) {
    thrown = error;
  }
  await drainTimers();
  assertOverLimitStopped(ids, disqualifyCalls().length, { result, thrown });
});

test("a signed-in bulk cut of distinct ids stops at 25 and does not write the remainder", async () => {
  const { actions } = await loaded;
  resetEdges();
  const ids = Array.from({ length: LIMIT + 8 }, (_, index) => `cand-${index}`);
  let result: BoundedResult | undefined;
  let thrown: unknown;
  try {
    result = await actions.bulkDisqualify({ candidateIds: ids, disqualified: true });
  } catch (error) {
    thrown = error;
  }
  await drainTimers();
  const writes = disqualifyCalls().length;
  assertOverLimitStopped(ids, writes, { result, thrown });
  if (!thrown && result) {
    const processed = new Set(ids.slice(0, result.count));
    for (const id of overlayIds) assert.ok(processed.has(id), `overlay write for unprocessed id ${id}`);
    for (const call of disqualifyCalls()) {
      const id = candidateIdFromPath(call.path);
      assert.ok(id && processed.has(id), `Workable disqualify for unprocessed id ${id}`);
    }
  }
});

test("reinstating a list above the cap is bounded the same way", async () => {
  const { actions } = await loaded;
  resetEdges();
  const ids = repeatedIds(LIMIT + 3);
  let result: BoundedResult | undefined;
  let thrown: unknown;
  try {
    result = await actions.bulkDisqualify({ candidateIds: ids, disqualified: false });
  } catch (error) {
    thrown = error;
  }
  await drainTimers();
  const reverts = workableCalls.filter((call) => call.method === "POST" && call.path.endsWith("/revert"));
  assert.ok(reverts.length <= LIMIT, `one request performed ${reverts.length} Workable reverts`);
  assertOverLimitStopped(ids, reverts.length, { result, thrown });
});

test("a bulk cut at the cap still disqualifies each id", async () => {
  const { actions } = await loaded;
  resetEdges();
  const ids = repeatedIds(LIMIT);
  const result = await actions.bulkDisqualify({ candidateIds: ids, disqualified: true });
  await drainTimers();
  assert.equal(result.ok, true);
  assert.equal(result.count, ids.length);
  assert.equal(disqualifyCalls().length, ids.length);
  assert.equal(overlayIds.length, ids.length);
  assert.deepEqual((result as BoundedResult).remaining ?? [], []);
});

test("an anonymous bulk cut performs no writes", async () => {
  const { actions } = await loaded;
  resetEdges();
  signedIn = false;
  const ids = repeatedIds(LIMIT + 10);
  await assert.rejects(
    () => actions.bulkDisqualify({ candidateIds: ids, disqualified: true }),
    /Unauthorized/,
  );
  await drainTimers();
  assert.equal(disqualifyCalls().length, 0);
  assert.equal(overlayIds.length, 0);
});

test("bulk deny, advance, and hold share the same per-request cap", async () => {
  const { candidateActions } = await loaded;
  const ids = Array.from({ length: LIMIT + 6 }, (_, index) => `cand-bulk-${index}`);

  resetEdges();
  let deny: BoundedResult | undefined;
  let denyThrown: unknown;
  try {
    deny = await candidateActions.bulkCandidateAction({
      jobShortcode: "job-1",
      candidateIds: ids,
      action: "deny",
    });
  } catch (error) {
    denyThrown = error;
  }
  await drainTimers();
  assertOverLimitStopped(ids, disqualifyCalls().length, { result: deny, thrown: denyThrown });

  resetEdges();
  let advance: BoundedResult | undefined;
  let advanceThrown: unknown;
  try {
    advance = await candidateActions.bulkCandidateAction({
      jobShortcode: "job-1",
      candidateIds: ids,
      action: "advance",
    });
  } catch (error) {
    advanceThrown = error;
  }
  await drainTimers();
  assert.ok(moveCalls().length <= LIMIT, `one advance request performed ${moveCalls().length} Workable moves`);
  if (advanceThrown) {
    assert.equal(moveCalls().length, 0, "a refusal must happen before any Workable move");
  } else {
    assert.ok(advance);
    assert.equal(advance.ok, true);
    assert.equal(advance.count, moveCalls().length);
    assert.ok(moveCalls().length < ids.length);
    assert.deepEqual(advance.remaining, ids.slice(moveCalls().length));
  }

  resetEdges();
  let hold: BoundedResult | undefined;
  let holdThrown: unknown;
  try {
    hold = await candidateActions.bulkCandidateAction({
      jobShortcode: "job-1",
      candidateIds: ids,
      action: "hold",
    });
  } catch (error) {
    holdThrown = error;
  }
  await drainTimers();
  assert.ok(tagPuts().length <= LIMIT, `one hold request performed ${tagPuts().length} Workable tag writes`);
  if (holdThrown) {
    assert.equal(tagPuts().length, 0, "a refusal must happen before any Workable tag write");
  } else {
    assert.ok(hold);
    assert.equal(hold.ok, true);
    assert.equal(hold.count, tagPuts().length);
    assert.ok(tagPuts().length < ids.length);
    assert.deepEqual(hold.remaining, ids.slice(tagPuts().length));
  }
});

test("disqualify and the applicant list used by sync present the same Workable credential", async () => {
  const { actions, workable } = await loaded;
  resetEdges();
  await actions.bulkDisqualify({ candidateIds: ["cand-visible"], disqualified: true });
  await workable.listAllCandidates("job-1");
  const disqualify = disqualifyCalls()[0];
  const list = workableCalls.find((call) => call.method === "GET" && call.path.endsWith("/candidates"));
  assert.ok(disqualify, "expected a disqualify call");
  assert.ok(list, "expected an applicant list call");
  assert.ok(disqualify.authorization);
  assert.equal(
    disqualify.authorization,
    list.authorization,
    "disqualify and applicant sync must present the same Workable credential",
  );
  assert.equal(disqualify.authorization.startsWith("Bearer "), true);
});
});
