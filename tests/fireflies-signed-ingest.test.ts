/**
 * Signed Fireflies ingest. The signature is the lowercase hex HMAC-SHA256 of
 * the raw request body, keyed by FIREFLIES_WEBHOOK_SECRET, in the header
 * `X-Fireflies-Signature`. A different body fails the check and writes nothing.
 * The candidate comes only from the signed body. Email matching is
 * case-insensitive equality: `%` and `_` are literal.
 *
 * FIREFLIES_WEBHOOK_SECRET is set before the app reads its environment.
 * These tests fail while any body is accepted and while an unescaped ilike
 * pattern can select a different applicant.
 */

import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";

process.env.FIREFLIES_WEBHOOK_SECRET = "test-fireflies-webhook-secret";
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

  test("a signed body that was tampered is refused and the forged text is not stored", async () => {
    const signed = JSON.stringify({
      transcript: "harmless scheduling note",
      metadata: { workable_id: "cand-alice" },
    });
    const tampered = signed.replace("harmless scheduling note", fixture.FORGED);
    const result = await fixture.call(harness.POST, "/api/ingest/fireflies", tampered, {
      "x-fireflies-signature": fixture.sign(signed),
    });
    assert.equal(result.status, 401, JSON.stringify(result));
    assert.equal(
      fixture.evidenceTranscripts().some((text) => text.includes("FORGED-INTERVIEW-SENTENCE")),
      false,
    );
    fixture.assertNoWrites("tampered fireflies body");
  });

  test("a valid signature stores only the candidate named in the signed body", async () => {
    const raw = JSON.stringify({
      title: "Fireflies meeting",
      transcript: "Alice described the monitoring plan in her own words.",
      metadata: { workable_id: "cand-alice" },
    });
    const result = await fixture.call(
      harness.POST,
      "/api/ingest/fireflies?workable_id=cand-bob&candidate_id=cand-bob",
      raw,
      {
        "x-fireflies-signature": fixture.sign(raw),
        "x-candidate-id": "cand-bob",
      },
    );
    assert.equal(result.status, 200, JSON.stringify(result));
    const stored = fixture.rows("evidence");
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.candidate_id, "cand-alice");
    assert.equal(stored[0]?.source_type, "fireflies");
    assert.equal(String(stored[0]?.transcript).includes("monitoring plan"), true);
    assert.equal(
      stored.some((row) => row.candidate_id === "cand-bob"),
      false,
    );
  });

  test("a signed participant email matches case-insensitively and does not treat wildcards as patterns", async () => {
    const exact = JSON.stringify({
      transcript: "Alice walked through a deviation she owned.",
      participants: ["Alice@Example.com"],
    });
    const exactResult = await fixture.call(harness.POST, "/api/ingest/fireflies", exact, {
      "x-fireflies-signature": fixture.sign(exact),
    });
    assert.equal(exactResult.status, 200, JSON.stringify(exactResult));
    assert.equal(fixture.rows("evidence").some((row) => row.candidate_id === "cand-alice"), true);

    fixture.seedPool();
    const wildcard = JSON.stringify({
      transcript: fixture.FORGED,
      participants: ["a_ice@example.com"],
    });
    const wildcardResult = await fixture.call(harness.POST, "/api/ingest/fireflies", wildcard, {
      "x-fireflies-signature": fixture.sign(wildcard),
    });
    assert.equal(
      fixture.evidenceTranscripts().some((text) => text.includes("FORGED-INTERVIEW-SENTENCE")),
      false,
      JSON.stringify(wildcardResult),
    );
    assert.equal(
      fixture.rows("evidence").some((row) => row.candidate_id === "cand-alice"),
      false,
    );
  });

  test("a percent pattern does not select the only applicant", async () => {
    const candidateTable = fixture.rows("candidates");
    const onlyAlice = candidateTable.filter((row) => row.workable_id === "cand-alice");
    candidateTable.splice(0, candidateTable.length, ...onlyAlice);
    const star = JSON.stringify({ transcript: fixture.FORGED, participants: ["%@example.com"] });
    const starResult = await fixture.call(harness.POST, "/api/ingest/fireflies", star, {
      "x-fireflies-signature": fixture.sign(star),
    });
    assert.equal(
      JSON.stringify(starResult.body ?? {}).includes("cand-alice"),
      false,
      JSON.stringify(starResult),
    );
    assert.equal(fixture.evidenceTranscripts().some((text) => text.includes(fixture.FORGED)), false);
  });
