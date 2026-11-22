/**
 * Public transcript ingest shares the uncapped-evidence bug.
 *
 * /api/ingest/fireflies is outside Clerk (see src/middleware.ts) and stores
 * the posted transcript with no length or count check, then re-scores.
 * These tests fail until an oversized or excess body is refused before the
 * events insert, the evidence insert, and the re-score.
 */
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createMemorySupabase, installServerOnlyMock, installSupabaseMock } from "../helpers/memory-supabase.ts";

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "placeholder-service-key";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.VIDEOASK_WEBHOOK_SECRET;
delete process.env.FIREFLIES_API_KEY;
delete process.env.WORKABLE_TOKEN;
delete process.env.WORKABLE_API_KEY;

const MAX_CHARS = 65_536;
const MAX_ROWS = 40;
const rescoreCalls: unknown[][] = [];

const supabase = createMemorySupabase({
  candidates: [
    {
      workable_id: "cand_real",
      job_shortcode: "JOB1",
      name: "Real Applicant",
      email: "applicant@example.com",
      created_at: new Date().toISOString(),
      synced_at: new Date().toISOString(),
      disqualified: false,
    },
  ],
});

installServerOnlyMock();
installSupabaseMock(supabase);
installRescoreSpy();

function installRescoreSpy() {
  const exports = {
    rescoreCandidateOnNewEvidence: async (...args: unknown[]) => {
      rescoreCalls.push(args);
      return { scored: false, reason: "not_configured" as const };
    },
    loadInterviewEvidenceText: async () => "",
    loadRecruiterCommentsText: async () => "",
  };
  const href = pathToFileURL(path.resolve("src/lib/sync/rescore.ts")).href;
  mock.module(href, { namedExports: exports });
}

test("fireflies ingest rejects an oversized inline transcript before any write or rescore", async () => {
  const { POST } = await import("../../src/app/api/ingest/fireflies/route.ts");
  const { NextRequest } = await import("next/server");
  const transcript = "B".repeat(MAX_CHARS + 1);
  const beforeEvidence = supabase.rows("evidence").length;
  const beforeEvents = supabase.rows("events").length;
  const callsBefore = rescoreCalls.length;

  const response = await POST(
    new NextRequest("http://localhost/api/ingest/fireflies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript, workable_id: "cand_real" }),
    }),
  );

  assert.equal(response.ok, false);
  assert.equal(supabase.rows("evidence").length, beforeEvidence);
  assert.equal(supabase.rows("events").length, beforeEvents);
  assert.equal(rescoreCalls.length, callsBefore);
  assert.equal(supabase.rows("evidence").some((row) => String(row.transcript ?? "").includes(transcript)), false);
});

test("fireflies ingest rejects an oversized sentences array before any write", async () => {
  const { POST } = await import("../../src/app/api/ingest/fireflies/route.ts");
  const { NextRequest } = await import("next/server");
  const sentence = "C".repeat(MAX_CHARS + 1);
  const beforeEvidence = supabase.rows("evidence").length;
  const beforeEvents = supabase.rows("events").length;

  const response = await POST(
    new NextRequest("http://localhost/api/ingest/fireflies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sentences: [{ speaker_name: "Candidate", text: sentence }],
        workable_id: "cand_real",
      }),
    }),
  );

  assert.equal(response.ok, false);
  assert.equal(supabase.rows("evidence").length, beforeEvidence);
  assert.equal(supabase.rows("events").length, beforeEvents);
});

test("fireflies ingest still stores a short transcript and starts a rescore", async () => {
  const { POST } = await import("../../src/app/api/ingest/fireflies/route.ts");
  const { NextRequest } = await import("next/server");
  const callsBefore = rescoreCalls.length;
  const response = await POST(
    new NextRequest("http://localhost/api/ingest/fireflies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        transcript: "Short Fireflies transcript about a monitoring visit.",
        workable_id: "cand_real",
        transcriptId: "meeting-short-1",
      }),
    }),
  );
  assert.equal(response.ok, true);
  assert.equal(
    supabase.rows("evidence").some((row) => row.transcript === "Short Fireflies transcript about a monitoring visit."),
    true,
  );
  assert.equal(rescoreCalls.length, callsBefore + 1);
  assert.equal(rescoreCalls.at(-1)?.[0], "cand_real");
});

test("fireflies ingest stops accepting more transcripts for one candidate after the cap", async () => {
  const { POST } = await import("../../src/app/api/ingest/fireflies/route.ts");
  const { NextRequest } = await import("next/server");
  let accepted = 0;
  for (let i = 0; i < MAX_ROWS + 15; i += 1) {
    const response = await POST(
      new NextRequest("http://localhost/api/ingest/fireflies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          transcript: `Visit note ${i}`,
          workable_id: "cand_real",
          transcriptId: `meeting-${i}`,
        }),
      }),
    );
    if (response.ok) {
      const body = (await response.json()) as { ok?: boolean; skipped?: string };
      if (body.ok && !body.skipped) accepted += 1;
    }
  }
  assert.ok(accepted <= MAX_ROWS, `accepted ${accepted} fireflies transcripts`);
});
