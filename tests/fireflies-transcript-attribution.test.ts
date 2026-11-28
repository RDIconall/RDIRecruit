/**
 * Spec for Fireflies transcript attribution.
 *
 * These tests fail while a meeting is attached to an applicant by pattern-matching
 * participant addresses against the email the applicant typed into Workable, and
 * while an unsigned POST can store a transcript. They pass once a delivery is
 * stored only for an explicit applicant id (or an equivalent rule that does not
 * treat a staff participant, a wildcard, or the first of several external
 * participants as the applicant) and unsigned deliveries are refused before any
 * evidence row is written.
 *
 * The shared secret below is a placeholder. The route should read it from
 * FIREFLIES_WEBHOOK_SECRET and require the same value in the `x-fireflies-secret`
 * header. Signed tests send that placeholder so the matcher still runs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { EvidenceRow } from "../src/lib/types";
import type { WorkableCandidate } from "../src/lib/workable/client";

process.env.SUPABASE_URL = "http://127.0.0.1:5999";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";
process.env.FIREFLIES_API_KEY = "test-fireflies-key";
process.env.FIREFLIES_WEBHOOK_SECRET = "placeholder-fireflies-webhook-secret";
delete process.env.ANTHROPIC_API_KEY;

const WEBHOOK_SECRET_HEADER = "x-fireflies-secret";
const WEBHOOK_SECRET_PLACEHOLDER = "placeholder-fireflies-webhook-secret";
const JOB = "JOB1";

type Row = Record<string, unknown>;

interface TranscriptFixture {
  id: string;
  title: string;
  organizerEmail: string;
  participants: string[];
  text: string;
}

const tables = new Map<string, Row[]>();
let transcript: TranscriptFixture | null = null;

function resetTables() {
  tables.clear();
  for (const name of ["candidates", "applications", "evidence", "events"]) {
    tables.set(name, []);
  }
  transcript = null;
}

function rows(table: string): Row[] {
  const found = tables.get(table);
  if (!found) throw new Error(`unexpected table ${table}`);
  return found;
}

/** PostgreSQL ILIKE, plus PostgREST's `*` alias for `%`. */
function ilike(value: unknown, pattern: string): boolean {
  if (typeof value !== "string") return false;
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) break;
      source += next.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i++;
      continue;
    }
    if (ch === "*" || ch === "%") source += "[\\s\\S]*";
    else if (ch === "_") source += "[\\s\\S]";
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i").test(value);
}

function parseOp(raw: string): { op: string; value: string } | null {
  for (const op of ["ilike", "neq", "gte", "lte", "eq", "gt", "lt", "in", "is"]) {
    if (raw.startsWith(`${op}.`)) return { op, value: raw.slice(op.length + 1) };
  }
  return null;
}

function matches(row: Row, params: URLSearchParams): boolean {
  for (const [key, raw] of params) {
    if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(key)) continue;
    const parsed = parseOp(raw);
    if (!parsed) throw new Error(`unparsed filter ${key}=${raw}`);
    const cell = row[key];
    if (parsed.op === "eq") {
      if (cell !== parsed.value) return false;
    } else if (parsed.op === "ilike") {
      if (!ilike(cell, parsed.value)) return false;
    } else if (parsed.op === "in") {
      const inner = parsed.value.replace(/^\(/, "").replace(/\)$/, "");
      const allowed = inner.split(",").map((part) => part.replace(/^"|"$/g, ""));
      if (!allowed.includes(String(cell))) return false;
    } else {
      throw new Error(`filter ${parsed.op} is not used by this path`);
    }
  }
  return true;
}

function project(row: Row, select: string): Row {
  if (!select || select === "*") return { ...row };
  const out: Row = {};
  for (const column of select.split(",")) {
    const name = column.trim();
    if (name) out[name] = row[name];
  }
  return out;
}

function orderRows(list: Row[], order: string | null): Row[] {
  if (!order) return list;
  const [column, direction, nulls] = order.split(".");
  const desc = direction === "desc";
  const nullsFirst = nulls === "nullsfirst";
  return [...list].sort((a, b) => {
    const av = a[column];
    const bv = b[column];
    if (av == null && bv == null) return 0;
    if (av == null) return nullsFirst ? -1 : 1;
    if (bv == null) return nullsFirst ? 1 : -1;
    if (av === bv) return 0;
    const cmp = String(av) < String(bv) ? -1 : 1;
    return desc ? -cmp : cmp;
  });
}

