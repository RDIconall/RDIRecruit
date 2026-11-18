import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { getMiddlewareMatchers } from "next/dist/build/analysis/get-page-static-info.js";

// Obvious placeholders. The health handler reads these at import time, so they
// are set before the route module loads. They are not real credentials.
const PLACEHOLDER_WORKABLE_TOKEN = "placeholder-workable-token";
const PLACEHOLDER_SUPABASE_KEY = "placeholder-supabase-service-key";
const PLACEHOLDER_ANTHROPIC = "placeholder-anthropic-key";
const PLACEHOLDER_CRON = "placeholder-cron-secret";
const PLACEHOLDER_CLERK_SECRET = "placeholder-clerk-secret";
const WORKABLE_BODY = "upstream-workable-error-body-canary";
const SUPABASE_MESSAGE = "upstream-supabase-error-body-canary";
const WORKABLE_SUBDOMAIN = "example-subdomain";
const SUPABASE_URL = "https://example-project.supabase.co";

process.env.WORKABLE_TOKEN = PLACEHOLDER_WORKABLE_TOKEN;
delete process.env.WORKABLE_API_KEY;
process.env.WORKABLE_SUBDOMAIN = WORKABLE_SUBDOMAIN;
process.env.SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY = PLACEHOLDER_SUPABASE_KEY;
process.env.ANTHROPIC_API_KEY = PLACEHOLDER_ANTHROPIC;
process.env.CRON_SECRET = PLACEHOLDER_CRON;
process.env.CLERK_SECRET_KEY = PLACEHOLDER_CLERK_SECRET;
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = `pk_live_${Buffer.from("example.invalid$").toString("base64")}`;
process.env.NODE_ENV = "production";

type RecordedCall = { url: string; authorization: string | null; apikey: string | null };

