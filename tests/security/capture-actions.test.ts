/**
 * Spec for uncapped interview capture.
 *
 * These tests fail while a signed-in caller can store an oversized transcript
 * or an unbounded number of captures, and while that write starts a re-score.
 * They pass once every capture below rejects the input before any insert,
 * upsert, or re-score:
 *
 * - src/app/actions/interviews.ts addInterviewEvidence
 * - src/app/actions/interviews.ts addVideoAskAnswers
 * - src/app/actions/triage.ts saveTranscript
 * - src/app/actions/triage.ts logActivity
 *
 * Contract:
 * - Captured text longer than 65536 characters is rejected.
 * - A rejected call writes nothing and does not start a re-score.
 * - One signed-in account can persist at most 40 interview-evidence rows
 *   and at most 40 activity rows.
 * - A transcript of exactly 65536 characters is still accepted once.
 */
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createMemorySupabase, installServerOnlyMock, installSupabaseMock } from "../helpers/memory-supabase.ts";

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "placeholder-service-key";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.WORKABLE_TOKEN;
delete process.env.WORKABLE_API_KEY;

const MAX_CHARS = 65_536;
const MAX_ROWS = 40;

const rescoreCalls: unknown[][] = [];
const supabase = createMemorySupabase({
  candidates: [
    candidate("cand_a"),
    candidate("cand_b"),
  ],
  jobs: [{ shortcode: "JOB1", title: "Clinical Data Manager", status: "published" }],
});

installServerOnlyMock();
installSupabaseMock(supabase);
mock.module("next/cache", {
  namedExports: {
    revalidatePath: () => undefined,
    revalidateTag: () => undefined,
  },
});
const clerkAuth = {
  auth: async () => ({ userId: "user_attacker" }),
  currentUser: async () => ({
    id: "user_attacker",
    firstName: "Ada",
    lastName: "Attacker",
    emailAddresses: [{ emailAddress: "ada@example.com" }],
  }),
};
for (const relative of [
  "node_modules/@clerk/nextjs/dist/esm/server/index.js",
  "node_modules/@clerk/nextjs/dist/cjs/server/index.js",
]) {
  mock.module(pathToFileURL(path.resolve(relative)).href, { namedExports: clerkAuth });
}
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

function candidate(id: string) {
  return {
    workable_id: id,
    job_shortcode: "JOB1",
    name: "Test Candidate",
    email: null,
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
  };
}

function text(length: number): string {
  return "A".repeat(length);
}

async function actions() {
  const interviews = await import("../../src/app/actions/interviews.ts");
  const triage = await import("../../src/app/actions/triage.ts");
  return { ...interviews, ...triage };
}

test("addInterviewEvidence rejects an oversized transcript before insert or rescore", async () => {
  const { addInterviewEvidence } = await actions();
  const before = supabase.rows("evidence").length;
  const callsBefore = rescoreCalls.length;
  const transcript = text(MAX_CHARS + 1);
  const rejected = await isRejected(() =>
    addInterviewEvidence({
      candidateId: "cand_a",
      jobShortcode: "JOB1",
      kind: "phone_screen",
      label: "Phone screen",
      transcript,
    }),
  );
  assert.equal(rejected, true);
  assert.equal(supabase.rows("evidence").length, before);
  assert.equal(rescoreCalls.length, callsBefore);
  assert.equal(supabase.rows("evidence").some((row) => String(row.transcript ?? "").includes(transcript)), false);
});

test("addInterviewEvidence accepts a transcript at the 65536 character cap and rescores once", async () => {
  const { addInterviewEvidence } = await actions();
  const callsBefore = rescoreCalls.length;
  const transcript = text(MAX_CHARS);
  const result = await addInterviewEvidence({
    candidateId: "cand_a",
    jobShortcode: "JOB1",
    kind: "interview",
    label: "Onsite",
    transcript,
  });
  assert.equal(result.ok, true);
  assert.equal(supabase.rows("evidence").some((row) => row.transcript === transcript), true);
  assert.equal(rescoreCalls.length, callsBefore + 1);
  assert.deepEqual(rescoreCalls.at(-1)?.[2], { immediate: true });
});

