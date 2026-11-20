import assert from "node:assert/strict";
import { createRequire, register } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

register("./tests/support/esm-resolve-hook.mjs", {
  parentURL: pathToFileURL(path.join(process.cwd(), "package.json")).href,
});
import type { MapInput } from "../src/lib/triage/from-supabase.ts";
import type { EvaluatorOutput } from "../src/lib/scoring/evaluator.ts";
import type { WorkableCandidate } from "../src/lib/workable/client.ts";

// Placeholders only. hasSupabase / hasWorkable / hasAnthropic read these once,
// at import, so they have to be set before those modules load. Keep this above
// every value import: a static import is evaluated first and would freeze env.
process.env.SUPABASE_URL = "https://placeholder.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "placeholder";
process.env.WORKABLE_TOKEN = "placeholder";
process.env.WORKABLE_SUBDOMAIN = "placeholder";
process.env.ANTHROPIC_API_KEY = "placeholder";

const require = createRequire(path.join(process.cwd(), "package.json"));
const Module = require("module") as NodeJS.Module & {
  _cache: Record<string, { exports: unknown; loaded?: boolean; id?: string; filename?: string }>;
  _resolveFilename: (
    request: string,
    parent: NodeJS.Module | null | undefined,
    isMain: boolean,
    options?: unknown,
  ) => string;
};
const resolveFilename = Module._resolveFilename;
const serverOnlyStub = path.resolve("tests/support/server-only-stub.cjs");
const memorySupabaseStub = path.resolve("tests/support/memory-supabase.mjs");
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "server-only") return serverOnlyStub;
  const resolved = resolveFilename.call(this, request, parent, isMain, options);
  if (String(request).includes("supabase/server") || String(resolved).includes(`${path.sep}supabase${path.sep}server`)) {
    return memorySupabaseStub;
  }
  return resolved;
};

type Row = Record<string, unknown>;
type Filter = { op: string; column: string; value: unknown };
type QueryState = {
  table: string;
  op: "select" | "insert" | "upsert" | "update" | "delete";
  payload?: Row | Row[];
  filters: Filter[];
  orders: Array<{ column: string; ascending: boolean; nullsFirst: boolean }>;
  limit?: number;
  range?: [number, number];
  single?: "maybe" | "one";
  head?: boolean;
  count?: string;
  onConflict?: string;
  ignoreDuplicates?: boolean;
};

class MemorySupabase {
  tables = new Map<string, Row[]>();
  private seq = 0;

  private rows(table: string): Row[] {
    let found = this.tables.get(table);
    if (!found) {
      found = [];
      this.tables.set(table, found);
    }
    return found;
  }

  private nextId(): string {
    this.seq += 1;
    return `mem-${this.seq}`;
  }

  from(table: string) {
    return chain(this, {
      table,
      op: "select",
      filters: [],
      orders: [],
    });
  }

  rpc(name: string, _args?: Record<string, unknown>) {
    // Automated re-score enqueues an analysis, then the batch submitter claims
    // it before calling the model. Declining the claim keeps this test off the
    // network while still letting the enqueue write the graded input.
    if (name === "try_acquire_scoring_lock") return Promise.resolve({ data: true, error: null });
    if (name === "release_scoring_lock") return Promise.resolve({ data: null, error: null });
    if (name === "claim_candidate_analysis") return Promise.resolve({ data: false, error: null });
    if (name === "claim_candidate_analysis_projection") return Promise.resolve({ data: true, error: null });
    return Promise.resolve({ data: null, error: { message: `unexpected rpc ${name}` } });
  }