function installFetch() {
  const calls: RecordedCall[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(
      init?.headers ?? (typeof input !== "string" && !(input instanceof URL) ? input.headers : undefined),
    );
    calls.push({
      url,
      authorization: headers.get("authorization"),
      apikey: headers.get("apikey"),
    });
    if (url.includes(".workable.com")) {
      return new Response(WORKABLE_BODY, { status: 401, headers: { "content-type": "text/plain" } });
    }
    if (url.includes(".supabase.co")) {
      return new Response(
        JSON.stringify({ message: SUPABASE_MESSAGE, code: "PGRST301", details: WORKABLE_BODY }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("unexpected-upstream", { status: 500 });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = previous;
    },
  };
}

function assertUsesPlaceholders(calls: RecordedCall[]) {
  for (const call of calls) {
    if (call.url.includes(".workable.com")) {
      if (call.authorization !== `Bearer ${PLACEHOLDER_WORKABLE_TOKEN}`) {
        throw new Error("Workable request Authorization was not the test placeholder");
      }
    }
    if (call.url.includes(".supabase.co") && call.url.includes("/rest/v1/")) {
      if (call.apikey !== PLACEHOLDER_SUPABASE_KEY) {
        throw new Error("Supabase request apikey was not the test placeholder");
      }
    }
  }
}

function assertGenericHealth(raw: string) {
  const body = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(body.integrations, undefined);
  assert.equal(body.diagnostics, undefined);
  assert.equal(body.supabase, undefined);
  assert.equal(raw.includes(WORKABLE_BODY), false);
  assert.equal(raw.includes(SUPABASE_MESSAGE), false);
  assert.equal(raw.includes(PLACEHOLDER_WORKABLE_TOKEN), false);
  assert.equal(raw.includes(PLACEHOLDER_SUPABASE_KEY), false);
  assert.equal(raw.includes(PLACEHOLDER_ANTHROPIC), false);
}

async function loadHandler() {
  const mod = await import("../src/app/api/health/route.ts");
  return mod.GET;
}

function healthRequest(query: string, authorization?: string) {
  const headers = new Headers({ accept: "*/*" });
  if (authorization) headers.set("authorization", authorization);
  return new NextRequest(`https://recruit.example/api/health${query}`, { headers });
}

test("unauthenticated deep health check does not call Workable or return its error body", async () => {
  const net = installFetch();
  try {
    const GET = await loadHandler();
    const response = await GET(healthRequest("?deep=1"));
    const raw = await response.text();
    const workable = net.calls.filter((call) => call.url.includes(".workable.com"));
    assertUsesPlaceholders(workable);
    assert.equal(
      workable.length === 0 && !raw.includes(WORKABLE_BODY),
      true,
      `unauthenticated GET /api/health?deep=1 called ${workable.map((call) => call.url).join(",")} and returned ${raw.slice(0, 500)}`,
    );
    assertGenericHealth(raw);
  } finally {
    net.restore();
  }
});

test("unauthenticated health check does not query Supabase or reveal integration configuration", async () => {
  const net = installFetch();
  try {
    const GET = await loadHandler();
    const response = await GET(healthRequest(""));
    const raw = await response.text();
    const supabase = net.calls.filter(
      (call) => call.url.includes(".supabase.co") && call.url.includes("/rest/v1/"),
    );
    assertUsesPlaceholders(supabase);
    assert.deepEqual(
      supabase.map((call) => call.url),
      [],
      "unauthenticated GET /api/health queried Supabase",
    );
    assertGenericHealth(raw);
  } finally {
    net.restore();
  }
});

test("a bearer that is not the operator credential cannot trigger the deep health check", async () => {
  const net = installFetch();
  try {
    const GET = await loadHandler();
    const response = await GET(
      healthRequest("?deep=1", "Bearer placeholder-not-the-operator-credential"),
    );
    const raw = await response.text();
    const upstream = net.calls.filter(
      (call) => call.url.includes(".workable.com") || call.url.includes("/rest/v1/"),
    );
    assert.deepEqual(
      upstream.map((call) => call.url),
      [],
      "non-operator bearer still triggered an upstream health call",
    );
    assertGenericHealth(raw);
  } finally {
    net.restore();
  }
});

function continuesToHealth(result: Response, pathname: string): boolean {
  if (result.status === 401 || result.status === 403) return false;
  if (result.headers.has("location") && result.status >= 300 && result.status < 400) return false;
  // Clerk turns NextResponse.next() into a same-URL rewrite so it can attach
  // auth headers. Next then runs the route handler. A protect() rejection
  // rewrites to a /clerk_<timestamp> path instead.
  if (result.headers.get("x-middleware-next") === "1") return true;
  const rewrite = result.headers.get("x-middleware-rewrite");
  if (!rewrite) return false;
  return new URL(rewrite).pathname === pathname;
}

test("middleware does not stop an unauthenticated deep health request from reaching upstream", async () => {
  const net = installFetch();
  try {
    const { default: middleware, config } = await import("../src/middleware.ts");
    const matchers = getMiddlewareMatchers(config.matcher, {});
    const pathname = "/api/health";
    const matched = matchers.some((matcher: { regexp: string }) => new RegExp(matcher.regexp).test(pathname));
    assert.equal(matched, true, "Next middleware matcher does not run for /api/health");

    const request = healthRequest("?deep=1");
    const result = await middleware(request, { waitUntil() {} } as never);
    const upstreamDuringMiddleware = net.calls.filter(
      (call) => call.url.includes(".workable.com") || call.url.includes("/rest/v1/"),
    );
    assert.deepEqual(
      upstreamDuringMiddleware.map((call) => call.url),
      [],
      "middleware itself called Workable or Supabase",
    );
    if (!continuesToHealth(result, pathname)) return;

    const GET = await loadHandler();
    const response = await GET(request);
    const raw = await response.text();
    const upstream = net.calls.filter(
      (call) => call.url.includes(".workable.com") || (call.url.includes(".supabase.co") && call.url.includes("/rest/v1/")),
    );
    assertUsesPlaceholders(upstream);
    assert.equal(
      upstream.length === 0 && !raw.includes(WORKABLE_BODY) && !raw.includes(SUPABASE_MESSAGE),
      true,
      `signed-out request continued (${result.headers.get("x-clerk-auth-status")}) and returned ${raw.slice(0, 500)} via ${upstream.map((call) => call.url).join(",")}`,
    );
    assertGenericHealth(raw);
  } finally {
    net.restore();
  }
});
