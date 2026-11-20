import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ATTENDEE_EMAILS,
  TRANSCRIPT_SENTENCE,
  assertClosed,
  firefliesSignature,
  outcomeSummary,
  postFireflies,
  type IngestOutcome,
} from "./support/fireflies-ingest-harness.ts";

/**
 * Security spec for the public Fireflies ingest route.
 *
 * These assertions describe the closed behavior. They fail while an anonymous
 * POST can fetch a meeting with the server Fireflies key, return attendee
 * emails, or store that transcript on a candidate.
 *
 * Gmail ingest (`src/app/api/ingest/gmail/route.ts`) is not covered. It records
 * the caller's own JSON and does not fetch Fireflies or return meeting
 * attendees. The V2 field `meeting_id` is covered below even though the
 * current id parser does not read it.
 */

const WEBHOOK_SECRET = "placeholder-fireflies-webhook-secret";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

process.env.FIREFLIES_API_KEY = "placeholder-fireflies-api-key";
process.env.FIREFLIES_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_SERVICE_KEY = "placeholder-supabase-service-key";
process.env.ANTHROPIC_API_KEY = "placeholder-anthropic-key";
process.env.CLERK_SECRET_KEY = "placeholder-clerk-secret";
// pk_live_ + unpadded base64 of "accounts.example.test$". Parser-shaped
// placeholder, not a Clerk credential (@clerk/shared parsePublishableKey).
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = `pk_live_${Buffer.from("accounts.example.test$")
  .toString("base64")
  .replace(/=+$/, "")}`;

const ID_SHAPES: Record<string, unknown>[] = [
  { transcriptId: "transcript-id" },
  { transcript_id: "transcript-id" },
  { meetingId: "meeting-id" },
  { meeting_id: "meeting-id-v2" },
  { data: { meetingId: "nested-meeting-id" } },
  { data: { transcriptId: "nested-transcript-id" } },
  { data: { id: "nested-data-id" } },
  { transcript: { id: "nested-transcript-object-id" } },
];

function sign(raw: string): string {
  return firefliesSignature(raw, WEBHOOK_SECRET);
}

function firefliesIds(outcome: IngestOutcome): string[] {
  return outcome.calls
    .filter((call) => call.url.startsWith("https://api.fireflies.ai/graphql"))
    .map((call) => {
      const parsed = JSON.parse(call.body ?? "{}") as { variables?: { id?: string } };
      return parsed.variables?.id ?? "";
    });
}

function evidenceBodies(outcome: IngestOutcome): string[] {
  return outcome.calls
    .filter((call) => call.method === "POST" && call.url.includes("/rest/v1/evidence"))
    .map((call) => call.body ?? "");
}

