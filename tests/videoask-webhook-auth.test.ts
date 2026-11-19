/**
 * VideoAsk webhook authorization.
 *
 * These tests describe the safe behavior. They fail while a missing or blank
 * VIDEOASK_WEBHOOK_SECRET still accepts a public POST, stores the body as
 * async-video evidence, and lets the batch projection replace the review.
 *
 * Run:
 *   node --import tsx --import ./tests/support/register-hooks.mjs --test tests/videoask-webhook-auth.test.ts
 *
 * The harness stubs Supabase and the Anthropic SDK (tests/support). The route,
 * rescore, grader prompt, and working-file projection are the application code.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { createRouteMatcher } from "@clerk/nextjs/server";
import { POST } from "../src/app/api/hooks/videoask/route";
import { GET as runAnalysisBatches } from "../src/app/api/cron/analysis-batches/route";
import { env } from "../src/lib/env";
import { loadOneCandidate } from "../src/lib/triage/load";
import { batchCount, graderPrompts, markBatchesEnded, resetAnthropic } from "./support/fake-anthropic.cjs";
import { getServiceSupabase, resetDb, tableRows } from "./support/fake-supabase.cjs";

const TARGET_ID = "cand-target";
const OTHER_ID = "cand-other";
const TARGET_EMAIL = "applicant@example.com";
const FORGED_TRANSCRIPT =
  "FORGED-VIDEO-TRANSCRIPT I personally owned the audit and ran the raise.";
const RESUME =
  "Office coordinator for six years. Scheduled interviews, kept the hiring calendar, and wrote the weekly staffing note for the hiring manager.";

function setVideoAskSecret(secret: string | undefined) {
  env.VIDEOASK_WEBHOOK_SECRET = secret;
}

function seedCandidate() {
  resetDb();
  resetAnthropic();
  const now = new Date().toISOString();
  const db = {
    candidates: [
      {
        workable_id: TARGET_ID,
        email: TARGET_EMAIL,
        name: "Alex Applicant",
        job_shortcode: "OFFICECOORD",
        stage: "applied",
        disqualified: false,
        created_at: now,
        location: "Los Angeles, CA",
        raw: null,
      },
      {
        workable_id: OTHER_ID,
        email: "someone-else@example.com",
        name: "Other Applicant",
        job_shortcode: "OFFICECOORD",
        stage: "applied",
        disqualified: false,
        created_at: now,
        location: "Los Angeles, CA",
        raw: null,
      },
    ],
    jobs: [
      {
        shortcode: "OFFICECOORD",
        title: "Office Coordinator",
        department: "Operations",
        location: "Van Nuys, CA",
        raw: {
          full_description:
            "Coordinate interviews, calendars, and candidate logistics for the Van Nuys office. Write clearly and follow through on scheduling commitments.",
        },
      },
    ],
    applications: [
      {
        candidate_id: TARGET_ID,
        resume_text: RESUME,
        answers: {},
        cover_letter: null,
        parsed_experience: [],
        resume_url: null,
        resume_storage_path: null,
      },
    ],
    candidate_working_files: [
      {
        candidate_id: TARGET_ID,
        content: "# Candidate: Alex Applicant\n\n- Decision: Negative\n",
        read: {
          decision: "reject",
          why: "Human cut. Do not interview.",
          risk: "",
          next: "Reject",
          value: { headline: "Ask not stated", level: "none", detail: "" },
          recalculatedAt: now,
          model: "reviewer",
        },
        workspace: { decisionOverride: "reject" },
        updated_at: now,
        updated_by: "reviewer",
      },
    ],
    evaluations: [
      {
        id: "fit-existing",
        candidate_id: TARGET_ID,
        kind: "fit_read",
        ref: "OFFICECOORD",
        model_version: "claude-sonnet-5",
        payload: {
          reply: "Do not pursue.",
          sentiment: "negative",
          appliedFit: "",
          rdiFit: "",
          suggestedSeat: "",
        },
        created_at: now,
      },
    ],
  };

  // Seed through the same client the route uses, so inserts get ids the
  // projection queries can find. Direct table writes go through reset + the
  // public rows helper's backing store via the route's client... we don't
  // export a raw insert. Use getServiceSupabase from the fake.
  return db;
}

async function installFixture() {
  resetDb();
  resetAnthropic();
  const fixture = seedCandidate();
  const supabase = getServiceSupabase();
  for (const [table, rows] of Object.entries(fixture)) {
    const { error } = await supabase.from(table).insert(rows);
    if (error) throw new Error(`fixture ${table}: ${error.message}`);
  }
}

beforeEach(() => {
  setVideoAskSecret(undefined);
});

afterEach(() => {
  setVideoAskSecret(undefined);
});

function request(body: unknown, headers: Record<string, string> = {}) {
  const raw = JSON.stringify(body);
  return new NextRequest("http://localhost/api/hooks/videoask", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: raw,
  });
}

async function post(body: unknown, headers: Record<string, string> = {}) {
  let status = 0;
  let json: unknown = null;
  let thrown: string | null = null;
  try {
    const response = await POST(request(body, headers));
    status = response.status;
    json = await response.json();
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  }
  return { status, json, thrown };
}

async function projectQueuedAnalyses() {
  markBatchesEnded();
  const response = await runAnalysisBatches(
    new NextRequest("http://localhost/api/cron/analysis-batches", {
      headers: { authorization: `Bearer ${env.CRON_SECRET}` },
    }),
  );
  const json = await response.json();
  return { status: response.status, json };
}

function forgedBody(overrides: Record<string, unknown> = {}) {
  return {
    contact: { email: TARGET_EMAIL },
    transcript: FORGED_TRANSCRIPT,
    ...overrides,
  };
}

async function attackSnapshot() {
  const evidence = tableRows("evidence");
  const events = tableRows("events");
  const analyses = tableRows("candidate_analyses");
  const working = tableRows("candidate_working_files").find((row) => row.candidate_id === TARGET_ID);
  const view = await loadOneCandidate(TARGET_ID);
  const prompts = graderPrompts();
  return {
    evidenceForTarget: evidence.filter((row) => row.candidate_id === TARGET_ID).length,
    evidenceForOther: evidence.filter((row) => row.candidate_id === OTHER_ID).length,
    events: events.length,
    analyses: analyses.length,
    batches: batchCount(),
    promptHasTranscript: prompts.some((prompt) => prompt.includes(FORGED_TRANSCRIPT)),
    override: (working?.workspace as { decisionOverride?: string | null } | undefined)?.decisionOverride ?? null,
    decision: view?.candidate.decision ?? null,
  };
}

async function expectRejected(body: unknown, headers: Record<string, string> = {}) {
  const before = await loadOneCandidate(TARGET_ID);
  assert.equal(before?.candidate.decision, "reject");
  const result = await post(body, headers);
  const projected = await projectQueuedAnalyses();
  const after = await attackSnapshot();
  assert.deepEqual(
    {
      status: result.status,
      thrown: result.thrown,
      body: result.json,
      cronStatus: projected.status,
      ...after,
    },
    {
      status: 401,
      thrown: null,
      body: result.status === 401 ? result.json : { error: "Invalid signature" },
      cronStatus: 200,
      evidenceForTarget: 0,
      evidenceForOther: 0,
      events: 0,
      analyses: 0,
      batches: 0,
      promptHasTranscript: false,
      override: "reject",
      decision: "reject",
    },
  );
  const encoded = JSON.stringify(result.json ?? {});
  assert.equal(encoded.includes(TARGET_ID), false);
  assert.equal(encoded.includes(OTHER_ID), false);
  assert.equal(encoded.includes("candidate_not_resolved"), false);
  assert.equal(encoded.includes("no_candidate_reference"), false);
  assert.equal(encoded.includes("candidateId"), false);
}

test("Clerk middleware treats /api/hooks/videoask as a public route", () => {
  const source = readFileSync(new URL("../src/middleware.ts", import.meta.url), "utf8");
  const block = source.match(/createRouteMatcher\(\[([\s\S]*?)\]\)/);
  assert.ok(block, "middleware must declare a public route matcher");
  const patterns = [...block[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((match) => match[1]);
  const isPublic = createRouteMatcher(patterns);
  assert.equal(isPublic(new NextRequest("http://localhost/api/hooks/videoask")), true);
  assert.equal(isPublic(new NextRequest("http://localhost/applicants")), false);
});

test("unset secret rejects a transcript addressed by contact email", async () => {
  await installFixture();
  await expectRejected(forgedBody());
});

test("unset secret rejects a transcript addressed by respondent email", async () => {
  await installFixture();
  await expectRejected({
    respondent: { email: TARGET_EMAIL },
    transcript: FORGED_TRANSCRIPT,
  });
});

test("unset secret rejects a transcript addressed by metadata.candidate_id", async () => {
  await installFixture();
  await expectRejected({
    metadata: { candidate_id: TARGET_EMAIL },
    transcript: FORGED_TRANSCRIPT,
  });
});

test("unset secret rejects a client-supplied workable id when the email does not resolve", async () => {
  await installFixture();
  await expectRejected({
    contact: { email: "nobody@example.com" },
    metadata: { workable_id: TARGET_ID },
    transcript: FORGED_TRANSCRIPT,
  });
});

test("unset secret rejects a form transcription with no top-level transcript", async () => {
  await installFixture();
  await expectRejected({
    contact: { email: TARGET_EMAIL },
    form_response: { response_id: "resp-forged", transcription: FORGED_TRANSCRIPT },
  });
});

test("a blank secret rejects the same way an unset secret must", async () => {
  await installFixture();
  setVideoAskSecret("");
  await expectRejected(forgedBody());
});

test("an unknown email and a known email get the same rejection and do not reveal which resolved", async () => {
  await installFixture();
  const known = await post(forgedBody());
  const knownSideEffects = await attackSnapshot();
  resetDb();
  resetAnthropic();
  await installFixture();
  const unknown = await post({
    contact: { email: "nobody@example.com" },
    transcript: FORGED_TRANSCRIPT,
  });
  assert.equal(known.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(JSON.stringify(known.json), JSON.stringify(unknown.json));
  assert.equal(JSON.stringify(known.json).includes(TARGET_ID), false);
  assert.equal(knownSideEffects.evidenceForTarget, 0);
  assert.equal(knownSideEffects.events, 0);
  assert.equal((await attackSnapshot()).evidenceForTarget, 0);
});

test("a configured secret with no proof rejects before any write", async () => {
  await installFixture();
  setVideoAskSecret("placeholder-videoask-secret");
  await expectRejected(forgedBody());
});

test("a configured secret with the wrong shared-secret header rejects before any write", async () => {
  await installFixture();
  setVideoAskSecret("placeholder-videoask-secret");
  await expectRejected(forgedBody(), { "x-videoask-secret": "placeholder-wrong-secret" });
});

test("a configured secret with an HMAC of a different body rejects before any write", async () => {
  await installFixture();
  const secret = "placeholder-videoask-secret";
  setVideoAskSecret(secret);
  const digest = createHmac("sha256", secret).update("{\"contact\":{}}").digest("hex");
  await expectRejected(forgedBody(), { "x-videoask-signature": digest });
});

test("a valid shared secret stores async-video evidence for the email match, not a different workable id", async () => {
  await installFixture();
  const secret = "placeholder-videoask-secret";
  setVideoAskSecret(secret);
  const result = await post(
    forgedBody({ metadata: { workable_id: OTHER_ID } }),
    { "x-videoask-secret": secret },
  );
  assert.equal(result.thrown, null);
  assert.equal(result.status, 200);
  const evidence = tableRows("evidence");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].candidate_id, TARGET_ID);
  assert.equal(evidence[0].source_type, "async_video");
  assert.equal(evidence[0].author, "candidate");
  assert.equal(evidence[0].transcript, FORGED_TRANSCRIPT);
  assert.equal(tableRows("evidence").some((row) => row.candidate_id === OTHER_ID), false);
});

test("the videoask-secret header alias is accepted only when it matches the configured secret", async () => {
  await installFixture();
  const secret = "placeholder-videoask-secret";
  setVideoAskSecret(secret);
  const result = await post(forgedBody(), { "videoask-secret": secret });
  assert.equal(result.status, 200);
  assert.equal(tableRows("evidence")[0]?.candidate_id, TARGET_ID);
  assert.equal(tableRows("evidence")[0]?.transcript, FORGED_TRANSCRIPT);
});

test("a valid HMAC lets the planted transcript reach the grader and replace a human cut", async () => {
  await installFixture();
  const secret = "placeholder-videoask-secret";
  setVideoAskSecret(secret);
  const raw = JSON.stringify(forgedBody());
  const digest = createHmac("sha256", secret).update(raw).digest("hex");
  const response = await POST(
    new NextRequest("http://localhost/api/hooks/videoask", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "videoask-signature": digest,
      },
      body: raw,
    }),
  );
  assert.equal(response.status, 200);
  const prompts = graderPrompts();
  assert.equal(prompts.length > 0, true);
  assert.equal(prompts.some((prompt) => prompt.includes(FORGED_TRANSCRIPT)), true);
  assert.match(prompts.join("\n"), /INTERVIEW \/ ASYNC VIDEO EVIDENCE/);
  const projected = await projectQueuedAnalyses();
  assert.equal(projected.status, 200);
  const working = tableRows("candidate_working_files").find((row) => row.candidate_id === TARGET_ID);
  assert.equal(
    (working?.workspace as { decisionOverride?: string | null }).decisionOverride ?? null,
    null,
  );
  const view = await loadOneCandidate(TARGET_ID);
  assert.equal(view?.candidate.decision, "interview");
  const analyses = tableRows("candidate_analyses");
  assert.equal(
    analyses.some((row) =>
      String((row.input_snapshot as { interviewEvidence?: string } | null)?.interviewEvidence ?? "").includes(
        FORGED_TRANSCRIPT,
      ),
    ),
    true,
  );
});
