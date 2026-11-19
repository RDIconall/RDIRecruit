import "next/dist/server/node-environment-baseline.js";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, before, describe, test } from "node:test";
import { NextRequest } from "next/server";

/**
 * Spec for the Workable webhook gate.
 *
 * These tests fail while an unsigned POST is accepted when
 * WORKABLE_WEBHOOK_SECRET is unset or empty, and while the handler reads that
 * secret again between the authorization decision and the HMAC check. A fix
 * reads the secret once and rejects before recordEvent or
 * syncCandidateFromWebhook unless the raw body carries a valid HMAC of that
 * same value.
 */

const nodeModule = createRequire(import.meta.url)("module") as {
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
};
const serverOnlyEmpty = new URL("../node_modules/server-only/empty.js", import.meta.url).pathname;
const resolveFilename = nodeModule._resolveFilename;
nodeModule._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === "server-only") return serverOnlyEmpty;
  return resolveFilename.call(this, request, ...rest);
};

const WORKABLE_TOKEN = "test-workable-token";
const SERVICE_KEY = "test-service-key";
const SUPABASE_ORIGIN = "https://test-project.supabase.co";
const SECRET_A = "test-webhook-secret";
const SECRET_B = "test-webhook-secret-other";
const SUBDOMAIN = "rditrials";

process.env.WORKABLE_TOKEN = WORKABLE_TOKEN;
process.env.WORKABLE_SUBDOMAIN = SUBDOMAIN;
process.env.SUPABASE_URL = SUPABASE_ORIGIN;
process.env.SUPABASE_SERVICE_KEY = SERVICE_KEY;
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
delete process.env.WORKABLE_WEBHOOK_SECRET;
process.env.NODE_ENV = "development";
process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL = "/sign-in";

type Env = {
  WORKABLE_WEBHOOK_SECRET?: string;
  ANTHROPIC_API_KEY?: string;
};

type Call = {
  method: string;
  href: string;
  path: string;
  authorization: string | null;
};

type Row = Record<string, unknown>;

let postWebhook: (request: NextRequest) => Promise<Response>;
let env: Env;

const tables = new Map<string, Row[]>();
let calls: Call[] = [];
let originalFetch: typeof fetch;
let workableStatus = 200;

before(async () => {
  const route = await import("../src/app/api/hooks/workable/route.ts");
  const envMod = await import("../src/lib/env.ts");
  postWebhook = route.POST;
  env = envMod.env;
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  tables.clear();
  calls = [];
  workableStatus = 200;
  setSecret(undefined);
  env.ANTHROPIC_API_KEY = "test-anthropic-key";
});

function setSecret(value: string | undefined) {
  Object.defineProperty(env, "WORKABLE_WEBHOOK_SECRET", {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
  if (value === undefined) delete process.env.WORKABLE_WEBHOOK_SECRET;
  else process.env.WORKABLE_WEBHOOK_SECRET = value;
}

function sign(body: string, secret: string) {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function createdBody(job: string, candidateId: string) {
  return JSON.stringify({
    id: "external-event",
    event_type: "candidate_created",
    data: { job: { shortcode: job }, candidate: { id: candidateId } },
  });
}

function movedBody(job: string, candidateId: string) {
  return JSON.stringify({
    event_type: "candidate_moved",
    data: { id: candidateId, job: { shortcode: job } },
  });
}

function candidatePayload(candidateId: string) {
  return {
    id: candidateId,
    name: "Pat Example",
    email: "pat.example@example.com",
    stage: "applied",
    disqualified: false,
    sourced: false,
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-06-01T00:00:00.000Z",
    cover_letter: "Cover letter with enough text to be graded as application material.",
    answers: [],
    experience_entries: [
      {
        title: "Coordinator",
        company: "Example Clinic",
        start_date: "2020-01-01",
        end_date: "2023-01-01",
        current: false,
        summary: "Coordinated study visits and kept the trial file current.",
      },
    ],
    education_entries: [],
  };
}

function seedJob(shortcode: string) {
  tables.set("jobs", [
    {
      shortcode,
      title: "Clinical Research Associate",
      status: "published",
      raw: {
        full_description: `<p>${"Study coordination and monitoring duties. ".repeat(8)}</p>`,
      },
    },
  ]);
}

function describeRequest(input: RequestInfo | URL, init?: RequestInit): Call {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
  const headers = new Headers(init?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : undefined));
  const parsed = new URL(url);
  return {
    method,
    href: url,
    path: parsed.pathname,
    authorization: headers.get("authorization"),
  };
}

function json(body: unknown, status = 200, extra?: HeadersInit) {
  return new Response(body == null ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(extra)) },
  });
}

