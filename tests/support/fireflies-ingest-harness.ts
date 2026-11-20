import { createHmac } from "node:crypto";

/**
 * Drives the real Fireflies ingest route. The Fireflies GraphQL response and
 * the PostgREST responses are stand-ins for the two remote services. Their
 * bodies match the parsers in this repo:
 * - src/lib/ingest/fireflies.ts sentences/participants handling
 * - @supabase/postgrest-js processResponse / maybeSingle (empty array → null)
 * Every other step is the route and client code under test.
 */

export const ATTENDEE_EMAILS = [
  "attendee.one@example.test",
  "attendee.two@example.test",
  "organizer@example.test",
] as const;

export const TRANSCRIPT_SENTENCE = "Tell me about the role.";

export type RecordedCall = {
  url: string;
  method: string;
  body?: string;
  /** True when the Fireflies call presented the server API key. The key itself is not recorded. */
  usedServerFirefliesKey?: boolean;
};

export type IngestOutcome = {
  calls: RecordedCall[];
  status: number | null;
  body: string;
  thrown: string | null;
};

let routePromise: Promise<(request: Request) => Promise<Response>> | null = null;

function loadRoute() {
  if (!routePromise) {
    routePromise = import("../../src/app/api/ingest/fireflies/route.ts").then(
      (mod) => mod.POST as (request: Request) => Promise<Response>,
    );
  }
  return routePromise;
}

/** Fireflies V2 webhook signature: `sha256=` + hex HMAC-SHA256 of the raw body. */
export function firefliesSignature(rawBody: string, secret: string): string {
  const digest = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return `sha256=${digest}`;
}

function firefliesTranscriptResponse(transcriptId: string): Response {
  return new Response(
    JSON.stringify({
      data: {
        transcript: {
          id: transcriptId,
          title: "Hiring interview",
          organizer_email: ATTENDEE_EMAILS[2],
          participants: [...ATTENDEE_EMAILS],
          sentences: [{ speaker_name: "Interviewer", text: TRANSCRIPT_SENTENCE }],
        },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function postgrestResponse(method: string, accept: string): Response {
  // .single() asks for one JSON object. Zero rows is not ok, so data stays null
  // (postgrest-js processResponse). .maybeSingle() accepts an array; [] → null.
  if (accept.includes("application/vnd.pgrst.object+json")) {
    return new Response(JSON.stringify({ message: "no rows", code: "PGRST116" }), {
      status: 406,
      headers: { "content-type": "application/json" },
    });
  }
  if (method === "GET" || method === "HEAD") {
    return new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify([{ id: "row-1" }]), {
    status: 201,
    headers: { "content-type": "application/json" },
  });
}

export async function postFireflies(
  rawBody: string,
  headers: Record<string, string>,
  path = "/api/ingest/fireflies",
): Promise<IngestOutcome> {
  const POST = await loadRoute();
  const calls: RecordedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const requestHeaders = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : undefined;
    const usedServerFirefliesKey =
      url.startsWith("https://api.fireflies.ai/") &&
      requestHeaders.get("authorization") === `Bearer ${process.env.FIREFLIES_API_KEY}`;
    calls.push({ url, method, body, usedServerFirefliesKey });
    if (url.startsWith("https://api.fireflies.ai/graphql")) {
      const requested = JSON.parse(body ?? "{}") as { variables?: { id?: string } };
      return firefliesTranscriptResponse(requested.variables?.id ?? "");
    }
    if (url.includes("/rest/v1/")) {
      return postgrestResponse(method, requestHeaders.get("accept") ?? "");
    }
    return original(input, init);
  };

  try {
    const { NextRequest } = await import("next/server");
    const request = new NextRequest(`http://127.0.0.1:3000${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: rawBody,
    });
    try {
      const response = await POST(request);
      const responseBody = await response.text();
      return { calls, status: response.status, body: responseBody, thrown: null };
    } catch (error) {
      return {
        calls,
        status: null,
        body: "",
        thrown: error instanceof Error ? error.message : String(error),
      };
    }
  } finally {
    globalThis.fetch = original;
  }
}

export function outcomeSummary(outcome: IngestOutcome): string {
  return JSON.stringify(
    {
      status: outcome.status,
      thrown: outcome.thrown,
      body: outcome.body,
      calls: outcome.calls.map((call) => ({
        method: call.method,
        url: call.url.split("?")[0],
        body: call.body,
        usedServerFirefliesKey: call.usedServerFirefliesKey,
      })),
    },
    null,
    2,
  );
}

export function assertClosed(outcome: IngestOutcome, assertFn: typeof import("node:assert/strict")) {
  const summary = outcomeSummary(outcome);
  assertFn.equal(outcome.thrown, null, summary);
  assertFn.equal(outcome.status, 401, summary);
  assertFn.equal(outcome.calls.length, 0, summary);
  for (const email of ATTENDEE_EMAILS) {
    assertFn.equal(outcome.body.includes(email), false, summary);
  }
}