test("middleware lets an anonymous POST reach Fireflies ingest and blocks a private route", async () => {
  const { unstable_doesMiddlewareMatch } = await import(
    "next/dist/experimental/testing/server/middleware-testing-utils.js"
  );
  const { default: middleware, config } = await import("../src/middleware.ts");
  const { NextRequest } = await import("next/server");

  assert.equal(
    unstable_doesMiddlewareMatch({
      config,
      url: "http://127.0.0.1:3000/api/ingest/fireflies",
    }),
    true,
  );

  const ingest = await middleware(
    new NextRequest("http://127.0.0.1:3000/api/ingest/fireflies", {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
    {} as never,
  );
  // Clerk turns next() into a same-path rewrite so the route still runs.
  // protect() would rewrite to /clerk_<timestamp> instead.
  assert.equal(ingest.status, 200);
  assert.equal(ingest.headers.get("x-clerk-auth-status"), "signed-out");
  assert.equal(ingest.headers.get("location"), null);
  const ingestRewrite = ingest.headers.get("x-middleware-rewrite");
  assert.ok(ingestRewrite);
  assert.equal(new URL(ingestRewrite).pathname, "/api/ingest/fireflies");

  const blocked = await middleware(
    new NextRequest("http://127.0.0.1:3000/", { method: "POST" }),
    {} as never,
  );
  const blockedRewrite = blocked.headers.get("x-middleware-rewrite") ?? "";
  assert.match(new URL(blockedRewrite).pathname, /^\/clerk_/);
  assert.equal(blocked.headers.get("x-middleware-next"), null);
});

test("anonymous transcript-id shapes are refused before any fetch, write, or email disclosure", async () => {
  const leaks: unknown[] = [];
  for (const payload of ID_SHAPES) {
    const outcome = await postFireflies(JSON.stringify(payload), {});
    const disclosed = ATTENDEE_EMAILS.some((email) => outcome.body.includes(email));
    if (outcome.status !== 401 || outcome.calls.length > 0 || outcome.thrown || disclosed) {
      leaks.push({ payload, ...JSON.parse(outcomeSummary(outcome)) });
    }
  }
  assert.deepEqual(leaks, []);
});

test("anonymous transcript id plus a candidate id does not store the meeting or rescore", async () => {
  const outcome = await postFireflies(
    JSON.stringify({ meetingId: "meeting-to-steal", candidate_id: "victim-candidate" }),
    {},
  );
  assertClosed(outcome, assert);
  assert.equal(outcome.body.includes("victim-candidate"), false);
});

test("anonymous inline transcript is not stored on a named candidate", async () => {
  const outcome = await postFireflies(
    JSON.stringify({
      candidate_id: "victim-candidate",
      transcript: "Inline interview notes that must not be stored.",
      participants: [ATTENDEE_EMAILS[0]],
    }),
    {},
  );
  assertClosed(outcome, assert);
});

test("a signature over a different body does not authorize the body that was sent", async () => {
  const authorized = JSON.stringify({ meetingId: "authorized-meeting" });
  const presented = JSON.stringify({
    meetingId: "victim-meeting",
    candidate_id: "victim-candidate",
  });
  const outcome = await postFireflies(presented, { "x-hub-signature": sign(authorized) });
  assertClosed(outcome, assert);
  assert.deepEqual(firefliesIds(outcome), []);
});

test("a signature that is not the raw-body HMAC is refused", async () => {
  const raw = JSON.stringify({ meetingId: "meeting-id" });
  const spaced = JSON.stringify({ meetingId: "meeting-id" }, null, 2);
  assert.notEqual(raw, spaced);
  const outcome = await postFireflies(raw, { "x-hub-signature": sign(spaced) });
  assertClosed(outcome, assert);

  const wrongSecret = firefliesSignature(raw, "placeholder-wrong-secret");
  const forged = await postFireflies(raw, { "x-hub-signature": wrongSecret });
  assertClosed(forged, assert);

  const truncated = await postFireflies(raw, { "x-hub-signature": "sha256=abcd" });
  assertClosed(truncated, assert);
});

test("a signed meeting id does not disclose attendees or attach to an unsigned candidate", async () => {
  const raw = JSON.stringify({ meetingId: "signed-meeting" });
  const outcome = await postFireflies(raw, { "x-hub-signature": sign(raw) }, "/api/ingest/fireflies?candidate_id=victim-candidate");
  const summary = outcomeSummary(outcome);
  for (const email of ATTENDEE_EMAILS) {
    assert.equal(outcome.body.includes(email), false, summary);
  }
  assert.equal(evidenceBodies(outcome).length, 0, summary);
  assert.equal(outcome.body.includes("victim-candidate"), false, summary);
  for (const id of firefliesIds(outcome)) {
    assert.equal(id, "signed-meeting", summary);
  }
  const rescore = outcome.calls.filter(
    (call) => call.url.includes("victim-candidate") || call.url.includes("/rest/v1/evaluations"),
  );
  assert.equal(rescore.length, 0, summary);
});

test("a signed body attaches the fetched transcript only to the candidate it names", async () => {
  const raw = JSON.stringify({
    meetingId: "signed-meeting",
    candidate_id: "authorized-candidate",
  });
  const outcome = await postFireflies(raw, {
    "x-hub-signature": sign(raw),
    "x-candidate-id": "victim-candidate",
  });
  const summary = outcomeSummary(outcome);
  assert.deepEqual(firefliesIds(outcome), ["signed-meeting"], summary);
  const stored = evidenceBodies(outcome);
  assert.equal(stored.length, 1, summary);
  assert.equal(stored[0].includes("authorized-candidate"), true, summary);
  assert.equal(stored[0].includes(TRANSCRIPT_SENTENCE), true, summary);
  assert.equal(stored[0].includes("victim-candidate"), false, summary);
  for (const email of ATTENDEE_EMAILS) {
    assert.equal(outcome.body.includes(email), false, summary);
  }
  const actedOnVictim = outcome.calls.some(
    (call) =>
      call.url.includes("victim-candidate") ||
      (call.method === "POST" && (call.body ?? "").includes("victim-candidate")),
  );
  assert.equal(actedOnVictim, false, summary);
});

test("missing webhook secret still refuses an anonymous transcript fetch", () => {
  const env = { ...process.env };
  delete env.FIREFLIES_WEBHOOK_SECRET;
  const result = spawnSync(
    path.join(root, "node_modules/.bin/tsx"),
    [path.join(root, "tests/support/fireflies-no-secret-case.ts")],
    { cwd: root, env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
