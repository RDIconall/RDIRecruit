import Module from "node:module";
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkableJob } from "../src/lib/workable/client.ts";

// tsx loads server modules through require(), which resolves `server-only` to
// the client throw. Grading imports that marker only for the bundler. The
// empty module is what the react-server export condition maps to.
const nodeRequire = Module.prototype.require as (id: string) => unknown;
Module.prototype.require = function (id: string) {
  if (id === "server-only") return {};
  return nodeRequire.apply(this, arguments);
};

// Placeholders only. The stand-in never opens a network connection.
process.env.SUPABASE_URL = "https://placeholder.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "placeholder-service-key";
delete process.env.WORKABLE_TOKEN;
delete process.env.WORKABLE_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

/**
 * In-memory PostgREST for the queries grading actually issues.
 *
 * The request shape is the one @supabase/postgrest-js@2.108.1 builds
 * (node_modules/@supabase/postgrest-js/dist/index.mjs): filters are
 * `column=op.value` query params, `.single()` sends
 * `Accept: application/vnd.pgrst.object+json`, and `.maybeSingle()` unwraps a
 * one-element JSON array in the client. Upsert is POST with
 * `Prefer: resolution=merge-duplicates|ignore-duplicates` and `on_conflict`.
 */
type Row = Record<string, unknown>;
const tables = new Map<string, Row[]>();

function tableRows(name: string): Row[] {
  let rows = tables.get(name);
  if (!rows) {
    rows = [];
    tables.set(name, rows);
  }
  return rows;
}

function conflictKeys(table: string, onConflict: string | null): string[] {
  if (onConflict) return onConflict.split(",").map((part) => part.trim()).filter(Boolean);
  const defaults: Record<string, string[]> = {
    jobs: ["shortcode"],
    candidates: ["workable_id"],
    applications: ["candidate_id"],
    job_rubrics: ["job_shortcode"],
    candidate_working_files: ["candidate_id"],
  };
  return defaults[table] ?? ["id"];
}

function headerValue(headers: HeadersInit | undefined, name: string): string {
  if (!headers) return "";
  if (headers instanceof Headers) return headers.get(name) ?? "";
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return found ? String(found[1]) : "";
  }
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key]) : "";
}

function same(rowValue: unknown, raw: string): boolean {
  if (rowValue === raw) return true;
  if (typeof rowValue === "boolean" || typeof rowValue === "number") return String(rowValue) === raw;
  if (rowValue == null && raw === "null") return true;
  return false;
}

