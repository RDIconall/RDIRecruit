import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import {
  INGEST_ROUTES,
  MAX_BODY_BYTES,
  PLACEHOLDER_SECRETS,
  RATE_LIMIT,
  SERVICE_KEY,
  SUPABASE_URL,
  assertEventInsert,
  assertNoWrites,
  credentialHeaders,
  installFetchRecorder,
  jsonOfByteLength,
  postRaw,
  type FetchRecorder,
  type IngestRoute,
} from "./event-queue-attack.harness.ts";

process.env.SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY = SERVICE_KEY;
process.env.WORKABLE_TOKEN = "placeholder-workable-token";
for (const [name, value] of Object.entries(PLACEHOLDER_SECRETS)) {
  process.env[name] = value;
}

let recorder: FetchRecorder;
let ip = 40;

beforeEach(() => {
  recorder = installFetchRecorder();
});

function nextIp(): string {
  ip += 1;
  return `203.0.113.${ip}`;
}

function smallRequest(route: IngestRoute): { raw: string; payload: Record<string, unknown>; type: string } {
  if (route.name === "workable") {
    const payload = { event_type: "candidate_created" };
    return { raw: JSON.stringify(payload), payload, type: "candidate_created" };
  }
  const payload = { ping: "ok" };
  return { raw: JSON.stringify(payload), payload, type: route.type };
}

describe("event queue ingest with a configured secret", () => {
  for (const route of INGEST_ROUTES) {
    const secret = PLACEHOLDER_SECRETS[route.secretEnv];

    test(`${route.name} rejects a mismatched credential and writes nothing`, async () => {
      const { POST } = await route.load();
      const { raw } = smallRequest(route);
      const response = await postRaw(POST, route.path, raw, {
        "x-forwarded-for": nextIp(),
        ...credentialHeaders(route, raw, "no"),
      });
      assert.equal(response.status, 401);
      assertNoWrites(recorder);
    });

    test(`${route.name} records one unprocessed event when the credential matches`, async () => {
      const { POST } = await route.load();
      const { raw, payload, type } = smallRequest(route);
      const response = await postRaw(POST, route.path, raw, {
        "x-forwarded-for": nextIp(),
        ...credentialHeaders(route, raw, secret),
      });
      assert.equal(response.status, 200);
      assertEventInsert(recorder, route, { type, payload });
    });

    test(`${route.name} accepts a body of exactly ${MAX_BODY_BYTES} bytes`, async () => {
      const { POST } = await route.load();
      const raw = jsonOfByteLength(MAX_BODY_BYTES);
      assert.equal(Buffer.byteLength(raw), MAX_BODY_BYTES);
      const response = await postRaw(POST, route.path, raw, {
        "x-forwarded-for": nextIp(),
        ...credentialHeaders(route, raw, secret),
      });
      assert.equal(response.status, 200);
      const payload = JSON.parse(raw) as Record<string, unknown>;
      const type = route.name === "workable" ? "unknown" : route.type;
      assertEventInsert(recorder, route, { type, payload });
    });

    test(`${route.name} rejects a body of ${MAX_BODY_BYTES + 1} bytes and writes nothing`, async () => {
      const { POST } = await route.load();
      const raw = jsonOfByteLength(MAX_BODY_BYTES + 1);
      assert.equal(Buffer.byteLength(raw), MAX_BODY_BYTES + 1);
      const response = await postRaw(POST, route.path, raw, {
        "x-forwarded-for": nextIp(),
        ...credentialHeaders(route, raw, secret),
      });
      assert.equal(response.status, 413);
      assertNoWrites(recorder);
    });

    test(`${route.name} rejects a non-JSON body after a valid credential and writes nothing`, async () => {
      const { POST } = await route.load();
      const raw = "not-json";
      let response: Response | undefined;
      try {
        response = await postRaw(POST, route.path, raw, {
          "x-forwarded-for": nextIp(),
          ...credentialHeaders(route, raw, secret),
        });
      } catch {
        response = undefined;
      }
      assert.ok(response, `${route.name} threw instead of returning 400`);
      assert.equal(response.status, 400);
      assertNoWrites(recorder);
    });

    test(`${route.name} rate-limits the 11th accepted write from one address`, async () => {
      const { POST } = await route.load();
      const client = nextIp();
      for (let n = 0; n < RATE_LIMIT; n += 1) {
        const { raw } = smallRequest(route);
        const response = await postRaw(POST, route.path, raw, {
          "x-forwarded-for": client,
          ...credentialHeaders(route, raw, secret),
        });
        assert.equal(response.status, 200, `accepted write ${n + 1} should succeed`);
      }
      assert.equal(recorder.eventInserts().length, RATE_LIMIT);
      const extra = smallRequest(route);
      const blocked = await postRaw(POST, route.path, extra.raw, {
        "x-forwarded-for": client,
        ...credentialHeaders(route, extra.raw, secret),
      });
      assert.equal(blocked.status, 429);
      assert.equal(recorder.eventInserts().length, RATE_LIMIT);

      const other = smallRequest(route);
      const allowed = await postRaw(POST, route.path, other.raw, {
        "x-forwarded-for": nextIp(),
        ...credentialHeaders(route, other.raw, secret),
      });
      assert.equal(allowed.status, 200);
      assert.equal(recorder.eventInserts().length, RATE_LIMIT + 1);
    });
  }
});

test("the hiring sync drains only unprocessed workable events", async () => {
  const { processPendingWorkableEvents } = await import("../src/lib/sync/incremental-sync.ts");
  await processPendingWorkableEvents({ limit: 5, budgetMs: 1_000 });
  const reads = recorder.calls.filter((call) => call.method === "GET" && call.url.includes("/rest/v1/events"));
  assert.ok(reads.length >= 1, "sync should query the events table");
  for (const read of reads) {
    const url = new URL(read.url);
    assert.equal(url.searchParams.get("source"), "eq.workable");
    assert.equal(url.searchParams.get("processed"), "eq.false");
    assert.equal(url.searchParams.get("source")?.includes("gmail"), false);
  }
  assert.equal(recorder.eventInserts().length, 0);
});