function workableResponse(request: Call) {
  if (workableStatus !== 200) {
    return json({ error: "workable rejected" }, workableStatus);
  }
  if (request.path.includes("/activities")) return json({ activities: [] });
  const candidateMatch = request.path.match(/\/candidates\/([^/]+)$/);
  if (candidateMatch) return json({ candidate: candidatePayload(decodeURIComponent(candidateMatch[1])) });
  return json({ error: "unhandled workable path" }, 400);
}

function represent(rows: Row[], accept: string | null) {
  if (accept?.includes("application/vnd.pgrst.object+json")) {
    if (rows.length !== 1) {
      return json(
        {
          code: "PGRST116",
          message: "JSON object requested, multiple (or no) rows returned",
        },
        406,
      );
    }
    return json(rows[0]);
  }
  return json(rows);
}

function rowMatches(row: Row, url: URL) {
  const filters = new Map<string, string[]>();
  for (const [key, value] of url.searchParams) {
    if (["select", "on_conflict", "order", "limit", "offset", "columns"].includes(key)) continue;
    filters.set(key, [...(filters.get(key) ?? []), value]);
  }
  for (const [key, values] of filters) {
    if (!values.every((value) => matchFilter(row[key], value))) return false;
  }
  return true;
}

function matchFilter(actual: unknown, filter: string) {
  if (filter.startsWith("eq.")) return String(actual) === filter.slice(3);
  if (filter.startsWith("not.eq.")) return String(actual) !== filter.slice(7);
  if (filter === "is.null") return actual == null;
  if (filter === "not.is.null") return actual != null;
  if (filter === "is.true") return actual === true;
  if (filter === "is.false") return actual === false;
  if (filter.startsWith("in.(") && filter.endsWith(")")) {
    const allowed = filter
      .slice(4, -1)
      .split(",")
      .map((item) => item.replaceAll('"', ""));
    return allowed.includes(String(actual));
  }
  if (filter.startsWith("gte.")) return String(actual) >= filter.slice(4);
  if (filter.startsWith("gt.")) return String(actual) > filter.slice(3);
  if (filter.startsWith("lte.")) return String(actual) <= filter.slice(4);
  if (filter.startsWith("lt.")) return String(actual) < filter.slice(3);
  throw new Error(`stand-in has no PostgREST filter ${filter}`);
}

function installFetchWithBody() {
  calls = [];
  globalThis.fetch = async (input, init) => {
    const request = describeRequest(input, init);
    calls.push(request);
    if (request.href.startsWith(`https://${SUBDOMAIN}.workable.com/`)) {
      return workableResponse(request);
    }
    if (request.href.startsWith(`${SUPABASE_ORIGIN}/`)) {
      return supabaseResponseWith(request, init);
    }
    return new Response(`unexpected host for ${request.path}`, { status: 400 });
  };
}

async function supabaseResponseWith(request: Call & { accept?: string | null }, init?: RequestInit) {
  const url = new URL(request.href);
  const table = url.pathname.split("/").filter(Boolean)[2];
  if (!table) return json({ message: "missing table" }, 400);
  const rows = tables.get(table) ?? [];
  const matched = rows.filter((row) => rowMatches(row, url));
  const accept = new Headers(init?.headers).get("accept");
  const bodyText = await bodyToText(init?.body);

  if (request.method === "GET" || request.method === "HEAD") {
    const limited = limitRows(matched, url);
    return represent(limited, accept);
  }
  const payload = bodyText ? (JSON.parse(bodyText) as Row | Row[]) : {};
  const incoming = Array.isArray(payload) ? payload : [payload];

  if (request.method === "POST") {
    const conflict = url.searchParams.get("on_conflict");
    const stored: Row[] = [];
    for (const item of incoming) {
      const next = { ...item };
      if (conflict) {
        const keys = conflict.split(",");
        const index = rows.findIndex((row) => keys.every((key) => row[key] === next[key]));
        if (index >= 0) {
          rows[index] = { ...rows[index], ...next };
          stored.push(rows[index]);
          continue;
        }
      }
      if (next.id == null) next.id = `${table}-${rows.length + 1}`;
      rows.push(next);
      stored.push(next);
    }
    tables.set(table, rows);
    return represent(stored, accept);
  }

  if (request.method === "PATCH") {
    const patch = incoming[0] ?? {};
    const updated = matched.map((row) => Object.assign(row, patch));
    return represent(updated, accept);
  }

  return json({ message: `unhandled ${request.method} ${url.pathname}` }, 400);
}

function limitRows(rows: Row[], url: URL) {
  const limit = url.searchParams.get("limit");
  if (!limit) return rows;
  const count = Number(limit);
  return Number.isFinite(count) ? rows.slice(0, count) : rows;
}