function applyFilters(rows: Row[], params: URLSearchParams): Row[] {
  let matched = rows.slice();
  for (const [key, raw] of params.entries()) {
    if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(key)) continue;
    if (raw.startsWith("eq.")) {
      const expected = raw.slice(3);
      matched = matched.filter((row) => same(row[key], expected));
      continue;
    }
    if (raw.startsWith("in.(") && raw.endsWith(")")) {
      const values = raw.slice(4, -1).split(",").map((item) => item.replace(/^"|"$/g, ""));
      matched = matched.filter((row) => values.some((value) => same(row[key], value)));
      continue;
    }
    if (raw.startsWith("is.")) {
      const flag = raw.slice(3);
      matched = matched.filter((row) => {
        if (flag === "null") return row[key] == null;
        if (flag === "true") return row[key] === true;
        if (flag === "false") return row[key] === false;
        return false;
      });
      continue;
    }
    throw new Error(`Unhandled PostgREST filter ${key}=${raw}`);
  }

  const order = params.get("order");
  if (order) {
    const parts = order.split(",");
    matched.sort((a, b) => {
      for (const part of parts) {
        const [column, direction] = part.split(".");
        const left = a[column!];
        const right = b[column!];
        if (left == null && right == null) continue;
        if (left == null) return 1;
        if (right == null) return -1;
        const cmp =
          typeof left === "number" && typeof right === "number"
            ? left - right
            : String(left).localeCompare(String(right));
        if (cmp !== 0) return direction === "desc" ? -cmp : cmp;
      }
      return 0;
    });
  }

  const limit = params.get("limit");
  if (limit) matched = matched.slice(0, Number(limit));
  return matched;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body == null ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function writeRows(table: string, body: unknown, params: URLSearchParams, prefer: string): Row[] {
  const incoming = (Array.isArray(body) ? body : [body]) as Row[];
  const keys = conflictKeys(table, params.get("on_conflict"));
  const ignore = prefer.includes("resolution=ignore-duplicates");
  const stored: Row[] = [];
  for (const row of incoming) {
    const existing = tableRows(table).find((candidate) =>
      keys.every((key) => candidate[key] !== undefined && candidate[key] === row[key]),
    );
    if (existing && ignore) continue;
    if (existing) {
      Object.assign(existing, row);
      stored.push(existing);
      continue;
    }
    const created = { id: crypto.randomUUID(), ...row };
    tableRows(table).push(created);
    stored.push(created);
  }
  return stored;
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  if (url.hostname !== "placeholder.supabase.co") return originalFetch(input, init);
  if (!url.pathname.startsWith("/rest/v1/")) return jsonResponse({});

  const table = decodeURIComponent(url.pathname.slice("/rest/v1/".length));
  const method = (init?.method ?? "GET").toUpperCase();
  const prefer = headerValue(init?.headers, "prefer");
  const accept = headerValue(init?.headers, "accept");
  const body =
    init?.body && typeof init.body === "string" && init.body.length ? JSON.parse(init.body) : null;

  if (method === "POST") {
    const stored = writeRows(table, body, url.searchParams, prefer);
    if (!prefer.includes("return=representation")) return new Response("", { status: 201 });
    return jsonResponse(stored);
  }

  if (method === "GET" || method === "HEAD") {
    const matched = applyFilters(tableRows(table), url.searchParams);
    if (accept.includes("application/vnd.pgrst.object+json")) {
      if (matched.length !== 1) {
        return jsonResponse(
          {
            code: "PGRST116",
            details: `Results contain ${matched.length} rows`,
            hint: null,
            message: "JSON object requested, multiple (or no) rows returned",
          },
          406,
        );
      }
      return jsonResponse(matched[0]);
    }
    return jsonResponse(matched);
  }

  return jsonResponse({ message: `Unhandled ${method} ${url.pathname}` }, 500);
};

const EA_MARKER = "RDI Executive Assistant Candidate Grading Rubric";
const CONTROLLER_MARKER = "RDI Senior Controller Candidate Grading Rubric";
const CRA_FILE_MARKER = "RDI Principal CRA Candidate Grading Rubric";
const MONITORING_MARKER = "Clinical Monitoring Standards Lead";

let getSeedRubricForJob: typeof import("../src/lib/docs/seed.ts").getSeedRubricForJob;
let getActiveRubric: typeof import("../src/lib/rubric/service.ts").getActiveRubric;
let DEFAULT_RUBRIC_MD: typeof import("../src/lib/rubric/parser.ts").DEFAULT_RUBRIC_MD;
let upsertJob: typeof import("../src/lib/sync/workable-sync.ts").upsertJob;
let scoreCandidate: typeof import("../src/lib/scoring/run-score.ts").scoreCandidate;
let getServiceSupabase: typeof import("../src/lib/supabase/server.ts").getServiceSupabase;
let HEAD_CLINICAL_OPS: typeof import("../src/lib/rubric/seat-rubrics.ts").HEAD_CLINICAL_OPS;