  run(state: QueryState): { data: unknown; error: { message: string } | null; count?: number | null } {
    const table = this.rows(state.table);
    const matched = () => applyFilters(table, state.filters);

    if (state.op === "insert") {
      const incoming = Array.isArray(state.payload) ? state.payload : [state.payload ?? {}];
      const stored = incoming.map((row) => {
        const copy = { ...row };
        if (copy.id == null) copy.id = this.nextId();
        table.push(copy);
        return copy;
      });
      return finish(stored, state);
    }

    if (state.op === "upsert") {
      const incoming = Array.isArray(state.payload) ? state.payload : [state.payload ?? {}];
      const keys = (state.onConflict ?? "id").split(",").map((key) => key.trim());
      const stored: Row[] = [];
      for (const row of incoming) {
        const index = table.findIndex((existing) => keys.every((key) => existing[key] === row[key]));
        if (index >= 0 && state.ignoreDuplicates) continue;
        if (index >= 0) {
          table[index] = { ...table[index], ...row };
          stored.push(table[index]!);
        } else {
          const copy = { ...row };
          if (copy.id == null) copy.id = this.nextId();
          table.push(copy);
          stored.push(copy);
        }
      }
      return finish(stored, state);
    }

    if (state.op === "update") {
      for (const row of matched()) Object.assign(row, state.payload ?? {});
      return { data: null, error: null };
    }

    if (state.op === "delete") {
      const drop = new Set(matched());
      this.tables.set(
        state.table,
        table.filter((row) => !drop.has(row)),
      );
      return { data: null, error: null };
    }

    const selected = sortRows(matched(), state.orders);
    return finish(selected, state);
  }
}

function finish(rows: Row[], state: QueryState) {
  let sliced = rows;
  if (state.range) sliced = sliced.slice(state.range[0], state.range[1] + 1);
  if (state.limit != null) sliced = sliced.slice(0, state.limit);
  if (state.head) return { data: null, error: null, count: rows.length };
  if (state.single === "maybe") {
    return { data: sliced[0] ?? null, error: null, count: null };
  }
  if (state.single === "one") {
    if (sliced.length !== 1) {
      return { data: null, error: { message: `expected 1 row from ${state.table}, got ${sliced.length}` }, count: null };
    }
    return { data: sliced[0], error: null, count: null };
  }
  return { data: sliced, error: null, count: state.count ? rows.length : null };
}

function applyFilters(rows: Row[], filters: Filter[]): Row[] {
  return rows.filter((row) => filters.every((filter) => matchFilter(row, filter)));
}

function matchFilter(row: Row, filter: Filter): boolean {
  const value = row[filter.column];
  if (filter.op === "eq") return value === filter.value;
  if (filter.op === "neq") return value !== filter.value;
  if (filter.op === "in") return Array.isArray(filter.value) && filter.value.includes(value);
  if (filter.op === "is") return filter.value == null ? value == null : value === filter.value;
  if (filter.op === "lt") return value != null && String(value) < String(filter.value);
  if (filter.op === "gte") return value != null && String(value) >= String(filter.value);
  if (filter.op === "like") {
    const pattern = String(filter.value).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*");
    return new RegExp(`^${pattern}$`).test(String(value ?? ""));
  }
  throw new Error(`memory supabase cannot filter .${filter.op}()`);
}

function sortRows(rows: Row[], orders: QueryState["orders"]): Row[] {
  if (!orders.length) return rows;
  return [...rows].sort((left, right) => {
    for (const order of orders) {
      const a = left[order.column];
      const b = right[order.column];
      if (a == null && b == null) continue;
      if (a == null) return order.nullsFirst ? -1 : 1;
      if (b == null) return order.nullsFirst ? 1 : -1;
      if (String(a) < String(b)) return order.ascending ? -1 : 1;
      if (String(a) > String(b)) return order.ascending ? 1 : -1;
    }
    return 0;
  });
}

