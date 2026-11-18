import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";

// Same public health behavior when the operator credential is unset. A check
// that only runs when CRON_SECRET is present would still leave the route open.
const PLACEHOLDER_WORKABLE_TOKEN = "placeholder-workable-token";
const PLACEHOLDER_SUPABASE_KEY = "placeholder-supabase-service-key";
const PLACEHOLDER_ANTHROPIC = "placeholder-anthropic-key";
const WORKABLE_BODY = "upstream-workable-error-body-canary";
const SUPABASE_MESSAGE = "upstream-supabase-error-body-canary";

process.env.WORKABLE_TOKEN = PLACEHOLDER_WORKABLE_TOKEN;
delete process.env.WORKABLE_API_KEY;
process.env.WORKABLE_SUBDOMAIN = "example-subdomain";
process.env.SUPABASE_URL = "https://example-project.supabase.co";
process.env.SUPABASE_SERVICE_KEY = PLACEHOLDER_SUPABASE_KEY;
process.env.ANTHROPIC_API_KEY = PLACEHOLDER_ANTHROPIC;
delete process.env.CRON_SECRET;

type RecordedCall = { url: string };

function installFetch() {
  const calls: RecordedCall[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url });
    void init;
    if (url.includes(".workable.com")) {
      return new Response(WORKABLE_BODY, { status: 401 });
    }
    if (url.includes(".supabase.co")) {
      return new Response(JSON.stringify({ message: SUPABASE_MESSAGE, code: "PGRST301" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
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

test("with no operator credential, deep health still must not call upstream or return error bodies", async () => {
  const net = installFetch();
  try {
    const { GET } = await import("../src/app/api/health/route.ts");
    const response = await GET(
      new NextRequest("https://recruit.example/api/health?deep=1", {
        headers: { accept: "*/*" },
      }),
    );
    const raw = await response.text();
    const upstream = net.calls.filter(
      (call) => call.url.includes(".workable.com") || call.url.includes("/rest/v1/"),
    );
    assert.equal(
      upstream.length === 0 && !raw.includes(WORKABLE_BODY) && !raw.includes(SUPABASE_MESSAGE),
      true,
      `with CRON_SECRET unset, health called ${upstream.map((call) => call.url).join(",")} and returned ${raw.slice(0, 500)}`,
    );
    const body = JSON.parse(raw) as { integrations?: unknown; diagnostics?: unknown; supabase?: unknown };
    assert.equal(body.integrations, undefined);
    assert.equal(body.diagnostics, undefined);
    assert.equal(body.supabase, undefined);
    assert.equal(raw.includes(WORKABLE_BODY), false);
    assert.equal(raw.includes(SUPABASE_MESSAGE), false);
  } finally {
    net.restore();
  }
});