test.before(async () => {
  ({ getSeedRubricForJob } = await import("../src/lib/docs/seed.ts"));
  ({ getActiveRubric } = await import("../src/lib/rubric/service.ts"));
  ({ DEFAULT_RUBRIC_MD } = await import("../src/lib/rubric/parser.ts"));
  ({ upsertJob } = await import("../src/lib/sync/workable-sync.ts"));
  ({ scoreCandidate } = await import("../src/lib/scoring/run-score.ts"));
  ({ getServiceSupabase } = await import("../src/lib/supabase/server.ts"));
  ({ HEAD_CLINICAL_OPS } = await import("../src/lib/rubric/seat-rubrics.ts"));
});

test.beforeEach(() => {
  tables.clear();
});

function workableJob(title: string, shortcode: string): WorkableJob {
  return {
    id: `workable-${shortcode}`,
    title,
    shortcode,
    state: "published",
    department: "Clinical",
    url: `https://example.test/jobs/${shortcode}`,
    application_url: `https://example.test/apply/${shortcode}`,
    shortlink: `https://example.test/j/${shortcode}`,
    location: { location_str: "Van Nuys, CA" },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    full_description:
      "<p>Support study visits, source documents, and the investigator team on a diagnostic trial.</p>",
  };
}

function assertGenericSeed(seed: string | null, label: string) {
  const text = seed ?? "";
  for (const marker of [EA_MARKER, CONTROLLER_MARKER, CRA_FILE_MARKER, MONITORING_MARKER]) {
    assert.equal(
      text.includes(marker),
      false,
      `${label} loaded another seat's rubric (${marker}): ${text.slice(0, 140)}`,
    );
  }
  assert.ok(
    seed === null || seed === DEFAULT_RUBRIC_MD,
    `${label} should keep the generic default rubric, got ${text.slice(0, 140)}`,
  );
}

function assertDefaultRubric(raw: string, label: string) {
  if (raw !== DEFAULT_RUBRIC_MD) {
    assert.fail(
      `${label} was graded on ${JSON.stringify(raw.slice(0, 140))} (${raw.length} chars), not the generic default rubric`,
    );
  }
}

async function activeRaw(title: string, shortcode: string): Promise<string> {
  await upsertJob(workableJob(title, shortcode));
  const rubric = await getActiveRubric(shortcode);
  return rubric.rawMd;
}

for (const title of [
  "Clinical Research Assistant",
  "Research Assistant",
  "Principal Investigator",
  "Finance Coordinator",
]) {
  test(`seed matcher keeps ${title} off another seat's file`, async () => {
    assertGenericSeed(await getSeedRubricForJob(title, "SEED"), title);
  });
}

test("a tighter explicit title wins over an earlier single-word pattern", async () => {
  const seed = await getSeedRubricForJob("Accounting Executive Assistant", "AEA01");
  assert.ok(seed?.includes(EA_MARKER), `expected the executive-assistant rubric, got ${(seed ?? "null").slice(0, 140)}`);
  assert.equal(seed?.includes(CONTROLLER_MARKER), false);
});

test("explicit seat titles still resolve to that seat", async () => {
  const executive = await getSeedRubricForJob("Executive Assistant", "EA01");
  const controller = await getSeedRubricForJob("Senior Controller", "CTRL01");
  const associate = await getSeedRubricForJob("Clinical Research Associate", "CRA01");
  assert.ok(executive?.includes(EA_MARKER));
  assert.ok(controller?.includes(CONTROLLER_MARKER));
  assert.ok(associate?.includes(MONITORING_MARKER));
  assert.equal(associate?.includes(EA_MARKER), false);
});

for (const [title, shortcode] of [
  ["Clinical Research Assistant", "CRAASSIST02"],
  ["Principal Investigator", "PI02"],
  ["Finance Coordinator", "FIN02"],
] as const) {
  test(`active rubric for published ${title} stays on the generic default`, async () => {
    assertDefaultRubric(await activeRaw(title, shortcode), title);
  });
}

test("active rubric prefers the explicit executive-assistant title over the accounting token", async () => {
  const raw = await activeRaw("Accounting Executive Assistant", "AEA02");
  assert.ok(raw.includes(EA_MARKER), raw.slice(0, 140));
  assert.equal(raw.includes(CONTROLLER_MARKER), false);
});