function chain(db: MemorySupabase, state: QueryState) {
  const api: Record<string, unknown> = {};
  const proxy = new Proxy(api, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);
      if (prop in target) return Reflect.get(target, prop, receiver);
      if (prop === "then") {
        return (resolve: (value: unknown) => void, reject: (error: unknown) => void) => {
          Promise.resolve(db.run(state)).then(resolve, reject);
        };
      }
      return () => {
        throw new Error(`memory supabase has no .${String(prop)}()`);
      };
    },
  });

  const filter = (op: string) => (column: string, value: unknown) => {
    state.filters.push({ op, column, value });
    return proxy;
  };
  Object.assign(api, {
    select(columns?: string, options?: { count?: string; head?: boolean }) {
      state.count = options?.count;
      state.head = options?.head;
      void columns;
      return proxy;
    },
    insert(payload: Row | Row[]) {
      state.op = "insert";
      state.payload = payload;
      return proxy;
    },
    upsert(payload: Row | Row[], options?: { onConflict?: string; ignoreDuplicates?: boolean }) {
      state.op = "upsert";
      state.payload = payload;
      state.onConflict = options?.onConflict;
      state.ignoreDuplicates = options?.ignoreDuplicates;
      return proxy;
    },
    update(payload: Row) {
      state.op = "update";
      state.payload = payload;
      return proxy;
    },
    delete() {
      state.op = "delete";
      return proxy;
    },
    eq: filter("eq"),
    neq: filter("neq"),
    in: filter("in"),
    is: filter("is"),
    lt: filter("lt"),
    gte: filter("gte"),
    like: filter("like"),
    order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }) {
      state.orders.push({
        column,
        ascending: options?.ascending !== false,
        nullsFirst: options?.nullsFirst === true,
      });
      return proxy;
    },
    limit(count: number) {
      state.limit = count;
      return proxy;
    },
    range(from: number, to: number) {
      state.range = [from, to];
      return proxy;
    },
    maybeSingle() {
      state.single = "maybe";
      return Promise.resolve(db.run(state));
    },
    single() {
      state.single = "one";
      return Promise.resolve(db.run(state));
    },
  });
  return proxy;
}

const { setMemorySupabase } = require("./tests/support/memory-supabase.mjs") as {
  setMemorySupabase: (db: MemorySupabase) => void;
};
let currentDb = new MemorySupabase();
setMemorySupabase(currentDb);

const sync = require("./src/lib/sync/workable-sync.ts") as typeof import("../src/lib/sync/workable-sync.ts");
const scoring = require("./src/lib/scoring/run-score.ts") as typeof import("../src/lib/scoring/run-score.ts");
const rescore = require("./src/lib/sync/rescore.ts") as typeof import("../src/lib/sync/rescore.ts");
const fitBackfill = require("./src/lib/triage/backfill-fit-reads.ts") as typeof import("../src/lib/triage/backfill-fit-reads.ts");
const { mapCandidate } = require("./src/lib/triage/from-supabase.ts") as typeof import("../src/lib/triage/from-supabase.ts");

const JOB = "JOB1";
const CANDIDATE = "cand-reapply";
const STORED_UPDATED_AT = "2026-02-01T00:00:00.000Z";
const EDITED_UPDATED_AT = "2026-03-15T00:00:00.000Z";
const ORIGIN = "https://placeholder.workable.com/spi/v3";

const STORED_ROLES = [
  { title: "Analyst", company: "Alpha", start: "2021-01-01", end: "2021-03-01", current: false, summary: "Bench work." },
  { title: "Analyst", company: "Beta", start: "2021-04-01", end: "2021-06-01", current: false, summary: "Bench work." },
  { title: "Analyst", company: "Gamma", start: "2021-07-01", end: "2021-09-01", current: false, summary: "Bench work." },
];

const NARRATIVE_FALLBACK = [
  { span: "2019-01 – 2019-09", type: "role", text: "Analyst at Alpha" },
  { span: "2019-01 – 2019-09", type: "role", text: "Analyst at Beta" },
  { span: "2019-01 – 2019-09", type: "role", text: "Analyst at Gamma" },
];

function experienceEntries(roles = STORED_ROLES) {
  return roles.map((role) => ({
    title: role.title,
    company: role.company,
    industry: "Research",
    start_date: role.start,
    end_date: role.end,
    current: role.current,
    summary: role.summary,
  }));
}

function baseCandidate(over: Partial<WorkableCandidate> = {}): WorkableCandidate {
  return {
    id: CANDIDATE,
    name: "Ada Applicant",
    firstname: "Ada",
    lastname: "Applicant",
    headline: "Analyst",
    account: { subdomain: "placeholder", name: "Placeholder" },
    job: { shortcode: JOB, title: "Clinical Research Associate" },
    stage: "Applied",
    disqualified: false,
    disqualification_reason: null,
    hired_at: null,
    sourced: false,
    profile_url: "https://placeholder.workable.com/backend/candidates/cand-reapply",
    address: "Los Angeles, CA",
    phone: "555-0100",
    email: "ada@example.com",
    created_at: "2026-01-15T00:00:00.000Z",
    updated_at: EDITED_UPDATED_AT,
    ...over,
  };
}

