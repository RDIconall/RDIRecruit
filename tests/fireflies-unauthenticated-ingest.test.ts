/**
 * Unsigned Fireflies and VideoAsk ingest must not store interview text,
 * enqueue a re-score, or reveal whether an email matched.
 *
 * These tests fail while that hole is open. They pass once a missing or empty
 * FIREFLIES_WEBHOOK_SECRET rejects the request before any write, and once
 * VIDEOASK_WEBHOOK_SECRET unset rejects VideoAsk the same way.
 *
 * Gmail ingest and the Calendly hook only record events. They are not covered.
 *
 * Run both files in isolated processes so each one sees its own secret:
 *   node --conditions=react-server --import tsx --experimental-test-isolation=process --test --test-timeout=120000 \
 *     tests/fireflies-unauthenticated-ingest.test.ts \
 *     tests/fireflies-signed-ingest.test.ts
 */

import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";

delete process.env.FIREFLIES_WEBHOOK_SECRET;
delete process.env.VIDEOASK_WEBHOOK_SECRET;

let fixture: typeof import("./interview-ingest-fixture.ts");
let harness: Awaited<ReturnType<typeof import("./interview-ingest-fixture.ts").startHarness>>;

before(async () => {
  fixture = await import("./interview-ingest-fixture.ts");
  harness = await fixture.startHarness();
});

  after(() => {
    harness.restoreFetch();
  });

  beforeEach(() => {
    fixture.seedPool();
  });

  test("unsigned inline transcript is refused before any write or email oracle", async () => {
    const known = JSON.stringify({
      transcript: fixture.FORGED,
      participants: ["alice@example.com"],
    });
    const unknown = JSON.stringify({
      transcript: fixture.FORGED,
      participants: ["nobody@example.com"],
    });
    const knownResult = await fixture.call(harness.POST, "/api/ingest/fireflies", known);
    const knownEvidence = fixture.evidenceTranscripts();
    fixture.seedPool();
    const unknownResult = await fixture.call(harness.POST, "/api/ingest/fireflies", unknown);

    assert.equal(
      knownResult.status,
      401,
      JSON.stringify({ knownResult, unknownResult, knownEvidence }),
    );
    assert.equal(unknownResult.status, 401, JSON.stringify({ knownResult, unknownResult }));
    assert.equal(JSON.stringify(knownResult.body), JSON.stringify(unknownResult.body));
    assert.equal(JSON.stringify(knownResult.body).includes("cand-alice"), false);
    assert.equal(JSON.stringify(knownResult.body).includes("candidate_not_resolved"), false);
    assert.deepEqual(knownEvidence, []);
    fixture.assertNoWrites("unsigned email ingest");
  });

  test("sentences and an explicit workable id are refused with the secret unset", async () => {
    process.env.FIREFLIES_WEBHOOK_SECRET = "";
    const raw = JSON.stringify({
      metadata: { workable_id: "cand-alice" },
      sentences: [{ speaker_name: "Applicant", text: fixture.FORGED }],
    });
    const result = await fixture.call(harness.POST, "/api/ingest/fireflies", raw, {
      "x-fireflies-signature": fixture.sign(raw, "some-other-secret"),
    });
    assert.equal(result.status, 401, JSON.stringify(result));
    fixture.assertNoWrites("secret-unset fireflies ingest");
  });

  test("an unsigned transcript does not replace the review or move the candidate post-interview", async () => {
    const raw = JSON.stringify({
      metadata: { candidate_id: "cand-alice" },
      text: fixture.FORGED,
      title: "Fireflies meeting",
    });
    const result = await fixture.call(harness.POST, "/api/ingest/fireflies", raw);
    await harness.processCanonicalAnalysisBatches();

    const prompts = fixture.promptBlob();
    const file = fixture.rows("candidate_working_files").find((row) => row.candidate_id === "cand-alice");
    const workspace = (file?.workspace ?? {}) as { decisionOverride?: string | null };
    const loaded = await harness.loadOneCandidate("cand-alice");
    const phase = harness.detectPipelinePhase({
      fireflies: loaded?.candidate.fireflies,
      workableStage: "Applied",
    });
    const detail = {
      result,
      forgedInPrompt: prompts.includes(fixture.FORGED),
      weightedInterviewBlock: prompts.includes("weight heavily"),
      evidence: fixture.evidenceTranscripts(),
      decisionOverride: workspace.decisionOverride,
      priorScoreRemains: fixture.rows("scores").some((row) => row.id === "prior-score-cand-alice"),
      analysisStatus: fixture.rows("candidate_analyses").map((row) => row.status),
      phase,
      decision: loaded?.candidate.decision,
      shownAsMeeting: (loaded?.candidate.fireflies ?? []).some((item) =>
        (item.transcript ?? "").includes(fixture.FORGED),
      ),
    };
    assert.equal(result.status, 401, JSON.stringify(detail));
    assert.equal(prompts.includes(fixture.FORGED), false);
    assert.equal(prompts.includes("weight heavily"), false);
    fixture.assertNoWrites("unsigned replacement re-score");
    assert.equal(phase, "triage");
    assert.equal(detail.shownAsMeeting, false);
    assert.equal(loaded?.candidate.decision, "reject");
  });

  test("id-only fireflies posts are refused before an event row is written", async () => {
    const raw = JSON.stringify({ meetingId: "meeting-1" });
    const result = await fixture.call(harness.POST, "/api/ingest/fireflies", raw);
    assert.equal(
      result.status,
      401,
      JSON.stringify({ result, events: fixture.rows("events").length }),
    );
    fixture.assertNoWrites("id-only fireflies ingest");
  });

  test("unsigned VideoAsk ingest is refused when its webhook secret is unset", async () => {
    const raw = JSON.stringify({
      contact: { email: "alice@example.com" },
      transcript: fixture.FORGED,
      id: "videoask-1",
      metadata: { workable_id: "cand-bob" },
    });
    const result = await fixture.call(harness.videoAskPOST, "/api/hooks/videoask", raw);
    assert.equal(result.status, 401, JSON.stringify(result));
    fixture.assertNoWrites("unsigned videoask ingest");
    assert.equal(
      fixture.rows("evidence").some((row) => row.source_type === "async_video"),
      false,
    );
  });