async function bodyToText(body: BodyInit | null | undefined) {
  if (body == null) return null;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
  return new Response(body).text();
}

function callSummary() {
  return calls.map((call) => `${call.method} ${new URL(call.href).pathname}`).join(", ");
}

function post(body: string, headers: Record<string, string> = {}, query = "") {
  return postWebhook(
    new NextRequest(`http://localhost/api/hooks/workable${query}`, {
      method: "POST",
      body,
      headers: { "content-type": "application/json", ...headers },
    }),
  );
}

async function assertRejected(response: Response) {
  const text = await response.text();
  assert.equal(
    response.status,
    401,
    `unsigned or mismatched webhook must be rejected before sync; got ${response.status} ${text}; calls: ${callSummary()}`,
  );
  assert.equal(calls.length, 0, `rejection happened after an outbound call: ${callSummary()}`);
}

function assertCandidateFetch(job: string, candidateId: string) {
  const expected = `/spi/v3/jobs/${job}/candidates/${candidateId}`;
  const fetches = calls.filter((call) => call.method === "GET" && new URL(call.href).pathname === expected);
  assert.equal(
    fetches.length,
    1,
    `expected one Workable fetch of ${expected}; calls: ${callSummary()}`,
  );
  assert.equal(fetches[0].authorization, `Bearer ${WORKABLE_TOKEN}`);
  const decoys = calls.filter(
    (call) => call.href.includes("decoy-candidate") || call.href.includes("decoy-job"),
  );
  assert.equal(decoys.length, 0, `sync used an id that was not in the signed body: ${callSummary()}`);
}