test("a saved rubric and an explicit shortcode are not replaced by the title matcher", async () => {
  await upsertJob(workableJob("Clinical Research Assistant", "SAVED01"));
  const supabase = getServiceSupabase();
  const { error } = await supabase.from("rubrics").insert({
    job_shortcode: "SAVED01",
    version: 3,
    name: "Saved seat",
    raw_md: "SAVED RUBRIC MARKER for this requisition only",
    definition: {},
    weights: {},
    active: true,
  }).select("raw_md");
  assert.equal(error, null);
  const saved = await getActiveRubric("SAVED01");
  assert.equal(saved.rawMd, "SAVED RUBRIC MARKER for this requisition only");

  await upsertJob(workableJob("Clinical Research Assistant", HEAD_CLINICAL_OPS));
  const builtin = await getActiveRubric(HEAD_CLINICAL_OPS);
  assert.ok(builtin.rawMd.includes("Head of Clinical Operations"));
  assert.equal(builtin.rawMd.includes(EA_MARKER), false);
});

for (const [title, shortcode] of [
  ["Clinical Research Assistant", "CRAASSIST03"],
  ["Principal Investigator", "PI03"],
  ["Finance Coordinator", "FIN03"],
] as const) {
  test(`applicant grading queues the generic rubric for ${title}`, async () => {
    const queued = await gradePublished(title, shortcode);
    assert.equal(queued.seat.jobTitle, title);
    assertDefaultRubric(queued.rubricGuidance ?? "", `${title} grading`);
  });
}

test("applicant grading queues the executive-assistant rubric only for that seat", async () => {
  const ordered = await gradePublished("Accounting Executive Assistant", "AEA03");
  assert.equal(ordered.seat.jobTitle, "Accounting Executive Assistant");
  assert.ok((ordered.rubricGuidance ?? "").includes(EA_MARKER), (ordered.rubricGuidance ?? "").slice(0, 140));
  assert.equal((ordered.rubricGuidance ?? "").includes(CONTROLLER_MARKER), false);

  const executive = await gradePublished("Executive Assistant", "EA03");
  assert.ok((executive.rubricGuidance ?? "").includes(EA_MARKER));
});

async function gradePublished(title: string, shortcode: string) {
  const candidateId = `cand-${shortcode}`;
  await upsertJob(workableJob(title, shortcode));
  const stored = tableRows("jobs").find((row) => row.shortcode === shortcode);
  assert.equal(stored?.title, title);

  const supabase = getServiceSupabase();
  await supabase.from("candidates").upsert({
    workable_id: candidateId,
    job_shortcode: shortcode,
    name: "Alex Applicant",
    email: "alex@example.test",
    stage: "Applied",
    disqualified: false,
    source: "applied",
  });
  await supabase.from("applications").upsert({
    candidate_id: candidateId,
    resume_text:
      "Clinical research coordinator with six years of source-document review, visit support, and protocol deviation tracking.",
    answers: { "Why this role?": "I have coordinated study visits and protected data quality." },
    cover_letter: null,
    parsed_experience: [],
  });

  const result = await scoreCandidate(candidateId, {
    transport: "enqueue",
    trigger: "candidate_created",
  });
  assert.equal(
    "analysisId" in result,
    true,
    `grading did not queue an analysis: ${JSON.stringify(result)}`,
  );

  const { data, error } = await supabase
    .from("candidate_analyses")
    .select("*")
    .eq("candidate_id", candidateId)
    .limit(1)
    .maybeSingle();
  assert.equal(error, null);
  assert.ok(data?.input_snapshot, "queued analysis has no input snapshot");
  return data.input_snapshot as {
    seat: { jobTitle: string };
    rubricGuidance?: string | null;
  };
}