test("addVideoAskAnswers rejects oversized answers before insert or rescore", async () => {
  const { addVideoAskAnswers } = await actions();
  const before = supabase.rows("evidence").length;
  const callsBefore = rescoreCalls.length;
  const answers = text(MAX_CHARS + 1);
  const rejected = await isRejected(() =>
    addVideoAskAnswers({
      candidateId: "cand_a",
      jobShortcode: "JOB1",
      answers,
    }),
  );
  assert.equal(rejected, true);
  assert.equal(supabase.rows("evidence").length, before);
  assert.equal(rescoreCalls.length, callsBefore);
});

test("one account cannot keep adding interview evidence without a cap", async () => {
  const { addInterviewEvidence } = await actions();
  let accepted = 0;
  for (let i = 0; i < MAX_ROWS + 20; i += 1) {
    const result = await addInterviewEvidence({
      candidateId: i % 2 === 0 ? "cand_a" : "cand_b",
      jobShortcode: "JOB1",
      kind: "phone_screen",
      label: `Round ${i}`,
      transcript: `Short phone screen note ${i} about a protocol deviation.`,
    });
    if (result.ok) accepted += 1;
  }
  assert.ok(accepted <= MAX_ROWS, `accepted ${accepted} evidence rows`);
  assert.equal(
    supabase.rows("evidence").filter((row) => String(row.transcript ?? "").startsWith("Short phone screen")).length,
    accepted,
  );
});

test("saveTranscript rejects an oversized transcript before writing the working file", async () => {
  const { saveTranscript } = await actions();
  const transcript = text(MAX_CHARS + 1);
  const rejected = await isRejected(() => saveTranscript({ candidateId: "cand_a", transcript }));
  assert.equal(rejected, true);
  assert.equal(workingFileContains(transcript), false);
});

test("saveTranscript still stores a transcript inside the cap", async () => {
  const { saveTranscript } = await actions();
  const transcript = "Candidate walked through a deviation log and owned the follow-up.";
  const result = await saveTranscript({ candidateId: "cand_a", transcript });
  assert.equal(result.ok, true);
  assert.equal(workingFileContains(transcript), true);
});

test("logActivity rejects an oversized interview body before insert", async () => {
  const { logActivity } = await actions();
  const before = supabase.rows("activity").length;
  const body = text(MAX_CHARS + 1);
  const rejected = await isRejected(() =>
    logActivity({ candidateId: "cand_a", type: "interview", body }),
  );
  assert.equal(rejected, true);
  assert.equal(supabase.rows("activity").length, before);
});

test("logActivity rejects an oversized note before insert", async () => {
  const { logActivity } = await actions();
  const before = supabase.rows("activity").length;
  const body = text(MAX_CHARS + 1);
  const rejected = await isRejected(() => logActivity({ candidateId: "cand_b", type: "note", body }));
  assert.equal(rejected, true);
  assert.equal(supabase.rows("activity").length, before);
});

test("one account cannot append unbounded activity rows", async () => {
  const { logActivity } = await actions();
  let accepted = 0;
  for (let i = 0; i < MAX_ROWS + 20; i += 1) {
    const result = await logActivity({
      candidateId: i % 2 === 0 ? "cand_a" : "cand_b",
      type: "interview",
      body: `Interview note ${i}`,
    });
    if (result.ok) accepted += 1;
  }
  assert.ok(accepted <= MAX_ROWS, `accepted ${accepted} activity rows`);
  assert.equal(
    supabase.rows("activity").filter((row) => String(row.body ?? "").startsWith("Interview note")).length,
    accepted,
  );
});

function workingFileContains(fragment: string): boolean {
  return supabase.rows("candidate_working_files").some((row) => JSON.stringify(row.workspace ?? {}).includes(fragment));
}

async function isRejected(run: () => Promise<{ ok: boolean }>): Promise<boolean> {
  try {
    const result = await run();
    return result.ok === false;
  } catch {
    return true;
  }
}