/** Shape of GET /jobs/:shortcode/candidates (and GET /candidates) in SPI v3: no experience or education. */
function summaryCandidate(): WorkableCandidate {
  return baseCandidate({ phone: "555-0199" });
}

function fullCandidate(roles = STORED_ROLES): WorkableCandidate {
  return baseCandidate({
    phone: "555-0199",
    resume_url: "https://files.example/resume.pdf",
    cover_letter: "I want the seat.",
    education_entries: [
      {
        school: "State University",
        degree: "B.S.",
        field_of_study: "Biology",
        start_date: "2016-09-01",
        end_date: "2020-05-01",
      },
    ],
    experience_entries: experienceEntries(roles),
    answers: [{ question: { body: "Why this role?" }, answer: { body: "I kept the deviation log current." } }],
  });
}

function useDatabase(seed?: (db: MemorySupabase) => void) {
  currentDb = new MemorySupabase();
  setMemorySupabase(currentDb);
  seed?.(currentDb);
  return currentDb;
}

function seedMirroredApplicant(db: MemorySupabase, options?: { scored?: boolean; emptyHistory?: boolean }) {
  const history = options?.emptyHistory ? [] : STORED_ROLES;
  db.tables.set("candidates", [
    {
      workable_id: CANDIDATE,
      job_shortcode: JOB,
      name: "Ada Applicant",
      email: "ada@example.com",
      phone: "555-0100",
      location: "Los Angeles, CA",
      stage: "Applied",
      disqualified: false,
      source: "applied",
      photo_url: "https://cdn.example/ada.jpg",
      raw: {
        ...fullCandidate(),
        phone: "555-0100",
        updated_at: STORED_UPDATED_AT,
        image_url: "https://cdn.example/ada.jpg",
      },
      created_at: "2026-01-15T00:00:00.000Z",
      workable_updated_at: STORED_UPDATED_AT,
      analysis_hash: "already-ingested",
      synced_at: STORED_UPDATED_AT,
    },
  ]);
  db.tables.set("applications", [
    {
      id: "app-1",
      candidate_id: CANDIDATE,
      answers: { "Why this role?": "I kept the deviation log current." },
      cover_letter: "I want the seat.",
      resume_url: "https://files.example/resume.pdf",
      resume_text: null,
      resume_parsed: null,
      parsed_experience: history,
      parsed_education: history.length
        ? [{ school: "State University", degree: "B.S.", field: "Biology", start: "2016-09-01", end: "2020-05-01" }]
        : [],
    },
  ]);
  db.tables.set("jobs", [
    {
      shortcode: JOB,
      title: "Clinical Research Associate",
      status: "published",
      department: "Clinical",
      location: "Van Nuys, CA",
      raw: {
        full_description: `<p>${"Own monitoring visits and the deviation log. ".repeat(30)}</p>`,
      },
    },
  ]);
  db.tables.set("narratives", [
    {
      id: "narrative-1",
      candidate_id: CANDIDATE,
      segments: NARRATIVE_FALLBACK,
      generated_at: "2026-02-02T00:00:00.000Z",
    },
  ]);
  db.tables.set("evaluations", options?.scored
    ? [
        {
          id: "fit-1",
          candidate_id: CANDIDATE,
          kind: "fit_read",
          model_version: "claude",
          created_at: "2026-02-02T00:00:00.000Z",
          payload: { reply: "Prior read." },
        },
      ]
    : []);
  db.tables.set("sync_state", [
    {
      key: "scoring_epoch:global",
      value: { at: "2026-04-01T00:00:00.000Z" },
    },
  ]);
  db.tables.set("candidate_overlay", []);
}

