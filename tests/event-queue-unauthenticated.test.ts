import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { NextRequest } from "next/server";
import { pathToRegexp } from "next/dist/compiled/path-to-regexp/index.js";
import {
  INGEST_ROUTES,
  SERVICE_KEY,
  SUPABASE_URL,
  assertNoWrites,
  credentialHeaders,
  installFetchRecorder,
  postRaw,
  type FetchRecorder,
} from "./event-queue-attack.harness.ts";

// Parsed once, at first import of src/lib/env.ts. Secrets stay unset so a
// handler that fail-opens on a missing secret still has to reject.
process.env.SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY = SERVICE_KEY;
process.env.NODE_ENV = "production";
process.env.CLERK_TELEMETRY_DISABLED = "1";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY =
  "pk_test_" + Buffer.from("placeholder.clerk.test$").toString("base64");
process.env.CLERK_SECRET_KEY = "sk_test_placeholder";
for (const route of INGEST_ROUTES) delete process.env[route.secretEnv];

let recorder: FetchRecorder;

beforeEach(() => {
  recorder = installFetchRecorder();
});

describe("event queue ingest without a configured secret", () => {
  for (const route of INGEST_ROUTES) {
    test(`${route.name} rejects a POST with no credential and writes nothing`, async () => {
      const { POST } = await route.load();
      const response = await postRaw(POST, route.path, JSON.stringify({ ping: "ok" }), {
        "x-forwarded-for": `203.0.113.20`,
      });
      assert.equal(response.status, 401);
      assertNoWrites(recorder);
    });

    test(`${route.name} rejects a presented credential when the secret is unset and writes nothing`, async () => {
      const { POST } = await route.load();
      const raw = JSON.stringify({ ping: "ok" });
      const response = await postRaw(
        POST,
        route.path,
        raw,
        {
          "x-forwarded-for": `203.0.113.21`,
          ...credentialHeaders(route, raw, "placeholder-caller-supplied-secret"),
        },
      );
      assert.equal(response.status, 401);
      assertNoWrites(recorder);
    });
  }

  test("gmail does not record an unauthenticated non-JSON body", async () => {
    const { POST } = await INGEST_ROUTES[0].load();
    const response = await postRaw(POST, "/api/ingest/gmail", "not-json", {
      "x-forwarded-for": "203.0.113.22",
    });
    assert.equal(response.status, 401);
    assertNoWrites(recorder);
  });
});

describe("clerk middleware does not require a session for ingest", () => {
  test("the middleware matcher includes /api/ingest/gmail", () => {
    // src/middleware.ts config.matcher, checked with the path-to-regexp Next 16.2.9 bundles.
    const apiMatcher = pathToRegexp("/(api|trpc)(.*)");
    assert.equal(apiMatcher.test("/api/ingest/gmail"), true);
    assert.equal(apiMatcher.test("/api/ingest/fireflies"), true);
    assert.equal(apiMatcher.test("/api/hooks/calendly"), true);
    assert.equal(apiMatcher.test("/api/hooks/videoask"), true);
    assert.equal(apiMatcher.test("/api/hooks/workable"), true);
  });

  test("an unauthenticated POST to /api/ingest/gmail is not blocked by middleware", async () => {
    const mod = await import("../src/middleware.ts");
    const middleware = mod.default as unknown as (
      request: NextRequest,
      event: { waitUntil: (promise: Promise<unknown>) => void },
    ) => Promise<Response>;
    const request = new NextRequest("http://localhost/api/ingest/gmail", {
      method: "POST",
      body: JSON.stringify({ ping: "ok" }),
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
    });
    const response = await middleware(request, { waitUntil() {} });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("x-middleware-rewrite"), "http://localhost/api/ingest/gmail");
    assertNoWrites(recorder);
  });

  test("an unauthenticated POST to a non-public page is blocked by middleware", async () => {
    const mod = await import("../src/middleware.ts");
    const middleware = mod.default as unknown as (
      request: NextRequest,
      event: { waitUntil: (promise: Promise<unknown>) => void },
    ) => Promise<Response>;
    const request = new NextRequest("http://localhost/", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json", accept: "application/json" },
    });
    const response = await middleware(request, { waitUntil() {} });
    const rewrite = response.headers.get("x-middleware-rewrite") ?? "";
    assert.match(rewrite, /\/clerk_\d+$/);
  });
});
