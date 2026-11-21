import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { before, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { createMemorySupabase } from "./helpers/memory-supabase.mjs";

const { installMemorySupabaseHook } = createRequire(import.meta.url)(
  "./helpers/install-memory-supabase.cjs",
);
import {
  MAX_TRANSCRIPT_CHARS,
  TEST_WEBHOOK_SECRET,
  TRANSCRIPT_MARKER,
  evidenceSelectLeaksTranscript,
  hubSignature,
  overLimitTranscript,
} from "./helpers/transcript-limit.mjs";

delete process.env.FIREFLIES_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.VIDEOASK_WEBHOOK_SECRET;
delete process.env.WORKABLE_TOKEN;
delete process.env.WORKABLE_API_KEY;
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_SERVICE_KEY = "test-service-key-placeholder";
process.env.FIREFLIES_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;

type PostHandler = (request: NextRequest) => Promise<Response>;
type LoadPool = typeof import("../src/lib/triage/load.ts").loadTriagePool;
type LoadOne = typeof import("../src/lib/triage/load.ts").loadOneCandidate;

let ingestFireflies: PostHandler;
let loadTriagePool: LoadPool;
let loadOneCandidate: LoadOne;
let CROSS_ROLE_SHORTCODE: string;

installMemorySupabaseHook();

before(async () => {
  ({ POST: ingestFireflies } = await import("../src/app/api/ingest/fireflies/route.ts"));
  ({ loadTriagePool, loadOneCandidate, CROSS_ROLE_SHORTCODE } = await import(
    "../src/lib/triage/load.ts"
  ));
});

const CANDIDATE_ID = "app_cand_1";
const OTHER_ID = "app_cand_2";
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
  db.seed("candidates", [
    {
      workable_id: CANDIDATE_ID,
      job_shortcode: "JOB1",
      name: "Ada Applicant",
      email: APPLICANT_EMAIL,
      disqualified: false,
      location: "Los Angeles, CA",
      stage: "Applied",
      created_at: now,
      synced_at: now,
    },
    {
      workable_id: OTHER_ID,
      job_shortcode: "JOB1",
      name: "Bea Applicant",
      email: "bea@example.com",
      disqualified: false,
      location: "Los Angeles, CA",
      stage: "Applied",
      created_at: now,
      synced_at: now,
    },
  ]);
  db.writes.length = 0;
  return db;
}

function signedRequest(body: unknown, signature?: string) {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== undefined) headers["x-hub-signature"] = signature;
  return {
    raw,
    request: new NextRequest("http://localhost/api/ingest/fireflies", {
      method: "POST",
      headers,
      body: raw,
    }),
  };
}

beforeEach(() => {
  useDb();
});

test("a fireflies signature that does not match the raw body is refused before any write", async () => {
  const db = useDb();
  const body = {
    transcript: overLimitTranscript(),
    metadata: { workable_id: CANDIDATE_ID },
    transcriptId: "meeting-bad-sig",
  };
  const { request } = signedRequest(body, hubSignature("different-body"));
  const response = await ingestFireflies(request);
  assert.equal(response.status, 401);
  assert.equal(db.writes.length, 0);
});

test("a signed inline transcript over the cap is refused before any write", async () => {
  const db = useDb();
  const body = {
    transcript: overLimitTranscript(),
    metadata: { workable_id: CANDIDATE_ID },
    transcriptId: "meeting-string-over",
  };
  const raw = JSON.stringify(body);
  const response = await ingestFireflies(
    signedRequest(body, hubSignature(raw)).request,
  );
  const payload = await response.json().catch(() => null);
  assert.ok(
    response.status === 400 || response.status === 413,
    `expected the ${overLimitTranscript().length}-char transcript to be rejected, got ${response.status} ${JSON.stringify(payload)} writes=${db.writes.map((w) => w.table).join(",")}`,
  );
  assert.equal(db.writes.length, 0);
  assert.ok(overLimitTranscript().length > MAX_TRANSCRIPT_CHARS);
});

test("signed sentence parts that only exceed the cap once joined are refused before any write", async () => {
  const db = useDb();
  const part = "B".repeat(Math.floor(MAX_TRANSCRIPT_CHARS / 2) + 10);
  assert.ok(part.length < MAX_TRANSCRIPT_CHARS);
  const body = {
    meetingId: "meeting-sentences-over",
    metadata: { workable_id: CANDIDATE_ID },
    sentences: [
      { speaker_name: "Ada", text: `${TRANSCRIPT_MARKER}_${part}` },
      { speaker_name: "Host", text: part },
    ],
  };
  const raw = JSON.stringify(body);
  const response = await ingestFireflies(
    signedRequest(body, hubSignature(raw)).request,
  );
  assert.ok(response.status === 400 || response.status === 413);
  assert.equal(db.writes.length, 0);
});

