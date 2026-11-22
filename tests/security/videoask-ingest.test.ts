/**
 * VideoAsk webhook shares the uncapped-evidence bug.
 *
 * When VIDEOASK_WEBHOOK_SECRET is unset the route accepts any caller
 * (src/app/api/hooks/videoask/route.ts). A signed caller must hit the same
 * length and count checks. Oversized answers are rejected before the events
 * insert, the evidence insert, and the re-score.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mock, test } from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createMemorySupabase, installServerOnlyMock, installSupabaseMock } from "../helpers/memory-supabase.ts";

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "placeholder-service-key";
process.env.VIDEOASK_WEBHOOK_SECRET = "test-videoask-secret";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.WORKABLE_TOKEN;
delete process.env.WORKABLE_API_KEY;

const MAX_CHARS = 65_536;
const MAX_ROWS = 40;
const SECRET = "test-videoask-secret";
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

function signedBody(payload: unknown): { body: string; signature: string } {
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", SECRET).update(body).digest("hex");
  return { body, signature };
}

test("signed VideoAsk answers over the cap are rejected before any write or rescore", async () => {
  const { POST } = await import("../../src/app/api/hooks/videoask/route.ts");
  const { NextRequest } = await import("next/server");
  const answers = "D".repeat(MAX_CHARS + 1);
  const { body, signature } = signedBody({
    transcript: answers,
    contact: { email: "applicant@example.com" },
    metadata: { workable_id: "cand_real" },
    id: "response-oversize",
  });
  const beforeEvidence = supabase.rows("evidence").length;
  const beforeEvents = supabase.rows("events").length;
  const callsBefore = rescoreCalls.length;

  const response = await POST(
    new NextRequest("http://localhost/api/hooks/videoask", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-videoask-signature": signature,
      },
      body,
    }),
  );

  assert.equal(response.ok, false);
  assert.equal(supabase.rows("evidence").length, beforeEvidence);
  assert.equal(supabase.rows("events").length, beforeEvents);
  assert.equal(rescoreCalls.length, callsBefore);
});

test("signed VideoAsk transcription field over the cap is rejected before any write", async () => {
  const { POST } = await import("../../src/app/api/hooks/videoask/route.ts");
  const { NextRequest } = await import("next/server");
  const answers = "E".repeat(MAX_CHARS + 1);
  const { body, signature } = signedBody({
    form_response: { response_id: "form-oversize", transcription: answers },
    contact: { email: "applicant@example.com" },
  });
  const beforeEvidence = supabase.rows("evidence").length;
  const beforeEvents = supabase.rows("events").length;

  const response = await POST(
    new NextRequest("http://localhost/api/hooks/videoask", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-videoask-signature": signature,
      },
      body,
    }),
  );

  assert.equal(response.ok, false);
  assert.equal(supabase.rows("evidence").length, beforeEvidence);
  assert.equal(supabase.rows("events").length, beforeEvents);
});

test("a signed short VideoAsk answer is stored and re-scored", async () => {
  const { POST } = await import("../../src/app/api/hooks/videoask/route.ts");
  const { NextRequest } = await import("next/server");
  const { body, signature } = signedBody({
    transcript: "I led the database lock for one study.",
    contact: { email: "applicant@example.com" },
    metadata: { workable_id: "cand_real" },
    id: "response-short",
  });
  const callsBefore = rescoreCalls.length;
  const response = await POST(
    new NextRequest("http://localhost/api/hooks/videoask", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-videoask-signature": signature,
      },
      body,
    }),
  );
  assert.equal(response.ok, true);
  assert.equal(
    supabase.rows("evidence").some((row) => row.transcript === "I led the database lock for one study."),
    true,
  );
  assert.equal(rescoreCalls.length, callsBefore + 1);
});

test("VideoAsk ingest stops after the per-candidate capture cap", async () => {
  const { POST } = await import("../../src/app/api/hooks/videoask/route.ts");
  const { NextRequest } = await import("next/server");
  let accepted = 0;
  for (let i = 0; i < MAX_ROWS + 15; i += 1) {
    const { body, signature } = signedBody({
      transcript: `Answer ${i}`,
      contact: { email: "applicant@example.com" },
      metadata: { workable_id: "cand_real" },
      id: `response-${i}`,
    });
    const response = await POST(
      new NextRequest("http://localhost/api/hooks/videoask", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-videoask-signature": signature,
        },
        body,
      }),
    );
    if (response.ok) {
      const payload = (await response.json()) as { ok?: boolean; skipped?: string };
      if (payload.ok && !payload.skipped) accepted += 1;
    }
  }
  assert.ok(accepted <= MAX_ROWS, `accepted ${accepted} VideoAsk answers`);
});

test("a bad VideoAsk signature stores nothing", async () => {
  const { POST } = await import("../../src/app/api/hooks/videoask/route.ts");
  const { NextRequest } = await import("next/server");
  const beforeEvidence = supabase.rows("evidence").length;
  const response = await POST(
    new NextRequest("http://localhost/api/hooks/videoask", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-videoask-signature": "0".repeat(64),
      },
      body: JSON.stringify({
        transcript: "Should not store",
        metadata: { workable_id: "cand_real" },
      }),
    }),
  );
  assert.equal(response.status, 401);
  assert.equal(supabase.rows("evidence").length, beforeEvidence);
});
