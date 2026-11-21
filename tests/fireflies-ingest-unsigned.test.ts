import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { before, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { createMemorySupabase } from "./helpers/memory-supabase.mjs";

const { installMemorySupabaseHook } = createRequire(import.meta.url)(
  "./helpers/install-memory-supabase.cjs",
);
import { TRANSCRIPT_MARKER, overLimitTranscript } from "./helpers/transcript-limit.mjs";

// The route reads configuration when its module is first imported. Set that
// before the import: no webhook secret, no model key, and a placeholder
// Supabase URL so hasSupabase() is true and the handler takes the write path.
delete process.env.FIREFLIES_WEBHOOK_SECRET;
delete process.env.FIREFLIES_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.VIDEOASK_WEBHOOK_SECRET;
delete process.env.WORKABLE_TOKEN;
delete process.env.WORKABLE_API_KEY;
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_SERVICE_KEY = "test-service-key-placeholder";
process.env.NODE_ENV = "development";

type PostHandler = (request: NextRequest) => Promise<Response>;

let ingestFireflies: PostHandler;
let ingestVideoAsk: PostHandler;

installMemorySupabaseHook();

before(async () => {
  ({ POST: ingestFireflies } = await import("../src/app/api/ingest/fireflies/route.ts"));
  ({ POST: ingestVideoAsk } = await import("../src/app/api/hooks/videoask/route.ts"));
});

const CANDIDATE_ID = "app_cand_1";
const APPLICANT_EMAIL = "applicant@example.com";

function useDb() {
  const db = createMemorySupabase();
  globalThis.__RDI_MEMORY_SUPABASE__ = db;
  const now = new Date().toISOString();
  db.seed("jobs", {
    shortcode: "JOB1",
    title: "Clinical Data Manager",
    status: "published",
  });
  db.seed("candidates", {
    workable_id: CANDIDATE_ID,
    job_shortcode: "JOB1",
    name: "Ada Applicant",
    email: APPLICANT_EMAIL,
    disqualified: false,
    created_at: now,
    synced_at: now,
  });
  db.writes.length = 0;
  return db;
}

function firefliesRequest(body: unknown, headers: Record<string, string> = {}) {
  const raw = JSON.stringify(body);
  return new NextRequest("http://localhost/api/ingest/fireflies", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: raw,
  });
}

beforeEach(() => {
  useDb();
});

test("unsigned fireflies transcript is refused before any write", async () => {
  const db = useDb();
  const response = await ingestFireflies(
    firefliesRequest({
      transcript: "A short meeting transcript.",
      metadata: { workable_id: CANDIDATE_ID },
      transcriptId: "meeting-unsigned-short",
    }),
  );
  const payload = await response.json();
  assert.equal(
    response.status,
    401,
    `unsigned ingest must be rejected, got ${response.status} ${JSON.stringify(payload)} writes=${db.writes.map((w) => w.table).join(",")}`,
  );
  assert.equal(db.writes.length, 0, "rejection must not insert events or evidence");
});

test("unsigned oversized fireflies transcript is refused before any write", async () => {
  const db = useDb();
  const response = await ingestFireflies(
    firefliesRequest({
      transcript: overLimitTranscript(),
      metadata: { workable_id: CANDIDATE_ID },
      transcriptId: "meeting-unsigned-large",
    }),
  );
  assert.equal(response.status, 401);
  assert.equal(db.writes.length, 0);
  assert.equal(
    JSON.stringify(db.rows("events")).includes(TRANSCRIPT_MARKER),
    false,
  );
  assert.equal(
    JSON.stringify(db.rows("evidence")).includes(TRANSCRIPT_MARKER),
    false,
  );
});

test("unsigned transcript matched by participant email is refused before any write", async () => {
  const db = useDb();
  const response = await ingestFireflies(
    firefliesRequest({
      transcript: overLimitTranscript(),
      transcriptId: "meeting-email-match",
      organizer_email: "host@company.test",
      participants: [APPLICANT_EMAIL, "host@company.test"],
    }),
  );
  assert.equal(response.status, 401);
  assert.equal(db.writes.length, 0);
});

test("videoask transcription over the cap is refused before any write", async () => {
  const db = useDb();
  const raw = JSON.stringify({
    contact: { email: APPLICANT_EMAIL },
    metadata: { workable_id: CANDIDATE_ID },
    form_response: { response_id: "va-over", transcription: overLimitTranscript() },
  });
  const response = await ingestVideoAsk(
    new NextRequest("http://localhost/api/hooks/videoask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    }),
  );
  const payload = await response.json().catch(() => null);
  assert.ok(
    response.status === 400 || response.status === 413,
    `oversized videoask transcript must be rejected, got ${response.status} ${JSON.stringify(payload)}`,
  );
  assert.equal(db.writes.length, 0, "rejection must not insert events or evidence");
});

test("videoask transcript field over the cap is refused before any write", async () => {
  const db = useDb();
  const raw = JSON.stringify({
    id: "va-body",
    contact: { email: APPLICANT_EMAIL },
    metadata: { workable_id: CANDIDATE_ID },
    transcript: overLimitTranscript(),
  });
  const response = await ingestVideoAsk(
    new NextRequest("http://localhost/api/hooks/videoask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    }),
  );
  assert.ok(response.status === 400 || response.status === 413);
  assert.equal(db.writes.length, 0);
});

test("middleware matcher includes the fireflies ingest route and clerk does not protect it", async () => {
  const { getMiddlewareMatchers } = await import(
    "next/dist/build/analysis/get-page-static-info.js"
  );
  const { getMiddlewareRouteMatcher } = await import(
    "next/dist/shared/lib/router/utils/middleware-route-matcher.js"
  );
  const { config, default: clerkMiddleware } = await import("../src/middleware.ts");

  const matchers = getMiddlewareMatchers(config.matcher, {});
  const matches = getMiddlewareRouteMatcher(matchers);
  assert.equal(matches("/api/ingest/fireflies"), true);
  assert.equal(matches("/api/hooks/videoask"), true);

  const ingest = await clerkMiddleware(
    new NextRequest("http://localhost/api/ingest/fireflies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: "hello", metadata: { workable_id: CANDIDATE_ID } }),
    }),
    { waitUntil() {} },
  );
  const locked = await clerkMiddleware(
    new NextRequest("http://localhost/api/jobs", { method: "GET" }),
    { waitUntil() {} },
  );
  assert.equal(ingest.status, 200);
  assert.equal(ingest.headers.get("location"), null);
  assert.doesNotMatch(ingest.headers.get("x-clerk-auth-reason") ?? "", /protect-rewrite/);
  assert.equal(
    String(ingest.headers.get("x-middleware-rewrite") ?? "").includes("/clerk_"),
    false,
  );
  assert.match(locked.headers.get("x-clerk-auth-reason") ?? "", /protect-rewrite/);
  assert.match(locked.headers.get("x-middleware-rewrite") ?? "", /\/clerk_/);
});