test("a signed text field over the cap is refused before any write", async () => {
  const db = useDb();
  const body = {
    id: "meeting-text-over",
    metadata: { workable_id: CANDIDATE_ID },
    text: overLimitTranscript(),
  };
  const raw = JSON.stringify(body);
  const response = await ingestFireflies(
    signedRequest(body, hubSignature(raw)).request,
  );
  assert.ok(response.status === 400 || response.status === 413);
  assert.equal(db.writes.length, 0);
});

test("a signed transcript at the cap is stored once against the applicant", async () => {
  const db = useDb();
  const transcript = "C".repeat(MAX_TRANSCRIPT_CHARS);
  const body = {
    transcript,
    title: "Screen",
    metadata: { workable_id: CANDIDATE_ID },
    transcriptId: "meeting-at-cap",
  };
  const raw = JSON.stringify(body);
  const response = await ingestFireflies(
    signedRequest(body, hubSignature(raw)).request,
  );
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.ok, true);
  assert.equal(payload.candidateId, CANDIDATE_ID);
  const evidence = db.rows("evidence");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].transcript, transcript);
  assert.equal(evidence[0].candidate_id, CANDIDATE_ID);
  assert.equal(evidence[0].raw_ref, "fireflies:meeting-at-cap");
});

test("a signed transcript is stored when only a participant email matches", async () => {
  const db = useDb();
  const transcript = "Email match transcript.";
  const body = {
    transcript,
    transcriptId: "meeting-email",
    organizer_email: "host@company.test",
    participants: [APPLICANT_EMAIL],
  };
  const raw = JSON.stringify(body);
  const response = await ingestFireflies(
    signedRequest(body, hubSignature(raw)).request,
  );
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  const evidence = db.rows("evidence");
  assert.equal(evidence.length, 1, JSON.stringify(payload));
  assert.equal(evidence[0].candidate_id, CANDIDATE_ID);
  assert.equal(evidence[0].transcript, transcript);
});

test("a second signed transcript id is stored as its own evidence row", async () => {
  const db = useDb();
  for (const id of ["meeting-one", "meeting-two"]) {
    const body = {
      transcript: `notes for ${id}`,
      metadata: { workable_id: CANDIDATE_ID },
      transcriptId: id,
    };
    const raw = JSON.stringify(body);
    const response = await ingestFireflies(
      signedRequest(body, hubSignature(raw)).request,
    );
    assert.equal(response.status, 200);
  }
  const evidence = db.rows("evidence");
  assert.equal(evidence.length, 2);
  assert.deepEqual(
    evidence.map((row) => row.raw_ref).sort(),
    ["fireflies:meeting-one", "fireflies:meeting-two"],
  );
});

test("the hiring pool does not receive stored interview transcript text", async () => {
  const db = useDb();
  const kinds = ["fireflies", "interview", "phone_screen", "async_video"] as const;
  const markers = kinds.map((kind, index) => {
    const marker = `${TRANSCRIPT_MARKER}_${kind}_${"D".repeat(20_000)}`;
    db.seed("evidence", {
      candidate_id: index % 2 === 0 ? CANDIDATE_ID : OTHER_ID,
      source_type: kind,
      label: `${kind} recording`,
      captured_at: new Date().toISOString(),
      raw_ref: `stored:${kind}`,
      transcript: marker,
      extracted: { transcript: marker, source: kind },
    });
    return marker;
  });
  db.writes.length = 0;
  db.selects.length = 0;

  const crossRole = await loadTriagePool(CROSS_ROLE_SHORTCODE);
  const oneJob = await loadTriagePool("JOB1");
  const pooled = JSON.stringify({ crossRole, oneJob });
  for (const marker of markers) {
    assert.equal(pooled.includes(marker), false, `${marker.slice(0, 40)} was copied into the pool payload`);
  }

  const evidenceSelects = db.selects.filter((entry) => entry.table === "evidence");
  assert.ok(evidenceSelects.length >= 2, "both pool loads read evidence");
  for (const entry of evidenceSelects) {
    assert.equal(
      evidenceSelectLeaksTranscript(entry.columns),
      false,
      `pool evidence select must omit transcript text, got ${entry.columns}`,
    );
  }

  db.selects.length = 0;
  const opened = await loadOneCandidate(CANDIDATE_ID);
  assert.ok(opened);
  const openedText = JSON.stringify(opened);
  assert.equal(openedText.includes(markers[0]), true);
  assert.equal(openedText.includes(markers[1]), true);
  const detailSelects = db.selects.filter((entry) => entry.table === "evidence");
  assert.ok(detailSelects.length >= 1);
});