function json(status: number, body: unknown, statusText: string): Response {
  const payload = body === undefined ? "" : JSON.stringify(body);
  return new Response(payload, {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

function conflict(): Response {
  return json(
    409,
    {
      code: "23505",
      details: null,
      hint: null,
      message: 'duplicate key value violates unique constraint "idx_evidence_candidate_raw_ref"',
    },
    "Conflict",
  );
}

async function postgrest(url: URL, init?: RequestInit): Promise<Response> {
  const table = url.pathname.split("/").filter(Boolean).at(-1);
  if (!table || !tables.has(table)) {
    throw new Error(`no stand-in for ${url.pathname}`);
  }
  const method = (init?.method ?? "GET").toUpperCase();
  const prefer = new Headers(init?.headers).get("prefer") ?? "";
  const represent = prefer.includes("return=representation");
  const stored = rows(table);

  if (method === "GET") {
    let list = stored.filter((row) => matches(row, url.searchParams));
    list = orderRows(list, url.searchParams.get("order"));
    const limit = url.searchParams.get("limit");
    if (limit) list = list.slice(0, Number(limit));
    return json(200, list.map((row) => project(row, url.searchParams.get("select") ?? "*")), "OK");
  }

  if (method !== "POST") throw new Error(`unexpected ${method} ${url.pathname}`);

  const body = JSON.parse(String(init?.body ?? "null")) as Row | Row[];
  const incoming = Array.isArray(body) ? body : [body];
  const onConflict = url.searchParams.get("on_conflict");
  const written: Row[] = [];

  for (const item of incoming) {
    if (table === "evidence" && item.raw_ref != null) {
      const dup = stored.find(
        (row) => row.candidate_id === item.candidate_id && row.raw_ref === item.raw_ref,
      );
      if (dup) return conflict();
    }
    const keys = onConflict?.split(",") ?? [];
    const existing =
      keys.length > 0
        ? stored.find((row) => keys.every((key) => row[key] === item[key]))
        : undefined;
    if (existing) {
      Object.assign(existing, item);
      written.push(existing);
    } else {
      const row: Row = {
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        ...item,
      };
      stored.push(row);
      written.push(row);
    }
  }

  if (!represent) return new Response(null, { status: 201, statusText: "Created" });
  return json(
    201,
    written.map((row) => project(row, url.searchParams.get("select") ?? "*")),
    "Created",
  );
}

async function standInFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname === "api.fireflies.ai") {
    if (!transcript) return json(404, { errors: [{ message: "no fixture" }] }, "Not Found");
    return json(
      200,
      {
        data: {
          transcript: {
            id: transcript.id,
            title: transcript.title,
            organizer_email: transcript.organizerEmail,
            participants: transcript.participants,
            sentences: [{ speaker_name: "Speaker", text: transcript.text }],
          },
        },
      },
      "OK",
    );
  }
  if (url.pathname.startsWith("/rest/v1/")) return postgrest(url, init);
  if (url.pathname.startsWith("/auth/v1/")) return json(200, {}, "OK");
  throw new Error(`unexpected fetch ${url.href}`);
}

const originalFetch = globalThis.fetch;
globalThis.fetch = standInFetch;

function applicant(id: string, email: string, name: string): WorkableCandidate {
  return {
    id,
    name,
    firstname: name,
    lastname: "Applicant",
    headline: "",
    account: { subdomain: "rditrials", name: "RDI" },
    job: { shortcode: JOB, title: "Role" },
    stage: "Applied",
    disqualified: false,
    disqualification_reason: null,
    hired_at: null,
    sourced: false,
    profile_url: `https://rditrials.workable.com/backend/jobs/${JOB}/candidates/${id}`,
    address: "Remote",
    phone: "",
    email,
    created_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-02T00:00:00.000Z",
  };
}

type Route = {
  POST: (request: import("next/server").NextRequest) => Promise<Response>;
  upsertCandidateFromWorkable: (
    candidate: WorkableCandidate,
    jobShortcode?: string,
    options?: { analyze?: boolean; syncComments?: boolean },
  ) => Promise<unknown>;
  loadInterviewEvidenceText: (candidateId: string) => Promise<string>;
  mapCandidate: typeof import("../src/lib/triage/from-supabase").mapCandidate;
  renderCandidateMaterials: typeof import("../src/lib/triage/working-file").renderCandidateMaterials;
};

let route: Route;

async function loadRoute(): Promise<Route> {
  const [{ POST }, { upsertCandidateFromWorkable }, { loadInterviewEvidenceText }, { mapCandidate }, { renderCandidateMaterials }] =
    await Promise.all([
      import("../src/app/api/ingest/fireflies/route"),
      import("../src/lib/sync/workable-sync"),
      import("../src/lib/sync/rescore"),
      import("../src/lib/triage/from-supabase"),
      import("../src/lib/triage/working-file"),
    ]);
  return {
    POST: POST as Route["POST"],
    upsertCandidateFromWorkable,
    loadInterviewEvidenceText,
    mapCandidate,
    renderCandidateMaterials,
  };
}

async function syncApplicant(id: string, email: string, name: string) {
  await route.upsertCandidateFromWorkable(applicant(id, email, name), JOB, {
    analyze: false,
    syncComments: false,
  });
  const { data, error } = await (
    await import("../src/lib/supabase/server")
  )
    .getServiceSupabase()
    .from("candidates")
    .select("workable_id, email, name")
    .eq("workable_id", id)
    .maybeSingle();
  assert.equal(error, null);
  assert.equal(data?.email, email);
  return data;
}

function signedRequest(body: unknown, secret?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== undefined) headers[WEBHOOK_SECRET_HEADER] = secret;
  return new Request("http://localhost/api/ingest/fireflies", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function deliver(meetingId: string, secret = WEBHOOK_SECRET_PLACEHOLDER) {
  const response = await route.POST(
    signedRequest({ meetingId }, secret) as unknown as import("next/server").NextRequest,
  );
  const body = (await response.json()) as { ok?: boolean; candidateId?: string; skipped?: string; error?: string };
  return { response, body };
}

function evidenceFor(candidateId: string): Row[] {
  return rows("evidence").filter((row) => row.candidate_id === candidateId && row.source_type === "fireflies");
}

async function shownTranscript(candidateId: string, name: string): Promise<string> {
  const grading = await route.loadInterviewEvidenceText(candidateId);
  const evidence = evidenceFor(candidateId).map(
    (row) =>
      ({
        id: String(row.id),
        candidate_id: candidateId,
        source_type: String(row.source_type),
        author: (row.author as string | null) ?? null,
        label: (row.label as string | null) ?? null,
        captured_at: (row.captured_at as string | null) ?? null,
        raw_ref: (row.raw_ref as string | null) ?? null,
        transcript: (row.transcript as string | null) ?? null,
        extracted: (row.extracted as Record<string, unknown> | null) ?? null,
        created_at: String(row.created_at ?? new Date().toISOString()),
      }) satisfies EvidenceRow,
  );
  const view = route.mapCandidate({
    candidate: {
      workable_id: candidateId,
      job_shortcode: JOB,
      name,
      email: null,
      phone: null,
      location: "Remote",
      stage: "Applied",
      stage_kind: null,
      disqualified: false,
      source: "applied",
      assignee_id: null,
      raw: null,
      photo_url: null,
      created_at: "2026-11-01T00:00:00.000Z",
      synced_at: "2026-11-02T00:00:00.000Z",
    },
    score: null,
    ro: null,
    overlay: null,
    application: null,
    narrative: [],
    evals: {
      invest: null,
      dig: null,
      verification: null,
      roleReads: [],
      answerGrades: [],
      fitRead: null,
    },
    interviewEvidence: evidence,
    read: null,
    rank: 1,
    jobLocation: "Van Nuys, CA",
    jobShortcode: JOB,
  });
  return `${grading}\n${route.renderCandidateMaterials(view)}`;
}

test.before(async () => {
  route = await loadRoute();
});

test.beforeEach(() => {
  resetTables();
});

test.after(() => {
  globalThis.fetch = originalFetch;
});

test("an internal meeting is not stored on the applicant who typed a staff participant address", async () => {
  const marker = "Unreleased lot QB-17 was the only topic of the internal staff meeting.";
  await syncApplicant("att-staff", "cointerviewer@rditrials.com", "Alex Applicant");
  transcript = {
    id: "meet-internal",
    title: "Monday staff sync",
    organizerEmail: "founder@rditrials.com",
    participants: ["founder@rditrials.com", "cointerviewer@rditrials.com"],
    text: marker,
  };

  const { body } = await deliver("meet-internal");

  assert.notEqual(body.candidateId, "att-staff");
  assert.equal(evidenceFor("att-staff").length, 0);
  assert.equal((await shownTranscript("att-staff", "Alex Applicant")).includes(marker), false);
});

test("a staff address listed before the interviewee does not capture that interview", async () => {
  const marker = "The interviewee described owning the deviation log for study RD-4.";
  await syncApplicant("att-staff", "cointerviewer@rditrials.com", "Alex Applicant");
  await syncApplicant("real-applicant", "real.applicant@personal.test", "Riley Candidate");
  transcript = {
    id: "meet-interview",
    title: "Riley screen",
    organizerEmail: "founder@rditrials.com",
    participants: [
      "founder@rditrials.com",
      "cointerviewer@rditrials.com",
      "real.applicant@personal.test",
    ],
    text: marker,
  };

  const { body } = await deliver("meet-interview");
  const owners = rows("evidence")
    .filter((row) => String(row.transcript ?? "").includes(marker))
    .map((row) => row.candidate_id);

  assert.equal(owners.includes("att-staff"), false);
  assert.notEqual(body.candidateId, "att-staff");
  assert.equal((await shownTranscript("att-staff", "Alex Applicant")).includes(marker), false);
  assert.equal(
    (await shownTranscript("real-applicant", "Riley Candidate")).includes(marker),
    owners.includes("real-applicant"),
  );
});

test("a participant underscore does not match a different applicant email", async () => {
  const marker = "This transcript must not attach through a single-character wildcard.";
  await syncApplicant("jane-dot", "jane.smith@personal.test", "Jane Smith");
  transcript = {
    id: "meet-wildcard",
    title: "Someone else",
    organizerEmail: "founder@rditrials.com",
    participants: ["founder@rditrials.com", "jane_smith@personal.test"],
    text: marker,
  };

  await deliver("meet-wildcard");

  assert.equal(evidenceFor("jane-dot").length, 0);
  assert.equal((await shownTranscript("jane-dot", "Jane Smith")).includes(marker), false);
});

test("two external participant matches are not awarded to whichever address is listed first", async () => {
  const marker = "Ambiguous meeting with two external applicants present.";
  await syncApplicant("first-applicant", "first.applicant@personal.test", "First Applicant");
  await syncApplicant("second-applicant", "second.applicant@personal.test", "Second Applicant");
  transcript = {
    id: "meet-ambiguous",
    title: "Joint conversation",
    organizerEmail: "founder@rditrials.com",
    participants: [
      "founder@rditrials.com",
      "first.applicant@personal.test",
      "second.applicant@personal.test",
    ],
    text: marker,
  };

  const { body } = await deliver("meet-ambiguous");

  assert.equal(evidenceFor("first-applicant").length, 0);
  assert.equal(evidenceFor("second-applicant").length, 0);
  assert.equal(body.candidateId, undefined);
  assert.equal((await shownTranscript("first-applicant", "First Applicant")).includes(marker), false);
});

test("an explicit workable id still files the transcript on that applicant", async () => {
  const marker = "Explicitly mapped interview for the named applicant.";
  await syncApplicant("att-staff", "cointerviewer@rditrials.com", "Alex Applicant");
  await syncApplicant("real-applicant", "real.applicant@personal.test", "Riley Candidate");
  transcript = {
    id: "meet-explicit",
    title: "Mapped screen",
    organizerEmail: "founder@rditrials.com",
    participants: [
      "founder@rditrials.com",
      "cointerviewer@rditrials.com",
      "real.applicant@personal.test",
    ],
    text: marker,
  };

  const response = await route.POST(
    signedRequest({
      meetingId: "meet-explicit",
      metadata: { workable_id: "real-applicant" },
    }) as unknown as import("next/server").NextRequest,
  );
  const body = (await response.json()) as { candidateId?: string };

  assert.equal(response.status, 200);
  assert.equal(body.candidateId, "real-applicant");
  assert.equal(evidenceFor("att-staff").length, 0);
  assert.equal(evidenceFor("real-applicant").length, 1);
  assert.equal((await shownTranscript("real-applicant", "Riley Candidate")).includes(marker), true);
  assert.equal((await shownTranscript("att-staff", "Alex Applicant")).includes(marker), false);
});

test("an inline transcript uses the same participant match and is not stored on the staff-email applicant", async () => {
  const marker = "Inline relay of an internal meeting must not attach to the typed staff address.";
  await syncApplicant("att-staff", "cointerviewer@rditrials.com", "Alex Applicant");

  const response = await route.POST(
    signedRequest({
      meetingId: "meet-inline",
      title: "Monday staff sync",
      organizer_email: "founder@rditrials.com",
      participants: ["founder@rditrials.com", "cointerviewer@rditrials.com"],
      sentences: [{ speaker_name: "Speaker", text: marker }],
    }) as unknown as import("next/server").NextRequest,
  );
  const body = (await response.json()) as { candidateId?: string };

  assert.notEqual(body.candidateId, "att-staff");
  assert.equal(evidenceFor("att-staff").length, 0);
  assert.equal((await shownTranscript("att-staff", "Alex Applicant")).includes(marker), false);
});

test("a delivery without the fireflies shared secret does not store a transcript", async () => {
  const marker = "Unsigned delivery must not become interview evidence.";
  await syncApplicant("real-applicant", "real.applicant@personal.test", "Riley Candidate");
  transcript = {
    id: "meet-unsigned",
    title: "Unsigned",
    organizerEmail: "founder@rditrials.com",
    participants: ["founder@rditrials.com", "real.applicant@personal.test"],
    text: marker,
  };

  const response = await route.POST(
    signedRequest({ meetingId: "meet-unsigned" }, undefined) as unknown as import("next/server").NextRequest,
  );

  assert.equal(response.status, 401);
  assert.equal(rows("evidence").length, 0);
});
