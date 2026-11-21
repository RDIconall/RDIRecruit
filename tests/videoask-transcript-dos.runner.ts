/**
 * Security spec for the public video-interview webhook.
 * These assertions fail while an unauthenticated caller can store an uncapped
 * transcript and the triage inbox copies that transcript into the payload it
 * sends to the browser. They pass once:
 * - a request that does not prove VIDEOASK_WEBHOOK_SECRET is rejected before any write
 * - nothing persisted from the webhook (evidence row or event payload) contains
 *   more than CAP characters in any string
 * - loading the inbox still surfaces a short excerpt of a transcript that was
 *   already stored, and does not embed the rest
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createPostgrestStub, type Row } from "./support/postgrest-stub.ts";

const CAP = 64 * 1024;
const SENTINEL = "OVERSIZE_TRANSCRIPT_END_SENTINEL";
const APPLICANT_ID = "cand_existing_1";
const APPLICANT_EMAIL = "applicant@example.com";
const SHORT = "Talked through a monitoring visit and a deviation log.";

const mode = process.argv[2];
if (mode !== "unauth" && mode !== "auth") {
  throw new Error("usage: videoask-transcript-dos.runner.ts unauth|auth");
}

function oversized(): string {
  return `${"A".repeat(1_200_000)}${SENTINEL}`;
}

const FILLER_RUN = "A".repeat(CAP + 1);

function containsSentinel(value: unknown): boolean {
  if (typeof value === "string") return value.includes(SENTINEL) || value.includes(FILLER_RUN);
  if (Array.isArray(value)) return value.some((item) => containsSentinel(item));
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((item) => containsSentinel(item));
  }
  return false;
}

function longestString(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((max, item) => Math.max(max, longestString(item)), 0);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).reduce(
      (max, item) => Math.max(max, longestString(item)),
      0,
    );
  }
  return 0;
}

function assertStoredBounded(tables: Map<string, Row[]>, label: string) {
  for (const [table, rows] of tables) {
    for (const row of rows) {
      assert.equal(containsSentinel(row), false, `${label}: ${table} kept the oversized tail`);
      const length = longestString(row);
      assert.ok(length <= CAP, `${label}: ${table} stored a ${length}-character string`);
    }
  }
}

function assertNoWebhookWrites(tables: Map<string, Row[]>, label: string) {
  for (const table of ["evidence", "events", "comms_log", "audit_log"]) {
    assert.equal(tables.get(table)?.length ?? 0, 0, `${label}: wrote ${table} before refusing`);
  }
}

async function main() {
  const appliedAt = new Date().toISOString();
  const stub = createPostgrestStub({
    candidates: [
      {
        workable_id: APPLICANT_ID,
        job_shortcode: "EA-001",
        name: "Ada Applicant",
        email: APPLICANT_EMAIL,
        phone: null,
        location: "Los Angeles, CA",
        stage: "Applied",
        stage_kind: null,
        disqualified: false,
        source: null,
        assignee_id: null,
        raw: null,
        photo_url: null,
        created_at: appliedAt,
        synced_at: appliedAt,
      },
    ],
    jobs: [
      {
        shortcode: "EA-001",
        title: "Executive Assistant",
        status: "published",
        department: "Operations",
        location: "Van Nuys, CA",
      },
    ],
    evidence: [],
    events: [],
  });

  const baseUrl = await stub.listen();
  process.env.SUPABASE_URL = baseUrl;
  process.env.SUPABASE_SERVICE_KEY = "test-service-key-placeholder";
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.WORKABLE_TOKEN;
  delete process.env.WORKABLE_API_KEY;

  const { POST } = await import("../src/app/api/hooks/videoask/route.ts");
  const { POST: postFireflies } = await import("../src/app/api/ingest/fireflies/route.ts");
  const { loadTriagePool } = await import("../src/lib/triage/load.ts");
  const { NextRequest } = await import("next/server");

  async function postJson(
    handler: (request: InstanceType<typeof NextRequest>) => Promise<Response>,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) {
    const raw = JSON.stringify(body);
    const request = new NextRequest(`http://localhost${path}`, {
      method: "POST",
      body: raw,
      headers: { "content-type": "application/json", ...headers },
    });
    const response = await handler(request);
    await response.text();
    return response.status;
  }

  const secret = process.env.VIDEOASK_WEBHOOK_SECRET ?? "";

  try {
    if (mode === "unauth") {
      assert.equal(secret, "", "unauth mode must run with VIDEOASK_WEBHOOK_SECRET unset");
      const cases: Array<{ label: string; body: Record<string, unknown> }> = [
        {
          label: "contact email",
          body: {
            contact: { email: APPLICANT_EMAIL },
            form_response: { response_id: "resp-email-1" },
            transcript: oversized(),
          },
        },
        {
          label: "metadata workable id",
          body: {
            contact: { email: "nobody@example.com" },
            metadata: { workable_id: APPLICANT_ID },
            form_response: { response_id: "resp-id-1" },
            transcript: oversized(),
          },
        },
        {
          label: "metadata candidate id used as email",
          body: {
            metadata: { candidate_id: APPLICANT_EMAIL },
            id: "resp-meta-email-1",
            transcript: oversized(),
          },
        },
        {
          label: "form transcription field",
          body: {
            respondent: { email: APPLICANT_EMAIL },
            form_response: { response_id: "resp-tx-1", transcription: oversized() },
          },
        },
        {
          label: "short transcript still requires the secret",
          body: {
            contact: { email: APPLICANT_EMAIL },
            form_response: { response_id: "resp-short-1" },
            transcript: SHORT,
          },
        },
      ];

      for (const entry of cases) {
        stub.tables.set("evidence", []);
        stub.tables.set("events", []);
        const status = await postJson(POST, "/api/hooks/videoask", entry.body);
        assert.equal(status, 401, `${entry.label}: unauthenticated webhook returned ${status}`);
        assertNoWebhookWrites(stub.tables, entry.label);
      }
      return;
    }

    assert.ok(secret.length > 0, "auth mode requires VIDEOASK_WEBHOOK_SECRET");

    const prove = (raw: string) => createHmac("sha256", secret).update(raw).digest("hex");

    {
      stub.tables.set("evidence", []);
      stub.tables.set("events", []);
      const status = await postJson(POST, "/api/hooks/videoask", {
        contact: { email: APPLICANT_EMAIL },
        form_response: { response_id: "resp-no-header" },
        transcript: oversized(),
      });
      assert.equal(status, 401, `missing proof returned ${status}`);
      assertNoWebhookWrites(stub.tables, "missing proof");
    }

    {
      stub.tables.set("evidence", []);
      stub.tables.set("events", []);
      const status = await postJson(
        POST,
        "/api/hooks/videoask",
        {
          contact: { email: APPLICANT_EMAIL },
          form_response: { response_id: "resp-wrong-header" },
          transcript: oversized(),
        },
        { "x-videoask-secret": "not-the-webhook-secret" },
      );
      assert.equal(status, 401, `wrong shared secret returned ${status}`);
      assertNoWebhookWrites(stub.tables, "wrong shared secret");
    }

    {
      stub.tables.set("evidence", []);
      stub.tables.set("events", []);
      const body = {
        contact: { email: APPLICANT_EMAIL },
        form_response: { response_id: "resp-wrong-hmac" },
        transcript: oversized(),
      };
      const raw = JSON.stringify(body);
      const status = await postJson(POST, "/api/hooks/videoask", body, {
        "x-videoask-signature": prove(`${raw}tampered`),
      });
      assert.equal(status, 401, `wrong signature returned ${status}`);
      assertNoWebhookWrites(stub.tables, "wrong signature");
    }

    {
      stub.tables.set("evidence", []);
      stub.tables.set("events", []);
      const status = await postJson(
        POST,
        "/api/hooks/videoask",
        {
          contact: { email: APPLICANT_EMAIL },
          form_response: { response_id: "resp-short-ok" },
          transcript: SHORT,
        },
        { "x-videoask-secret": secret },
      );
      assert.ok(status >= 200 && status < 300, `proved short transcript returned ${status}`);
      const evidence = stub.tables.get("evidence") ?? [];
      assert.equal(evidence.length, 1, "proved short transcript was not stored");
      assert.equal(evidence[0]?.transcript, SHORT);
    }

    {
      stub.tables.set("evidence", []);
      stub.tables.set("events", []);
      const body = {
        contact: { email: APPLICANT_EMAIL },
        form_response: { response_id: "resp-short-hmac" },
        transcript: SHORT,
      };
      const raw = JSON.stringify(body);
      const request = new NextRequest("http://localhost/api/hooks/videoask", {
        method: "POST",
        body: raw,
        headers: {
          "content-type": "application/json",
          "x-videoask-signature": prove(raw),
        },
      });
      const response = await POST(request);
      await response.text();
      assert.ok(response.status >= 200 && response.status < 300, `hmac short transcript returned ${response.status}`);
      const evidence = stub.tables.get("evidence") ?? [];
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0]?.transcript, SHORT);
    }

    const oversizedCases: Array<{ label: string; body: Record<string, unknown> }> = [
      {
        label: "transcript field",
        body: {
          contact: { email: APPLICANT_EMAIL },
          form_response: { response_id: "resp-big-1" },
          transcript: oversized(),
        },
      },
      {
        label: "transcription field and a second response id",
        body: {
          respondent: { email: APPLICANT_EMAIL },
          form_response: { response_id: "resp-big-2", transcription: oversized() },
        },
      },
      {
        label: "workable id with a third response id",
        body: {
          contact: { email: "nobody@example.com" },
          metadata: { workable_id: APPLICANT_ID },
          id: "resp-big-3",
          transcript: oversized(),
        },
      },
    ];

    for (const entry of oversizedCases) {
      stub.tables.set("evidence", []);
      stub.tables.set("events", []);
      const status = await postJson(POST, "/api/hooks/videoask", entry.body, {
        "x-videoask-secret": secret,
      });
      assert.ok(status !== 500, `${entry.label}: handler failed with ${status}`);
      assertStoredBounded(stub.tables, entry.label);
      if (status >= 400) assertNoWebhookWrites(stub.tables, entry.label);
    }

    {
      stub.tables.set("evidence", []);
      stub.tables.set("events", []);
      const status = await postJson(postFireflies, "/api/ingest/fireflies", {
        meetingId: "meeting-oversized-1",
        transcript: oversized(),
        metadata: { workable_id: APPLICANT_ID },
      });
      assert.ok(status !== 500, `fireflies handler failed with ${status}`);
      assertStoredBounded(stub.tables, "fireflies inline transcript");
      if (status >= 400) assertNoWebhookWrites(stub.tables, "fireflies inline transcript");
    }

    stub.tables.set("evidence", [
      {
        id: "evidence-seed",
        candidate_id: APPLICANT_ID,
        source_type: "async_video",
        author: "candidate",
        label: "VideoAsk",
        captured_at: appliedAt,
        raw_ref: "already-stored",
        transcript: oversized(),
        extracted: { transcript: oversized() },
        created_at: appliedAt,
      },
    ]);
    stub.tables.set("events", []);

    for (const job of ["EA-001", "all"]) {
      const pool = await loadTriagePool(job);
      const candidate = pool.candidates.find((item) => item.id === APPLICANT_ID);
      assert.ok(candidate, `inbox ${job} did not include the applicant`);
      const transcripts = (candidate.fireflies ?? []).map((item) => item.transcript).filter((text) => text.trim());
      assert.ok(transcripts.length >= 1, `inbox ${job} dropped the interview`);
      for (const transcript of transcripts) {
        assert.ok(transcript.length > 0 && transcript.length <= CAP, `inbox ${job} transcript length ${transcript.length}`);
      }
      assert.equal(containsSentinel(pool), false, `inbox ${job} embedded the oversized transcript`);
    }
  } finally {
    await stub.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
