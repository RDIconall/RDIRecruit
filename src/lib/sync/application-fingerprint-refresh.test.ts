import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Placeholders only. The suite never sends them anywhere; fetch is replaced
// below and answers the Workable, Supabase, and résumé URLs locally.
process.env.SUPABASE_URL = "https://supabase.example.test";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";
process.env.WORKABLE_TOKEN = "test-workable-token";
process.env.WORKABLE_SUBDOMAIN = "rditrials";
process.env.WORKABLE_MEMBER_ID = "test-member";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

// tsx loads these packages through require(), which the ESM register hook does
// not see. registerHooks covers both. The stubs replace modules that throw
// outside a Next server render; they do not implement the sync under test.
const stubs: Record<string, string> = {
  "server-only": new URL("./test-stubs/server-only.cjs", import.meta.url).href,
  "next/cache": new URL("./test-stubs/next-cache.cjs", import.meta.url).href,
  "@clerk/nextjs/server": new URL("./test-stubs/clerk.cjs", import.meta.url).href,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = stubs[specifier];
    if (stub) return { url: stub, shortCircuit: true, format: "commonjs" };
    return nextResolve(specifier, context);
  },
});

/**
 * Spec for the stale-application bug.
 *
 * After the first résumé ingest, a later Workable application (new résumé link,
 * screening answers, cover letter, or work history, or a newer candidate
 * timestamp on an explicit re-sync) must replace the stored résumé bytes and
 * enqueue a canonical re-score whose snapshot is the revised materials.
 * A stage change that leaves the application fingerprint untouched must not.
 *
 * These assertions fail while the product writes the new fingerprint and then
 * leaves the stored file and the original decision in place.
 *
 * Untested wrappers that only call the functions covered here:
 * - POST /api/hooks/workable (calls syncCandidateFromWebhook)
 * - incrementalSync / reconcileWorkablePipeline (call syncChangedCandidatesForJob)
 * Untested because they do not keep an already-written decision:
 * - scoreUnscoredAcrossJobs (skips candidates who already have a fit read)
 * - backfillMissingAnswers (only candidates whose stored answers are empty)
 */

const JOB = "JOB1";
const ID = "cand-1";
const ORIGINAL_URL = "https://files.example.test/resumes/original.txt";
const REVISED_URL = "https://files.example.test/resumes/revised.txt";
const ORIGINAL_AT = "2026-01-02T00:00:00.000Z";
const REVISED_AT = "2026-02-03T00:00:00.000Z";
const ORIGINAL_BODY =
  "ORIGINAL RESUME. Plant manager for a decade, running the first submitted file that the hiring screen stored.";
const REVISED_BODY =
  "REVISED RESUME. Warehouse lead for a decade, the file now on the Workable application after the applicant replaced it.";
const ORIGINAL_ANSWER = "I ran the original plant.";
const REVISED_ANSWER = "I ran the revised warehouse.";

type Row = Record<string, unknown>;

const tables = new Map<string, Row[]>();
const storage = new Map<string, Buffer>();
let idCounter = 1;
let remote: Row = {};
let files = new Map<string, string>();

function clone<T>(value: T): T {
  return structuredClone(value);
}

function looseEq(value: unknown, raw: string): boolean {
  if (typeof value === "boolean" || typeof value === "number") return String(value) === raw;
  return value === raw;
}

function compare(op: string, value: unknown, raw: string): boolean {
  if (value == null) return false;
  const numeric = typeof value === "number" || (typeof value === "string" && value !== "" && !Number.isNaN(Number(value)) && !value.includes("-"));
  if (numeric) {
    const left = Number(value);
    const right = Number(raw);
    if (op === "lt") return left < right;
    if (op === "lte") return left <= right;
    if (op === "gt") return left > right;
    if (op === "gte") return left >= right;
  }
  const left = String(value);
  if (op === "lt") return left < raw;
  if (op === "lte") return left <= raw;
  if (op === "gt") return left > raw;
  if (op === "gte") return left >= raw;
  return false;
}