function applicationOf(db: MemorySupabase): Row {
  const row = db.tables.get("applications")?.find((item) => item.candidate_id === CANDIDATE);
  if (!row) throw new Error("application row missing");
  return row;
}

function candidateOf(db: MemorySupabase): Row {
  const row = db.tables.get("candidates")?.find((item) => item.workable_id === CANDIDATE);
  if (!row) throw new Error("candidate row missing");
  return row;
}

function dossierFrom(db: MemorySupabase) {
  const application = applicationOf(db);
  const candidate = candidateOf(db);
  const input: MapInput = {
    candidate: candidate as MapInput["candidate"],
    score: {
      id: "score-1",
      candidate_id: CANDIDATE,
      rubric_version: 1,
      category_scores: { principal: 0, environment: 0, scope: 0, writing: 0, tenure: 0, local: 0 },
      total: 80,
      salary_value: "justified",
      confidence: "high",
      model_version: "test",
      created_at: "2026-02-02T00:00:00.000Z",
    },
    ro: null,
    overlay: null,
    application: {
      answers: application.answers as NonNullable<MapInput["application"]>["answers"],
      cover_letter: application.cover_letter as string,
      parsed_experience: application.parsed_experience as NonNullable<MapInput["application"]>["parsed_experience"],
      resume_text: null,
      resume_url: application.resume_url as string,
    },
    narrative: NARRATIVE_FALLBACK as MapInput["narrative"],
    evals: {
      invest: {
        complement: "technician",
        head: "Work off the desk",
        removes: "monitoring load",
        vector: "priced about right",
        summary: "Runs monitoring end to end.",
        ask: "$120k",
      },
      dig: null,
      verification: null,
      roleReads: [],
      answerGrades: [],
      fitRead: null,
    },
    interviewEvidence: [],
    read: null,
    rank: 1,
    jobLocation: "Van Nuys, CA",
    jobShortcode: JOB,
  };
  return mapCandidate(input);
}

function assertHistoryKept(db: MemorySupabase) {
  const application = applicationOf(db);
  const candidate = candidateOf(db);
  const raw = candidate.raw as { experience_entries?: Array<{ company?: string }> };
  assert.deepEqual(
    (application.parsed_experience as Array<{ company: string }>).map((role) => role.company),
    ["Alpha", "Beta", "Gamma"],
    "structured roles must survive a summary that omits experience_entries",
  );
  assert.equal(
    (application.parsed_education as Array<{ school?: string }>)[0]?.school,
    "State University",
  );
  assert.deepEqual(
    (raw.experience_entries ?? []).map((entry) => entry.company),
    ["Alpha", "Beta", "Gamma"],
    "cached profile must keep the experience the list payload does not carry",
  );
  assert.equal(candidate.phone, "555-0199");
  assert.equal(candidate.photo_url, "https://cdn.example/ada.jpg");
  assert.deepEqual(application.answers, { "Why this role?": "I kept the deviation log current." });
  assert.equal(application.resume_url, "https://files.example/resume.pdf");
  assert.equal(application.cover_letter, "I want the seat.");

  const dossier = dossierFrom(db);
  assert.deepEqual(
    dossier.resume.roles.map((role) => role.company),
    ["Alpha", "Beta", "Gamma"],
  );
  const spanYears = new Date().getFullYear() - 2021;
  assert.equal(dossier.experience, spanYears >= 30 ? "30+ yr" : `${spanYears} yr`);
  const tenureFlag = dossier.redFlags.find((flag) => /short[- ]tenure/i.test(flag.flag));
  assert.ok(tenureFlag, "short-tenure warning should still be on the dossier");
  assert.match(tenureFlag.detail, /\(2 mo\)/);
  assert.doesNotMatch(tenureFlag.detail, /\(8 mo\)/);
}

const requestedUrls: string[] = [];

function fetchUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Nothing in this file may reach a live service. Routes are opt-in per test.
function installFetch(routes: Record<string, unknown> = {}) {
  requestedUrls.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = fetchUrl(input);
    requestedUrls.push(url);
    if (!url.startsWith(ORIGIN)) return jsonResponse({ error: "not found" }, 404);
    const pathAndQuery = url.slice(ORIGIN.length);
    if (pathAndQuery.includes("/activities")) return jsonResponse({ activities: [] });
    const body = routes[pathAndQuery];
    if (!body) return jsonResponse({ error: "not found" }, 404);
    return jsonResponse(body);
  }) as typeof fetch;
}

