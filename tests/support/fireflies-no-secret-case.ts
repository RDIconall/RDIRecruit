/**
 * Separate process so the route's env parse cannot see a webhook secret.
 * Exits 0 only when an anonymous transcript-id post is refused before any work.
 */
import assert from "node:assert/strict";
import { assertClosed, postFireflies } from "./fireflies-ingest-harness.ts";

delete process.env.FIREFLIES_WEBHOOK_SECRET;
process.env.FIREFLIES_API_KEY = "placeholder-fireflies-api-key";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_SERVICE_KEY = "placeholder-supabase-service-key";
process.env.ANTHROPIC_API_KEY = "placeholder-anthropic-key";

async function main() {
  const outcome = await postFireflies(JSON.stringify({ meetingId: "meeting-without-secret" }), {});
  assert.equal(process.env.FIREFLIES_WEBHOOK_SECRET, undefined);
  assertClosed(outcome, assert);
}

void main();