function matches(row: Row, column: string, expr: string): boolean {
  if (expr.startsWith("not.")) return !matches(row, column, expr.slice(4));
  const dot = expr.indexOf(".");
  const op = expr.slice(0, dot);
  const rest = expr.slice(dot + 1);
  const value = row[column];
  if (op === "eq") return looseEq(value, rest);
  if (op === "neq") return !looseEq(value, rest);
  if (op === "is") {
    if (rest === "null") return value == null;
    if (rest === "true") return value === true;
    if (rest === "false") return value === false;
    return false;
  }
  if (op === "in") {
    const inner = rest.startsWith("(") && rest.endsWith(")") ? rest.slice(1, -1) : rest;
    const parts = inner.length === 0 ? [] : inner.split(",").map((part) => part.replace(/^"|"$/g, ""));
    return parts.some((part) => looseEq(value, part));
  }
  if (op === "lt" || op === "lte" || op === "gt" || op === "gte") return compare(op, value, rest);
  if (op === "like" || op === "ilike") {
    const pattern = rest.replace(/%/g, "");
    return String(value ?? "").toLowerCase().includes(pattern.toLowerCase());
  }
  throw new Error(`Unhandled PostgREST operator ${column}=${expr}`);
}

function selected(url: URL, source: Row[]): Row[] {
  let rows = source.filter((row) => {
    for (const [key, value] of url.searchParams) {
      if (key === "select" || key === "order" || key === "limit" || key === "offset" || key === "on_conflict") continue;
      if (!matches(row, key, value)) return false;
    }
    return true;
  });
  const order = url.searchParams.get("order");
  if (order) {
    const [column, direction, nulls] = order.split(".");
    rows = [...rows].sort((left, right) => {
      const a = left[column!];
      const b = right[column!];
      if (a == null && b == null) return 0;
      if (a == null) return nulls === "nullslast" ? 1 : -1;
      if (b == null) return nulls === "nullslast" ? -1 : 1;
      if (a < b) return direction === "desc" ? 1 : -1;
      if (a > b) return direction === "desc" ? -1 : 1;
      return 0;
    });
  }
  const offset = Number(url.searchParams.get("offset") ?? "0");
  const limit = url.searchParams.get("limit");
  return rows.slice(offset, limit == null ? undefined : offset + Number(limit)).map((row) => clone(row));
}

function tableFrom(url: URL): string {
  const parts = url.pathname.split("/");
  return decodeURIComponent(parts[3] ?? "");
}

function conflictKeys(url: URL): string[] {
  const raw = url.searchParams.get("on_conflict");
  return raw ? raw.split(",").map((key) => key.trim()) : [];
}

function withId(row: Row): Row {
  if (row.id == null) row.id = `row-${idCounter++}`;
  return row;
}