installFetch();

function summaryListBody() {
  return { candidates: [summaryCandidate()], paging: { next: null } };
}

test("incremental list sync keeps career history when the summary omits it", async () => {
  const db = useDatabase((memory) => seedMirroredApplicant(memory));
  installFetch({
    [`/jobs/${JOB}/candidates?limit=100&updated_after=${encodeURIComponent(STORED_UPDATED_AT)}`]: summaryListBody(),
  });

  const result = await sync.syncChangedCandidatesForJob(JOB, STORED_UPDATED_AT);
  assert.equal(result.failed, 0);
  assert.equal(result.changed, 1);
  assertHistoryKept(db);
});

test("full candidate mirror keeps career history when the summary omits it", async () => {
  const db = useDatabase((memory) => seedMirroredApplicant(memory));
  installFetch({
    [`/jobs/${JOB}/candidates?limit=100`]: summaryListBody(),
  });

  const result = await sync.syncChangedCandidatesForJob(JOB);
  assert.equal(result.failed, 0);
  assert.equal(result.changed, 1);
  assertHistoryKept(db);
});

test("patch from a summary payload keeps career history the summary does not carry", async () => {
  const db = useDatabase((memory) => seedMirroredApplicant(memory));
  await sync.patchCandidateFromWorkable(summaryCandidate(), JOB);
  assertHistoryKept(db);
});

test("a single-candidate payload replaces experience, including an explicit empty list", async () => {
  const db = useDatabase((memory) => seedMirroredApplicant(memory));
  await sync.upsertCandidateFromWorkable(
    fullCandidate([
      {
        title: "Lead",
        company: "Delta",
        start: "2018-01-01",
        end: "2024-01-01",
        current: false,
        summary: "Ran the group.",
      },
    ]),
    JOB,
  );
  assert.deepEqual(
    (applicationOf(db).parsed_experience as Array<{ company: string }>).map((role) => role.company),
    ["Delta"],
  );

  await sync.upsertCandidateFromWorkable(
    baseCandidate({
      updated_at: "2026-03-16T00:00:00.000Z",
      experience_entries: [],
      education_entries: [],
    }),
    JOB,
  );
  assert.deepEqual(applicationOf(db).parsed_experience, []);
  assert.deepEqual(applicationOf(db).parsed_education, []);
});

function gradingEvaluation(): EvaluatorOutput {
  return {
    complement: "technician",
    complementRemoves: "monitoring load",
    salaryVector: "priced about right",
    investHead: "Work off the desk",
    summary: "Runs the bench.",
    categoryScores: { principal: 1, environment: 1, scope: 1, writing: 1, tenure: 1, local: 1 },
    rubricSchemaVersion: 1,
    methodologyVersion: null,
    seatDimensionScores: {},
    personQuality: "solid",
    seatFit: { verdict: "fit", summary: "Fits the posting." },
    evidenceConfidence: "medium",
    integrityGate: { status: "clear", note: "" },
    otherGateResults: [],
    roDiagnostic: { note: "" },
    evidenceProvenance: [],
    alternateSeatSignals: [],
    liveValidationQuestions: [],
    capReasons: [],
    decisionBand: "HOLD",
    total: 60,
    confidence: "medium",
    salaryValue: "justified",
    salaryAsk: "$120k",
    seatStratum: "II",
    currentCapability: "II",
    trajectory: "flat",
    textConfidence: "medium",
    basis: "application",
    aiLikelihood: 0,
    roReads: [],
    digIn: { integrityNote: "", resolve: [] },
    verification: { read: "Clean", claims: [], questions: [], actions: [] },
    answerGrades: [],
    composeQuestions: [],
    triage: { why: "Owns the bench work.", risk: "Confirm scale live." },
    claims: [],
    heuristic: false,
  } as EvaluatorOutput;
}

