import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";

/**
 * Spec for the event-queue ingest routes.
 *
 * An accepted write is a POST to PostgREST `/rest/v1/events` whose JSON body
 * is the row `recordEvent` builds: source, type, the caller's payload, and
 * processed false. The stand-in HTTP client below only answers that request
 * shape; it is the request `@supabase/postgrest-js` sends after
 * `insert().select().maybeSingle()` (JSON body, return=representation).
 *
 * Required controls, applied independently on each route that enqueues:
 * - Shared secret. When the env var is unset or empty, reject with 401 and
 *   write nothing. A missing or mismatched credential is also 401 and writes
 *   nothing, including when the credential length differs from the secret.
 * - Raw body cap of 65536 bytes (UTF-8). A larger body is 413 and writes
 *   nothing, even when the credential is valid.
 * - At most 10 accepted writes per route per client in any 60s window.
 *   The client key is the left-most address in `x-forwarded-for`. The 11th
 *   accepted-path request is 429 and writes nothing. A different address
 *   still has its own 10.
 */

export const SUPABASE_URL = "https://placeholder.supabase.test";
export const SERVICE_KEY = "placeholder-service-key";
export const MAX_BODY_BYTES = 64 * 1024;
export const RATE_LIMIT = 10;

export const PLACEHOLDER_SECRETS = {
  GMAIL_INGEST_SECRET: "placeholder-gmail-ingest-secret",
  FIREFLIES_INGEST_SECRET: "placeholder-fireflies-ingest-secret",
  CALENDLY_WEBHOOK_SECRET: "placeholder-calendly-webhook-secret",
  VIDEOASK_WEBHOOK_SECRET: "placeholder-videoask-webhook-secret",
  WORKABLE_WEBHOOK_SECRET: "placeholder-workable-webhook-secret",
} as const;

export type SecretEnv = keyof typeof PLACEHOLDER_SECRETS;

export type IngestRoute = {
  name: string;
  path: string;
  source: string;
  type: string;
  secretEnv: SecretEnv;
  /** Header compared to the secret, or HMAC-SHA256 hex of the raw body. */
  credential: "header" | "workable-hmac";
  header?: string;
  load: () => Promise<{ POST: (request: NextRequest) => Promise<Response> }>;
};

export const INGEST_ROUTES: IngestRoute[] = [
  {
    name: "gmail",
    path: "/api/ingest/gmail",
    source: "gmail",
    type: "reply_captured",
    secretEnv: "GMAIL_INGEST_SECRET",
    credential: "header",
    header: "x-gmail-ingest-secret",
    load: () => import("../src/app/api/ingest/gmail/route.ts"),
  },
  {
    name: "fireflies",
    path: "/api/ingest/fireflies",
    source: "fireflies",
    type: "transcript_ready",
    secretEnv: "FIREFLIES_INGEST_SECRET",
    credential: "header",
    header: "x-fireflies-ingest-secret",
    load: () => import("../src/app/api/ingest/fireflies/route.ts"),
  },
  {
    name: "calendly",
    path: "/api/hooks/calendly",
    source: "calendly",
    type: "booking",
    secretEnv: "CALENDLY_WEBHOOK_SECRET",
    credential: "header",
    header: "x-calendly-webhook-secret",
    load: () => import("../src/app/api/hooks/calendly/route.ts"),
  },
  {
    name: "videoask",
    path: "/api/hooks/videoask",
    source: "videoask",
    type: "response",
    secretEnv: "VIDEOASK_WEBHOOK_SECRET",
    credential: "header",
    header: "x-videoask-secret",
    load: () => import("../src/app/api/hooks/videoask/route.ts"),
  },
  {
    name: "workable",
    path: "/api/hooks/workable",
    source: "workable",
    type: "candidate_created",
    secretEnv: "WORKABLE_WEBHOOK_SECRET",
    credential: "workable-hmac",
    load: () => import("../src/app/api/hooks/workable/route.ts"),
  },
];

export type CapturedRequest = {
  url: string;
  method: string;
  body: string | undefined;
  headers: Headers;
};

export type FetchRecorder = {
  calls: CapturedRequest[];
  writes: () => CapturedRequest[];
  eventInserts: () => CapturedRequest[];
};

export function installFetchRecorder(): FetchRecorder {
  const calls: CapturedRequest[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    const headers = new Headers(init?.headers);
    calls.push({ url, method, body, headers });
    if (!url.startsWith(`${SUPABASE_URL}/`)) {
      throw new Error(`refusing unexpected fetch ${method} ${url}`);
    }
    // maybeSingle() unwraps a one-element array. Inserts ask for the new id.
    if (method === "POST" && url.includes("/rest/v1/events")) {
      return new Response(JSON.stringify([{ id: "00000000-0000-4000-8000-000000000001" }]), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return {
    calls,
    writes: () => calls.filter((call) => call.method === "POST" && call.url.includes("/rest/v1/")),
    eventInserts: () => calls.filter((call) => call.method === "POST" && call.url.includes("/rest/v1/events")),
  };
}

export function credentialHeaders(route: IngestRoute, rawBody: string, secret: string): Record<string, string> {
  if (route.credential === "header") {
    return { [route.header!]: secret };
  }
  // Same construction verifyWorkableSignature accepts: HMAC-SHA256 hex of the raw body.
  const signature = createHmac("sha256", secret).update(rawBody).digest("hex");
  return { "X-Workable-Signature": signature };
}

export function jsonOfByteLength(byteLength: number): string {
  const prefix = '{"n":"';
  const suffix = '"}';
  const filler = byteLength - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  if (filler < 1) throw new Error(`byte length ${byteLength} is too small`);
  return prefix + "a".repeat(filler) + suffix;
}

export async function postRaw(
  handler: (request: NextRequest) => Promise<Response>,
  path: string,
  rawBody: string,
  headers: Record<string, string>,
): Promise<Response> {
  const request = new NextRequest(`http://localhost${path}`, {
    method: "POST",
    body: rawBody,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-forwarded-for": headers["x-forwarded-for"] ?? "203.0.113.10",
      ...headers,
    },
  });
  return handler(request);
}

export function assertNoWrites(recorder: FetchRecorder): void {
  assert.deepEqual(
    recorder.writes().map((call) => ({ method: call.method, url: call.url, body: call.body })),
    [],
  );
}

export function assertEventInsert(
  recorder: FetchRecorder,
  route: IngestRoute,
  expected: { type: string; payload: unknown },
): void {
  const inserts = recorder.eventInserts();
  assert.equal(inserts.length, 1, `${route.name} should enqueue exactly one event`);
  assert.equal(recorder.writes().length, 1, `${route.name} should not write any other table`);
  const row = JSON.parse(inserts[0].body ?? "null") as {
    source?: string;
    type?: string;
    payload?: unknown;
    processed?: boolean;
  };
  assert.equal(row.source, route.source);
  assert.equal(row.type, expected.type);
  assert.equal(row.processed, false);
  assert.deepEqual(row.payload, expected.payload);
  assert.equal(inserts[0].headers.get("apikey"), SERVICE_KEY);
  assert.equal(inserts[0].headers.get("authorization"), `Bearer ${SERVICE_KEY}`);
  const url = new URL(inserts[0].url);
  assert.equal(url.origin, SUPABASE_URL);
  assert.equal(url.pathname, "/rest/v1/events");
}
