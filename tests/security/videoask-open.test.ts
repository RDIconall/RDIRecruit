/**
 * With VIDEOASK_WEBHOOK_SECRET unset, isAuthorized accepts every caller.
 * An oversized transcript must still be refused before the events insert,
 * the evidence insert, and the re-score.
 */
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createMemorySupabase, installServerOnlyMock, installSupabaseMock } from "../helpers/memory-supabase.ts";

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "placeholder-service-key";
delete process.env.VIDEOASK_WEBHOOK_SECRET;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.WORKABLE_TOKEN;
delete process.env.WORKABLE_API_KEY;

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
mock.module(pathToFileURL(path.resolve("src/lib/sync/rescore.ts")).href, {
  namedExports: {
    rescoreCandidateOnNewEvidence: async () => ({ scored: false, reason: "not_configured" as const }),
    loadInterviewEvidenceText: async () => "",
    loadRecruiterCommentsText: async () => "",
  },
});

test("unsigned VideoAsk webhook rejects an oversized transcript before any write", async () => {
  const { POST } = await import("../../src/app/api/hooks/videoask/route.ts");
  const { NextRequest } = await import("next/server");
  const answers = "F".repeat(65_537);
  const beforeEvidence = supabase.rows("evidence").length;
  const beforeEvents = supabase.rows("events").length;
  const response = await POST(
    new NextRequest("http://localhost/api/hooks/videoask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        transcript: answers,
        contact: { email: "applicant@example.com" },
        id: "open-oversize",
      }),
    }),
  );
  assert.equal(response.ok, false);
  assert.equal(supabase.rows("evidence").length, beforeEvidence);
  assert.equal(supabase.rows("events").length, beforeEvents);
  assert.equal(supabase.rows("evidence").some((row) => String(row.transcript ?? "").includes(answers)), false);
});