describe("Workable webhook signature", { concurrency: false }, () => {
test("middleware serves /api/hooks/workable without Clerk protection", async () => {
  const { createRouteMatcher } = await import("@clerk/nextjs/server");
  const { getMiddlewareMatchers } = await import(
    "next/dist/build/analysis/get-page-static-info.js"
  );
  const { getMiddlewareRouteMatcher } = await import(
    "next/dist/shared/lib/router/utils/middleware-route-matcher.js"
  );
  const middleware = await import("../src/middleware.ts");

  const source = readFileSync(new URL("../src/middleware.ts", import.meta.url), "utf8");
  const block = source.match(/createRouteMatcher\(\[([\s\S]*?)\]\)/);
  assert.ok(block, "middleware must declare public routes");
  const patterns = [...block[1].matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
  const isPublic = createRouteMatcher(patterns);
  const requestFor = (pathname: string) =>
    ({ nextUrl: { pathname } }) as Parameters<typeof isPublic>[0];
  assert.equal(isPublic(requestFor("/api/hooks/workable")), true);
  assert.equal(isPublic(requestFor("/")), false);

  const matchers = getMiddlewareMatchers(middleware.config.matcher, {});
  const matches = getMiddlewareRouteMatcher(matchers);
  assert.equal(matches("/api/hooks/workable", {} as never, {}), true);

  const webhook = await middleware.default(
    new NextRequest("http://localhost/api/hooks/workable", { method: "POST" }),
  );
  assert.equal(webhook.status, 200);
  assert.notEqual(webhook.headers.get("x-clerk-auth-reason"), "protect-rewrite");
  assert.equal(webhook.headers.get("location"), null);

  const appPage = await middleware.default(
    new NextRequest("http://localhost/", {
      headers: { accept: "text/html" },
    }),
  );
  const protectedOutcome =
    appPage.headers.get("x-clerk-auth-reason") === "protect-rewrite" ||
    (appPage.status >= 300 && appPage.status < 400);
  assert.equal(protectedOutcome, true, `private page was not protected: ${appPage.status}`);
});

test("unset secret rejects candidate_created before Workable or Supabase", async () => {
  installFetchWithBody();
  setSecret(undefined);
  seedJob("job-created");
  const response = await post(createdBody("job-created", "cand-created"));
  await assertRejected(response);
});

test("empty secret rejects candidate_moved before Workable or Supabase", async () => {
  installFetchWithBody();
  setSecret("");
  seedJob("job-moved");
  const response = await post(movedBody("job-moved", "cand-moved"));
  await assertRejected(response);
});

test("unset secret rejects a type alias and a bad signature before any side effect", async () => {
  installFetchWithBody();
  setSecret(undefined);
  const body = JSON.stringify({
    type: "candidate_created",
    data: { job: { shortcode: "job-alias" }, candidate: { id: "cand-alias" } },
  });
  const response = await post(body, { "X-Workable-Signature": "not-a-valid-signature" });
  await assertRejected(response);
});

test("a later secret read cannot authorize a request whose first read was unset", async () => {
  installFetchWithBody();
  let reads = 0;
  Object.defineProperty(env, "WORKABLE_WEBHOOK_SECRET", {
    configurable: true,
    enumerable: true,
    get() {
      reads += 1;
      return reads === 1 ? undefined : SECRET_B;
    },
  });
  process.env.WORKABLE_WEBHOOK_SECRET = SECRET_B;
  const body = createdBody("job-toctou", "cand-toctou");
  const response = await post(body, { "X-Workable-Signature": sign(body, SECRET_B) });
  await assertRejected(response);
});

test("HMAC is verified with the same secret value that permitted the request", async () => {
  installFetchWithBody();
  let reads = 0;
  Object.defineProperty(env, "WORKABLE_WEBHOOK_SECRET", {
    configurable: true,
    enumerable: true,
    get() {
      reads += 1;
      return reads === 1 ? SECRET_A : SECRET_B;
    },
  });
  process.env.WORKABLE_WEBHOOK_SECRET = SECRET_A;
  seedJob("job-bound");
  const body = createdBody("job-bound", "cand-bound");
  const response = await post(body, {
    "X-Workable-Signature": sign(body, SECRET_A),
  }, "?candidateId=decoy-candidate&shortcode=decoy-job");
  const text = await response.text();
  assert.equal(response.status, 200, text + " calls: " + callSummary());
  assert.equal(JSON.parse(text).processed, true);
  assertCandidateFetch("job-bound", "cand-bound");
  assert.ok(
    calls.some((call) => call.method === "POST" && call.path === "/rest/v1/candidate_analyses"),
    `candidate_created did not queue the initial analysis; calls: ${callSummary()}`,
  );
  assert.equal(calls.some((call) => call.href.includes("api.anthropic.com")), false);
});

test("a configured secret rejects a missing or mismatched signature before sync", async () => {
  installFetchWithBody();
  setSecret(SECRET_A);
  seedJob("job-locked");
  const body = movedBody("job-locked", "cand-locked");
  const missing = await post(body);
  await assertRejected(missing);

  calls = [];
  tables.clear();
  const mismatched = await post(body, { "X-Workable-Signature": sign(`${body} `, SECRET_A) });
  await assertRejected(mismatched);

  calls = [];
  const shortSignature = await post(body, { "X-Workable-Signature": "abcd" });
  await assertRejected(shortSignature);
});

test("a valid signature syncs the candidate in the signed body and queues a retry on Workable error", async () => {
  installFetchWithBody();
  setSecret(SECRET_A);
  seedJob("job-ok");
  const moved = movedBody("job-ok", "cand-ok");
  const movedResponse = await post(moved, { "X-Workable-Signature": sign(moved, SECRET_A) });
  assert.equal(movedResponse.status, 200);
  assertCandidateFetch("job-ok", "cand-ok");
  assert.ok(
    calls.some((call) => call.path === "/spi/v3/candidates/cand-ok/activities"),
    `candidate_moved did not sync comments; calls: ${callSummary()}`,
  );
  assert.equal(
    calls.some((call) => call.path === "/rest/v1/candidate_analyses"),
    false,
    "candidate_moved must not run the new-candidate score",
  );

  calls = [];
  tables.clear();
  seedJob("job-err");
  workableStatus = 400;
  const created = createdBody("job-err", "cand-err");
  const failed = await post(created, { "X-Workable-Signature": sign(created, SECRET_A) });
  assert.equal(failed.status, 500);
  const failure = await failed.json();
  assert.equal(failure.queued, true);
  const event = (tables.get("events") ?? [])[0];
  assert.equal(event?.status, "retryable_failure");
  assert.equal(calls.filter((call) => call.href.includes("workable.com")).length, 1);
});

test("a valid signature for candidate_created fetches that candidate and queues analysis", async () => {
  installFetchWithBody();
  setSecret(SECRET_A);
  seedJob("job-new");
  const body = createdBody("job-new", "cand-new");
  const response = await post(
    body,
    { "X-Workable-Signature": sign(body, SECRET_A) },
    "?candidateId=decoy-candidate&shortcode=decoy-job",
  );
  const text = await response.text();
  assert.equal(response.status, 200, `${text} calls: ${callSummary()}`);
  assert.equal(JSON.parse(text).processed, true);
  assertCandidateFetch("job-new", "cand-new");
  assert.ok(
    calls.some((call) => call.method === "POST" && call.path === "/rest/v1/candidate_analyses"),
    `candidate_created did not queue the initial analysis; calls: ${callSummary()}`,
  );
  assert.equal(calls.some((call) => call.href.includes("api.anthropic.com")), false);
});
});