function analysisRoles(db: MemorySupabase): Array<{ title?: string; company?: string }> {
  const row = db.tables.get("candidate_analyses")?.find((item) => item.candidate_id === CANDIDATE);
  assert.ok(row, "re-score should queue an analysis from the hydrated history");
  const snapshot = row.input_snapshot as { roles?: Array<{ title?: string; company?: string }> };
  return snapshot.roles ?? [];
}

test("stale re-score hydrates empty structured history before grading and keeps the timeline", async () => {
  const db = useDatabase((memory) => seedMirroredApplicant(memory, { scored: true, emptyHistory: true }));
  installFetch({
    [`/jobs/${JOB}/candidates/${CANDIDATE}`]: { candidate: fullCandidate() },
  });

  const pass = await sync.scoreUnscoredAcrossJobs({ budgetMs: 20_000, concurrency: 1 });
  assert.equal(pass.failed, 0);
  assert.ok(
    requestedUrls.some((url) => url === `${ORIGIN}/jobs/${JOB}/candidates/${CANDIDATE}`),
    "already-scored re-score must load the single-candidate record when structured history is empty",
  );
  assert.deepEqual(
    (applicationOf(db).parsed_experience as Array<{ company: string }>).map((role) => role.company),
    ["Alpha", "Beta", "Gamma"],
  );
  assert.deepEqual(
    analysisRoles(db).map((role) => role.company),
    ["Alpha", "Beta", "Gamma"],
  );

  await scoring.scoreCandidate(CANDIDATE, {
    force: true,
    replace: true,
    evaluation: gradingEvaluation(),
    trigger: "batch_projection",
  });
  const segments = (db.tables.get("narratives") ?? []).flatMap(
    (row) => (row.segments as Array<{ type?: string; text?: string }> | undefined) ?? [],
  );
  assert.ok(segments.some((segment) => segment.type === "role" && segment.text?.includes("Alpha")));
  assert.ok(segments.some((segment) => segment.type === "role" && segment.text?.includes("Gamma")));
  assert.ok((db.tables.get("scores") ?? []).some((row) => row.candidate_id === CANDIDATE));
});

test("unscored batch hydrates a file whose structured history is empty before grading", async () => {
  const db = useDatabase((memory) => seedMirroredApplicant(memory, { emptyHistory: true }));
  installFetch({
    [`/jobs/${JOB}/candidates/${CANDIDATE}`]: { candidate: fullCandidate() },
  });

  await sync.scoreUnscoredBatch([CANDIDATE]);
  assert.ok(requestedUrls.some((url) => url === `${ORIGIN}/jobs/${JOB}/candidates/${CANDIDATE}`));
  assert.deepEqual(analysisRoles(db).map((role) => role.company), ["Alpha", "Beta", "Gamma"]);
});

test("fit-read backfill hydrates a file whose structured history is empty before grading", async () => {
  const db = useDatabase((memory) => seedMirroredApplicant(memory, { emptyHistory: true }));
  installFetch({
    [`/jobs/${JOB}/candidates/${CANDIDATE}`]: { candidate: fullCandidate() },
  });

  await fitBackfill.backfillMissingFitReads({ budgetMs: 20_000 });
  assert.ok(requestedUrls.some((url) => url === `${ORIGIN}/jobs/${JOB}/candidates/${CANDIDATE}`));
  assert.deepEqual(analysisRoles(db).map((role) => role.company), ["Alpha", "Beta", "Gamma"]);
});

test("evidence re-score hydrates a file whose structured history is empty before grading", async () => {
  const db = useDatabase((memory) => seedMirroredApplicant(memory, { scored: true, emptyHistory: true }));
  installFetch({
    [`/jobs/${JOB}/candidates/${CANDIDATE}`]: { candidate: fullCandidate() },
  });

  await rescore.rescoreCandidateOnNewEvidence(CANDIDATE, "interview");
  assert.ok(requestedUrls.some((url) => url === `${ORIGIN}/jobs/${JOB}/candidates/${CANDIDATE}`));
  assert.deepEqual(analysisRoles(db).map((role) => role.company), ["Alpha", "Beta", "Gamma"]);
});