function upsertRows(table: string, payload: Row[], keys: string[], ignoreDuplicates: boolean): Row[] {
  const stored = tables.get(table) ?? [];
  tables.set(table, stored);
  const written: Row[] = [];
  for (const incoming of payload) {
    const match = keys.length
      ? stored.find((row) => keys.every((key) => row[key] === incoming[key]))
      : undefined;
    if (match && ignoreDuplicates) continue;
    if (match) {
      Object.assign(match, clone(incoming));
      written.push(clone(match));
    } else {
      const created = withId(clone(incoming));
      stored.push(created);
      written.push(clone(created));
    }
  }
  return written;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function readBody(body: BodyInit | null | undefined): Promise<unknown> {
  if (body == null) return null;
  if (typeof body === "string") return body.length ? JSON.parse(body) : null;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  const buffer = await new Response(body).arrayBuffer();
  const bytes = Buffer.from(buffer);
  const asText = bytes.toString("utf8");
  if (asText.startsWith("{") || asText.startsWith("[")) {
    try {
      return JSON.parse(asText);
    } catch {
      return bytes;
    }
  }
  return bytes;
}

async function handleSupabase(url: URL, method: string, init?: RequestInit): Promise<Response> {
  if (url.pathname.startsWith("/storage/v1/object/sign/")) {
    return jsonResponse({ signedURL: "https://files.example.test/signed/resume" });
  }
  if (url.pathname.startsWith("/storage/v1/object/")) {
    const path = decodeURIComponent(url.pathname.slice("/storage/v1/object/captures/".length));
    const body = await readBody(init?.body);
    if (Buffer.isBuffer(body)) storage.set(path, body);
    return jsonResponse({ Key: path });
  }
  if (url.pathname.startsWith("/rest/v1/rpc/")) {
    const name = url.pathname.slice("/rest/v1/rpc/".length);
    const args = (await readBody(init?.body)) as Row | null;
    if (name === "attach_candidate_analyses_to_batch") {
      const ids = (args?.p_analysis_ids as string[] | undefined) ?? [];
      return jsonResponse(ids.length);
    }
    return jsonResponse(true);
  }

  const table = tableFrom(url);
  const stored = tables.get(table) ?? [];
  tables.set(table, stored);
  const prefer = new Headers(init?.headers).get("prefer") ?? "";
  const accept = new Headers(init?.headers).get("accept") ?? "";

  if (method === "HEAD" || method === "GET") {
    const rows = selected(url, stored);
    if (method === "HEAD") {
      return new Response(null, { status: 200, headers: { "content-range": `*/${rows.length}` } });
    }
    if (accept.includes("application/vnd.pgrst.object+json")) {
      if (rows.length !== 1) {
        return jsonResponse(
          { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" },
          406,
        );
      }
      return jsonResponse(rows[0]);
    }
    return jsonResponse(rows, 200, { "content-range": `*/${rows.length}` });
  }

  const payload = await readBody(init?.body);
  if (method === "DELETE") {
    const keep: Row[] = [];
    const removed: Row[] = [];
    for (const row of stored) {
      const urlMatch = [...url.searchParams].every(([key, value]) => {
        if (key === "select" || key === "order" || key === "limit" || key === "offset" || key === "on_conflict") return true;
        return matches(row, key, value);
      });
      if (urlMatch) removed.push(row);
      else keep.push(row);
    }
    tables.set(table, keep);
    return jsonResponse(removed);
  }

  if (method === "PATCH") {
    const patch = (payload ?? {}) as Row;
    const updated: Row[] = [];
    for (const row of stored) {
      const matchesFilter = [...url.searchParams].every(([key, value]) => {
        if (key === "select" || key === "order" || key === "limit" || key === "offset" || key === "on_conflict") return true;
        return matches(row, key, value);
      });
      if (!matchesFilter) continue;
      Object.assign(row, clone(patch));
      updated.push(clone(row));
    }
    return jsonResponse(updated);
  }

  if (method === "POST") {
    const rows = Array.isArray(payload) ? (payload as Row[]) : [payload as Row];
    const keys = conflictKeys(url);
    if (keys.length) {
      const ignore = prefer.includes("ignore-duplicates");
      const written = upsertRows(table, rows, keys, ignore);
      if (prefer.includes("return=representation")) return jsonResponse(written);
      return jsonResponse([]);
    }
    const inserted = rows.map((row) => {
      const created = withId(clone(row));
      stored.push(created);
      return clone(created);
    });
    return jsonResponse(prefer.includes("return=representation") ? inserted : []);
  }

  return jsonResponse({ message: `Unhandled ${method} ${url.pathname}` }, 500);
}

function listShape(candidate: Row): Row {
  return {
    id: candidate.id,
    name: candidate.name,
    firstname: candidate.firstname,
    lastname: candidate.lastname,
    headline: candidate.headline,
    account: candidate.account,
    job: candidate.job,
    stage: candidate.stage,
    disqualified: candidate.disqualified,
    disqualification_reason: candidate.disqualification_reason,
    sourced: candidate.sourced,
    profile_url: candidate.profile_url,
    email: candidate.email,
    domain: "example.test",
    created_at: candidate.created_at,
    updated_at: candidate.updated_at,
    address: candidate.address,
    phone: candidate.phone,
    resume_metadata: candidate.resume_metadata,
  };
}

async function handleFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? "GET").toUpperCase();

  if (url.hostname === "supabase.example.test") return handleSupabase(url, method, init);
  if (url.hostname === "files.example.test") {
    const text = files.get(url.href);
    if (text == null) return new Response("missing résumé", { status: 404 });
    return new Response(text, { status: 200, headers: { "content-type": "text/plain" } });
  }
  if (url.hostname === "api.anthropic.com") {
    return jsonResponse({
      id: "msgbatch_test",
      type: "message_batch",
      processing_status: "in_progress",
      request_counts: { processing: 1, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
      created_at: REVISED_AT,
      expires_at: "2026-03-03T00:00:00.000Z",
      ended_at: null,
      results_url: null,
    });
  }
  if (url.hostname === "rditrials.workable.com") {
    const path = url.pathname;
    if (path.endsWith("/activities")) return jsonResponse({ activities: [] });
    if (path.endsWith("/stages")) {
      return jsonResponse({
        stages: [
          { slug: "applied", name: "Applied", kind: "applied", position: 0 },
          { slug: "phone", name: "Phone", kind: "phone", position: 1 },
        ],
      });
    }
    if (method === "POST" || method === "PUT") return new Response(null, { status: 202 });
    if (/\/jobs\/[^/]+\/candidates\/[^/]+$/.test(path)) return jsonResponse({ candidate: clone(remote) });
    if (/\/jobs\/[^/]+\/candidates$/.test(path)) {
      return jsonResponse({ candidates: [listShape(remote)], paging: { next: null } });
    }
    if (/\/candidates\/[^/]+$/.test(path)) return jsonResponse({ candidate: clone(remote) });
  }
  throw new Error(`Unexpected fetch ${method} ${url.href}`);
}

globalThis.fetch = handleFetch as typeof fetch;

function originalCandidate(): Row {
  return {
    id: ID,
    name: "Alex Applicant",
    firstname: "Alex",
    lastname: "Applicant",
    headline: "Plant manager",
    account: { subdomain: "rditrials", name: "RDI" },
    job: { shortcode: JOB, title: "Plant Manager" },
    stage: "applied",
    disqualified: false,
    disqualification_reason: null,
    hired_at: null,
    sourced: false,
    profile_url: "https://rditrials.workable.com/backend/jobs/JOB1/candidates/cand-1",
    image_url: null,
    address: "Van Nuys, CA",
    phone: "555-0100",
    email: "alex@example.test",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: ORIGINAL_AT,
    resume_url: ORIGINAL_URL,
    cover_letter: "Original cover letter about the first plant role.",
    experience_entries: [
      {
        title: "Plant Manager",
        company: "Acme",
        industry: "Manufacturing",
        start_date: "2018-01-01",
        end_date: "2025-12-01",
        summary: "Ran the original plant.",
        current: false,
      },
    ],
    education_entries: [],
    answers: [{ question: { body: "Why this seat?" }, answer: { body: ORIGINAL_ANSWER } }],
    resume_metadata: {
      filename: "original.txt",
      filetype: "text/plain",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: ORIGINAL_AT,
    },
  };
}

function revisedApplication(candidate: Row, resumeUrl = REVISED_URL): Row {
  return {
    ...clone(candidate),
    updated_at: REVISED_AT,
    stage: candidate.stage,
    resume_url: resumeUrl,
    cover_letter: "Revised cover letter about the warehouse role.",
    experience_entries: [
      {
        title: "Warehouse Lead",
        company: "Northwind",
        industry: "Logistics",
        start_date: "2016-01-01",
        end_date: "2025-12-01",
        summary: "Ran the revised warehouse.",
        current: true,
      },
    ],
    answers: [{ question: { body: "Why this seat?" }, answer: { body: REVISED_ANSWER } }],
    resume_metadata: {
      filename: "revised.txt",
      filetype: "text/plain",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: REVISED_AT,
    },
  };
}

function stageOnly(candidate: Row): Row {
  return { ...clone(candidate), stage: "phone", updated_at: REVISED_AT };
}

let fingerprint: (candidate: Row) => string;

async function reset() {
  const { computeApplicationFingerprint } = await import("./candidate-hash.ts");
  fingerprint = computeApplicationFingerprint as (candidate: Row) => string;
  const candidate = originalCandidate();
  remote = clone(candidate);
  files = new Map([
    [ORIGINAL_URL, ORIGINAL_BODY],
    [REVISED_URL, REVISED_BODY],
  ]);
  idCounter = 1;
  tables.clear();
  storage.clear();
  storage.set(`${ID}/resume.bin`, Buffer.from(ORIGINAL_BODY));
  tables.set("candidates", [
    {
      workable_id: ID,
      job_shortcode: JOB,
      name: candidate.name,
      email: candidate.email,
      phone: candidate.phone,
      stage: "applied",
      disqualified: false,
      source: "applied",
      photo_url: null,
      created_at: candidate.created_at,
      workable_updated_at: ORIGINAL_AT,
      analysis_hash: fingerprint(candidate),
      synced_at: ORIGINAL_AT,
    },
  ]);
  tables.set("applications", [
    {
      id: "app-1",
      candidate_id: ID,
      answers: { "Why this seat?": ORIGINAL_ANSWER },
      cover_letter: candidate.cover_letter,
      resume_url: ORIGINAL_URL,
      resume_text: ORIGINAL_BODY,
      resume_storage_path: `${ID}/resume.bin`,
      resume_mime: "text/plain",
      resume_source_hash: "stored-with-the-first-file",
      parsed_experience: [{ title: "Plant Manager", company: "Acme", summary: "Ran the original plant." }],
      parsed_education: [],
    },
  ]);
  tables.set("evaluations", [
    {
      id: "fit-1",
      candidate_id: ID,
      kind: "fit_read",
      ref: null,
      payload: { sentiment: "good", why: "The first résumé supports an interview." },
      model_version: "test-model",
      created_at: ORIGINAL_AT,
    },
  ]);
  tables.set("jobs", [
    {
      shortcode: JOB,
      title: "Plant Manager",
      status: "published",
      department: "Operations",
      location: "Van Nuys, CA",
      raw: { full_description: "Own the plant. ".repeat(30) },
    },
  ]);
  tables.set("candidate_working_files", [
    {
      candidate_id: ID,
      content: "# Alex Applicant\n\nInterview first.\n",
      read: { decision: "interview", why: "The first résumé supports an interview.", risk: "", next: "Interview" },
      workspace: {},
      updated_at: ORIGINAL_AT,
    },
  ]);
  for (const name of ["evidence", "narratives", "audit_log", "candidate_analyses", "events", "candidate_overlay", "rubrics", "calibration", "job_rubrics", "claude_batches"]) {
    tables.set(name, []);
  }
}

function application(): Row {
  const row = (tables.get("applications") ?? []).find((item) => item.candidate_id === ID);
  if (!row) throw new Error("application row missing");
  return row;
}

function queuedRevision(answer: string): Row | undefined {
  return (tables.get("candidate_analyses") ?? []).find((row) => {
    if (row.candidate_id !== ID) return false;
    const snapshot = row.input_snapshot as { resumeText?: string; answers?: Record<string, string> } | null;
    const text = snapshot?.resumeText ?? "";
    const answers = JSON.stringify(snapshot?.answers ?? {});
    return text.includes("REVISED RESUME") && answers.includes(answer);
  });
}

function assertRefreshed(answer = REVISED_ANSWER) {
  const app = application();
  assert.equal(app.resume_text, REVISED_BODY);
  const path = app.resume_storage_path;
  assert.equal(typeof path, "string");
  const bytes = storage.get(path as string);
  assert.equal(bytes?.toString("utf8"), REVISED_BODY);
  assert.ok(queuedRevision(answer), "expected a queued re-score of the revised résumé and answers");
}

function assertStale() {
  const app = application();
  assert.equal(app.resume_text, ORIGINAL_BODY);
  assert.equal(storage.get(app.resume_storage_path as string)?.toString("utf8"), ORIGINAL_BODY);
  assert.equal((tables.get("candidate_analyses") ?? []).length, 0);
  const fit = (tables.get("evaluations") ?? []).find((row) => row.kind === "fit_read");
  assert.equal((fit?.payload as { why?: string } | undefined)?.why, "The first résumé supports an interview.");
}

test("changed Workable application refreshes the stored résumé and queues a new decision", { timeout: 120_000 }, async (t) => {
  const sync = await import("./workable-sync.ts");
  const incremental = await import("./incremental-sync.ts");
  const triage = await import("../../app/actions/triage.ts");
  const candidates = await import("../../app/actions/candidates.ts");

  await t.test("stage-move webhook replaces the file and queues a re-score", async () => {
    await reset();
    remote = revisedApplication(originalCandidate());
    await incremental.syncCandidateFromWebhook({ eventType: "candidate_moved", jobShortcode: JOB, candidateId: ID });
    assertRefreshed();
  });

  await t.test("stage-move webhook leaves the file when the application fingerprint is unchanged", async () => {
    await reset();
    remote = stageOnly(originalCandidate());
    await incremental.syncCandidateFromWebhook({ eventType: "candidate_moved", jobShortcode: JOB, candidateId: ID });
    assertStale();
  });

  await t.test("screening-answer change queues a re-score of the new answer and the current file", async () => {
    await reset();
    files.set(ORIGINAL_URL, REVISED_BODY);
    remote = revisedApplication(originalCandidate(), ORIGINAL_URL);
    await incremental.syncCandidateFromWebhook({ eventType: "candidate_moved", jobShortcode: JOB, candidateId: ID });
    assertRefreshed();
  });

  await t.test("second created-candidate event refreshes an application that already has a fingerprint", async () => {
    await reset();
    remote = revisedApplication(originalCandidate());
    await incremental.syncCandidateFromWebhook({ eventType: "candidate_created", jobShortcode: JOB, candidateId: ID });
    assertRefreshed();
  });

  await t.test("queued stage-move event refreshes the stored application", async () => {
    await reset();
    remote = revisedApplication(originalCandidate());
    tables.set("events", [
      {
        id: "event-1",
        source: "workable",
        type: "candidate_moved",
        processed: false,
        status: "pending",
        attempts: 0,
        received_at: ORIGINAL_AT,
        payload: { event_type: "candidate_moved", data: { candidate: { id: ID }, job: { shortcode: JOB } } },
      },
    ]);
    await incremental.processPendingWorkableEvents({ limit: 5, budgetMs: 20_000 });
    assertRefreshed();
  });

  await t.test("mirror of a changed candidate loads the full application and refreshes it", async () => {
    await reset();
    remote = revisedApplication(originalCandidate());
    await sync.syncChangedCandidatesForJob(JOB, ORIGINAL_AT);
    assertRefreshed();
  });

  await t.test("mirror of a stage change does not refresh an unchanged application", async () => {
    await reset();
    remote = stageOnly(originalCandidate());
    await sync.syncChangedCandidatesForJob(JOB, ORIGINAL_AT);
    assertStale();
  });

  await t.test("manual re-sync replaces a résumé that is already stored when the link changed", async () => {
    await reset();
    remote = revisedApplication(originalCandidate());
    const result = await triage.resyncCandidate({ candidateId: ID });
    assert.equal(result.ok, true, result.message);
    assertRefreshed();
  });

  await t.test("manual re-sync replaces a stored résumé when the candidate timestamp changed", async () => {
    await reset();
    files.set(ORIGINAL_URL, REVISED_BODY);
    const moved = stageOnly(originalCandidate());
    moved.resume_metadata = {
      ...(originalCandidate().resume_metadata as Row),
      updated_at: REVISED_AT,
    };
    remote = moved;
    const result = await triage.resyncCandidate({ candidateId: ID });
    assert.equal(result.ok, true, result.message);
    assertRefreshed(ORIGINAL_ANSWER);
  });

  await t.test("in-app stage move refreshes a changed application", async () => {
    await reset();
    remote = revisedApplication(originalCandidate(), REVISED_URL);
    remote.stage = "phone";
    const result = await triage.moveCandidateToStage({ jobShortcode: JOB, candidateId: ID, targetStage: "phone" });
    assert.equal(result.ok, true);
    assertRefreshed();
  });

  await t.test("advance refreshes a changed application", async () => {
    await reset();
    remote = revisedApplication(originalCandidate());
    remote.stage = "phone";
    const result = await candidates.advanceCandidate({ jobShortcode: JOB, candidateId: ID, currentStage: "applied" });
    assert.equal(result.ok, true);
    assertRefreshed();
  });

  await t.test("disqualify mirrors a changed application instead of keeping the first file", async () => {
    await reset();
    remote = revisedApplication(originalCandidate());
    remote.disqualified = true;
    remote.stage = "disqualified";
    const result = await candidates.denyCandidate({ jobShortcode: JOB, candidateId: ID, reason: "Not a fit" });
    assert.equal(result.ok, true);
    assertRefreshed();
  });

  await t.test("triage cut mirrors a changed application instead of keeping the first file", async () => {
    await reset();
    remote = revisedApplication(originalCandidate());
    remote.disqualified = true;
    const result = await triage.setDisqualified({ candidateId: ID, disqualified: true, reason: "Cut" });
    assert.equal(result.ok, true);
    assertRefreshed();
  });

  await t.test("patchCandidateFromWorkable refreshes a changed application", async () => {
    await reset();
    remote = revisedApplication(originalCandidate());
    await sync.patchCandidateFromWorkable(remote as never, JOB);
    assertRefreshed();
  });
});
