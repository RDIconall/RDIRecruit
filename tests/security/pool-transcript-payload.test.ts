/**
 * The hiring home page must not ship every stored transcript to the browser.
 *
 * loadTriagePool is what src/app/page.tsx renders for the cross-role inbox and
 * for one job. Full interview text stays on loadOneCandidate, the single
 * applicant read. These tests fail while the pool payload contains the stored
 * evidence transcript, activity body, or working-file transcript.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createMemorySupabase, installServerOnlyMock, installSupabaseMock } from "../helpers/memory-supabase.ts";

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "placeholder-service-key";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.WORKABLE_TOKEN;
delete process.env.WORKABLE_API_KEY;

const EVIDENCE = `${"e".repeat(4_000)}EVIDENCE_BODY_SENTINEL`;
const ACTIVITY = `${"a".repeat(4_000)}ACTIVITY_BODY_SENTINEL`;
const WORKSPACE = `${"w".repeat(4_000)}WORKSPACE_BODY_SENTINEL`;

const supabase = createMemorySupabase({
  jobs: [
    {
      shortcode: "JOB1",
      title: "Clinical Data Manager",
      status: "published",
      department: null,
      location: null,
      raw: null,
    },
  ],
  candidates: [
    {
      workable_id: "cand_real",
      job_shortcode: "JOB1",
      name: "Real Applicant",
      email: "applicant@example.com",
      phone: null,
      location: "Los Angeles, CA",
      stage: "Applied",
      stage_kind: null,
      disqualified: false,
      source: null,
      assignee_id: null,
      raw: null,
      photo_url: null,
      created_at: new Date().toISOString(),
      synced_at: new Date().toISOString(),
    },
  ],
  evidence: [
    {
      id: "ev_1",
      candidate_id: "cand_real",
      source_type: "interview",
      author: "Lara",
      label: "Onsite",
      captured_at: new Date().toISOString(),
      raw_ref: "manual:interview:1",
      transcript: EVIDENCE,
      extracted: { manual: true },
      created_at: new Date().toISOString(),
    },
  ],
  activity: [
    {
      id: "act_1",
      candidate_id: "cand_real",
      type: "interview",
      author: "Ada",
      body: ACTIVITY,
      created_at: new Date().toISOString(),
    },
  ],
  candidate_working_files: [
    {
      candidate_id: "cand_real",
      content: "working file",
      read: null,
      workspace: { transcript: WORKSPACE },
      updated_at: new Date().toISOString(),
      updated_by: "Ada",
    },
  ],
});

installServerOnlyMock();
installSupabaseMock(supabase);

test("cross-role hiring pool omits stored transcript bodies", async () => {
  const { loadTriagePool, CROSS_ROLE_SHORTCODE } = await import("../../src/lib/triage/load.ts");
  const pool = await loadTriagePool(CROSS_ROLE_SHORTCODE);
  const payload = JSON.stringify(pool);
  assert.equal(payload.includes("EVIDENCE_BODY_SENTINEL"), false);
  assert.equal(payload.includes("ACTIVITY_BODY_SENTINEL"), false);
  assert.equal(payload.includes("WORKSPACE_BODY_SENTINEL"), false);
  assert.ok(pool.candidates.some((candidate) => candidate.id === "cand_real"));
});

test("single-job hiring pool omits stored transcript bodies", async () => {
  const { loadTriagePool } = await import("../../src/lib/triage/load.ts");
  const pool = await loadTriagePool("JOB1");
  const payload = JSON.stringify(pool);
  assert.equal(payload.includes("EVIDENCE_BODY_SENTINEL"), false);
  assert.equal(payload.includes("ACTIVITY_BODY_SENTINEL"), false);
  assert.equal(payload.includes("WORKSPACE_BODY_SENTINEL"), false);
  assert.ok(pool.candidates.some((candidate) => candidate.id === "cand_real"));
});

test("single-applicant load still returns the full transcript", async () => {
  const { loadOneCandidate } = await import("../../src/lib/triage/load.ts");
  const one = await loadOneCandidate("cand_real");
  assert.ok(one);
  const payload = JSON.stringify(one);
  assert.equal(payload.includes("EVIDENCE_BODY_SENTINEL"), true);
  assert.equal(payload.includes("WORKSPACE_BODY_SENTINEL"), true);
});
