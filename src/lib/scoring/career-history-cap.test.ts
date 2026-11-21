/**
 * Spec for the first-pass career-history cap.
 *
 * These tests fail while a Workable applicant's experience summaries and
 * résumé bullets are copied into the grader request without the limit already
 * applied to résumé text. They pass once that history is truncated on the
 * first grading pass (synchronous and batch), including the joined bullet line.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import Module from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { WorkableCandidate } from "../workable/client.ts";

const RESUME_CAP = 12_000;
const HEAD = "CAREER_HISTORY_HEAD_";
const MARKER = "CAREER_HISTORY_PAST_CAP_MARKER";
const RESUME_MARKER = "RESUME_PAST_CAP";

const loader = Module as unknown as {
  _resolveFilename: (
    this: unknown,
    request: string,
    parent: unknown,
    isMain: boolean,
    options?: unknown,
  ) => string;
};
const originalResolve = loader._resolveFilename;
loader._resolveFilename = function (request, parent, isMain, options) {
  if (request === "server-only") {
    return path.resolve("node_modules/server-only/empty.js");
  }
  return originalResolve.call(this, request, parent, isMain, options);
};

process.env.ANTHROPIC_API_KEY = "placeholder-not-a-real-key";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "placeholder-service-key";
delete process.env.WORKABLE_TOKEN;
delete process.env.WORKABLE_API_KEY;

type Row = Record<string, unknown>;
type Db = { tables: Record<string, Row[]>; queries: string[] };
const state: { db: Db | null } = { db: null };

const require = createRequire(path.resolve("package.json"));
const supabaseJs = require("@supabase/supabase-js") as {
  createClient: (...args: unknown[]) => { from: (table: string) => unknown };
};
supabaseJs.createClient = () => ({
  from(table: string) {
    return queryBuilder(table);
  },
});

function currentDb(): Db {
  if (!state.db) throw new Error("test database was not installed");
  return state.db;
}

function queryBuilder(table: string) {
  const filters: Array<(row: Row) => boolean> = [];
  let limitN: number | null = null;
  let payload: Row | null = null;
  let wrote = false;
  const self: Record<string, unknown> = {};
  const chain = () => self;
  for (const method of ["select", "order", "range", "match", "or", "filter", "throwOnError"]) {
    self[method] = chain;
  }
  self.eq = (col: string, val: unknown) => {
    filters.push((row) => row[col] === val);
    return self;
  };
  self.neq = (col: string, val: unknown) => {
    filters.push((row) => row[col] !== val);
    return self;
  };
  self.in = (col: string, vals: unknown[]) => {
    const allowed = new Set(vals);
    filters.push((row) => allowed.has(row[col]));
    return self;
  };
  self.is = (col: string, val: unknown) => {
    filters.push((row) => (row[col] ?? null) === val);
    return self;
  };
  self.lt = chain;
  self.gt = chain;
  self.gte = chain;
  self.lte = chain;
  self.limit = (n: number) => {
    limitN = n;
    return self;
  };
  self.upsert = (row: Row) => {
    wrote = true;
    payload = { ...row };
    const rows = (currentDb().tables[table] ??= []);
    rows.push(payload);
    return self;
  };
  self.insert = self.upsert;
  self.update = (row: Row) => {
    wrote = true;
    payload = { ...row };
    return self;
  };
  self.delete = chain;
  const matched = () => {
    let rows = (currentDb().tables[table] ?? []).filter((row) => filters.every((fn) => fn(row)));
    if (limitN != null) rows = rows.slice(0, limitN);
    return rows;
  };
  self.maybeSingle = async () => {
    currentDb().queries.push(`${table} maybeSingle`);
    if (wrote && payload && filters.length === 0) return { data: payload, error: null };
    const rows = matched();
    return { data: rows[0] ?? null, error: null };
  };
  self.single = self.maybeSingle;
  self.then = (
    resolve: (value: { data: unknown; error: null }) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => {
    currentDb().queries.push(`${table} await`);
    const data = wrote && payload && filters.length === 0 ? payload : matched();
    return Promise.resolve({ data, error: null }).then(resolve, reject);
  };
  return self;
}

function installDb(): Db {
  state.db = { tables: {}, queries: [] };
  state.db.tables.jobs = [
    {
      shortcode: "PUB1",
      title: "Clinical Analyst",
      department: "Operations",
      location: "Van Nuys, CA",
      raw: { full_description: "Own diagnostic study operations for a public posting." },
    },
  ];
  state.db.tables.job_rubrics = [
    {
      job_shortcode: "PUB1",
      rubric_md: "",
      spec_md: "Own diagnostic study operations for a public posting, including timelines and vendors.",
    },
  ];
  return state.db;
}

function longHistory(): string {
  return HEAD + "a".repeat(RESUME_CAP) + MARKER;
}

function workableCandidate(
  id: string,
  entries: NonNullable<WorkableCandidate["experience_entries"]>,
): WorkableCandidate {
  return {
    id,
    name: "Public Applicant",
    firstname: "Public",
    lastname: "Applicant",
    headline: "",
    account: { subdomain: "rditrials", name: "RDI" },
    job: { shortcode: "PUB1", title: "Clinical Analyst" },
    stage: "Applied",
    disqualified: false,
    disqualification_reason: null,
    hired_at: null,
    sourced: false,
    profile_url: "https://example.test/candidates/" + id,
    address: "",
    phone: "",
    email: "applicant@example.test",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    resume_url: undefined,
    cover_letter: "",
    answers: [],
    education_entries: [],
    experience_entries: entries,
  };
}

type GraderParams = { messages: Array<{ content: unknown }> };

function userText(params: GraderParams): string {
  const content = params.messages[0]?.content;
  if (typeof content !== "string") {
    throw new Error("grader user message was not a string");
  }
  return content;
}

function rolesBlock(user: string): string {
  const header = "PARSED ROLES (oldest→newest where dated):\n";
  const start = user.indexOf(header);
  const end = user.indexOf("\n\nRÉSUMÉ TEXT:");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("grader prompt is missing the parsed-roles section");
  }
  return user.slice(start + header.length, end);
}

function assertCareerHistoryCapped(user: string, label: string) {
  const block = rolesBlock(user);
  assert.ok(
    block.length <= RESUME_CAP,
    `${label}: parsed career history is ${block.length} characters; résumé text is capped at ${RESUME_CAP}`,
  );
  assert.equal(
    user.includes(MARKER),
    false,
    `${label}: career-history text past the résumé cap was included in the first-pass grader prompt`,
  );
  assert.equal(
    user.includes(HEAD),
    true,
    `${label}: career history was removed instead of truncated`,
  );
  assert.equal(
    user.includes("IMPORTANT — DO NOT REFUSE"),
    false,
    `${label}: expected the first grading pass, before the refusal retry`,
  );
}

async function loadGrader() {
  const evaluator = await import("./evaluator.ts");
  const batchRequest = await import("../analysis/batch-request.ts");
  const encoderUrl = pathToFileURL(
    path.resolve("node_modules/@anthropic-ai/sdk/internal/request-options.mjs"),
  ).href;
  const encoderMod = (await import(encoderUrl)) as {
    FallbackEncoder: (input: { headers: Record<string, string>; body: unknown }) => { body: string };
  };
  return { evaluator, batchRequest, FallbackEncoder: encoderMod.FallbackEncoder };
}

async function storeApplicant(
  id: string,
  entries: NonNullable<WorkableCandidate["experience_entries"]>,
  resumeText: string,
) {
  const db = installDb();
  const { upsertCandidateFromWorkable } = await import("../sync/workable-sync.ts");
  const body = JSON.stringify({ candidate: workableCandidate(id, entries) });
  const parsed = JSON.parse(body) as { candidate: WorkableCandidate };
  await upsertCandidateFromWorkable(parsed.candidate, "PUB1", {
    analyze: false,
    syncComments: false,
  });
  const application = (db.tables.applications ?? []).find((row) => row.candidate_id === id);
  if (!application) throw new Error(`sync did not store an application for ${id}`);
  application.resume_text = resumeText;
  return { db, application };
}

async function gradeStored(candidateId: string, db: Db) {
  const { scoreCandidate } = await import("./run-score.ts");
  let result: unknown;
  try {
    result = await scoreCandidate(candidateId, {
      transport: "enqueue",
      trigger: "candidate_created",
    });
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nqueries:\n${db.queries.join("\n")}`,
    );
  }
  if (result && typeof result === "object" && "skipped" in result && result.skipped === true) {
    throw new Error(`grading was skipped: ${JSON.stringify(result)}\nqueries:\n${db.queries.join("\n")}`);
  }
  const snapshot = db.tables.candidate_analyses?.at(-1)?.input_snapshot;
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error(`grading did not snapshot an evaluator input\nqueries:\n${db.queries.join("\n")}`);
  }
  return snapshot as { resumeText: string; roles: unknown };
}

async function assertFirstPassCapped(snapshot: { resumeText: string; roles: unknown }, label: string) {
  const { evaluator, batchRequest, FallbackEncoder } = await loadGrader();
  const direct = evaluator.buildEvaluatorRequest(snapshot as never, false);
  assertCareerHistoryCapped(userText(direct), `${label} sync params`);

  const batch = batchRequest.batchRequestForAnalysis({
    id: "analysis-1",
    input_snapshot: snapshot as never,
    attempt_count: 0,
  });
  assertCareerHistoryCapped(userText(batch.params), `${label} batch params`);
  const encoded = FallbackEncoder({
    headers: {},
    body: { requests: [batch] },
  });
  assert.equal(encoded.body.includes(MARKER), false, `${label}: batch request body included the uncapped history`);
  assert.equal(encoded.body.includes(HEAD), true, `${label}: batch request body dropped the career history`);
  return direct;
}

const modelReply = {
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5",
  stop_reason: "end_turn",
  stop_sequence: null,
  content: [
    {
      type: "text",
      text: '{"categoryScores":{"principal":1,"environment":1,"scope":1,"writing":1,"tenure":1,"local":1}}',
    },
  ],
  usage: { input_tokens: 1, output_tokens: 1 },
};

test("first grading pass caps a Workable experience summary the way résumé text is capped", async () => {
  const resumeText = "R".repeat(RESUME_CAP) + RESUME_MARKER;
  const { db } = await storeApplicant(
    "applicant-summary",
    [
      {
        title: "Clinical Analyst",
        company: "PublicPostingCo",
        industry: "",
        start_date: "2018-01-01",
        end_date: "2024-01-01",
        current: false,
        summary: longHistory(),
      },
    ],
    resumeText,
  );
  const snapshot = await gradeStored("applicant-summary", db);
  const { evaluateCandidateWithUsage } = await import("./evaluator.ts");
  const originalFetch = globalThis.fetch;
  let url = "";
  let body = "";
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    url = String(input);
    body = typeof init?.body === "string" ? init.body : "";
    return new Response(JSON.stringify(modelReply), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  let callError: unknown = null;
  try {
    await evaluateCandidateWithUsage(snapshot as never);
  } catch (error) {
    callError = error;
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(url.includes("/v1/messages"), `first grading pass did not post to the messages API (${url})`);
  const sent = JSON.parse(body) as GraderParams;
  assertCareerHistoryCapped(userText(sent), "messages.create body");
  assert.equal(body.includes(RESUME_MARKER), false, "résumé text past the cap leaked into the model request");
  const direct = await assertFirstPassCapped(snapshot, "experience summary");
  assert.equal(
    userText(direct).includes(RESUME_MARKER),
    false,
    "résumé text past the cap leaked into the same prompt",
  );
  if (callError) throw callError;
});

test("first grading pass caps joined résumé bullets, including a duplicated resume line", async () => {
  const { parseResumeIntelligently } = await import("../resume/parse-resume.ts");
  const parsed = await parseResumeIntelligently({
    candidateName: "Public Applicant",
    resumeText: "short résumé",
    workableExperience: [
      {
        title: "Clinical Analyst",
        company: "PublicPostingCo",
        start: "2018-01-01",
        summary: longHistory(),
      },
    ],
  });
  const role = parsed.roles[0];
  if (!role) throw new Error("résumé parse produced no role");
  role.resumeLine = "";

  const { db, application } = await storeApplicant(
    "applicant-bullets",
    [
      {
        title: "Clinical Analyst",
        company: "PublicPostingCo",
        industry: "",
        start_date: "2018-01-01",
        end_date: "2024-01-01",
        current: false,
        summary: "short stored summary",
      },
    ],
    "short résumé",
  );
  application.resume_parsed = parsed;
  const snapshot = await gradeStored("applicant-bullets", db);
  await assertFirstPassCapped(snapshot, "joined bullets");
});

test("first grading pass caps a career history that is only large in aggregate", async () => {
  const entries = Array.from({ length: 40 }, (_, index) => ({
    title: index === 0 ? "FirstVisibleRole" : `Role${index}`,
    company: "PublicPostingCo",
    industry: "",
    start_date: "2010-01-01",
    end_date: "2011-06-01",
    current: false,
    summary:
      index === 0
        ? HEAD + "b".repeat(500)
        : index === 39
          ? "c".repeat(500) + MARKER
          : "d".repeat(500),
  }));
  const { db } = await storeApplicant("applicant-many", entries, "short résumé");
  const snapshot = await gradeStored("applicant-many", db);
  await assertFirstPassCapped(snapshot, "many roles");
});

test("grader still caps résumé text at 12000 characters", async () => {
  const { evaluator } = await loadGrader();
  const request = evaluator.buildEvaluatorRequest(
    {
      name: "Public Applicant",
      resumeText: "R".repeat(RESUME_CAP) + RESUME_MARKER,
      roles: [{ title: "Clinical Analyst", company: "PublicPostingCo", summary: "Owned a study." }],
      answers: {},
      seat: {
        jobShortcode: "PUB1",
        jobTitle: "Clinical Analyst",
        seatStratum: "IIIb–IIIa",
        jdSummary: "Own diagnostic study operations.",
        categoryLabels: {
          principal: "Principal",
          environment: "Environment",
          scope: "Scope",
          writing: "Writing",
          tenure: "Tenure",
          local: "Local",
        },
      },
      weights: {
        principal: 25,
        environment: 20,
        scope: 20,
        writing: 15,
        tenure: 10,
        local: 10,
      },
    },
    false,
  );
  const user = userText(request);
  assert.equal(user.includes(RESUME_MARKER), false);
  assert.equal(user.includes("R".repeat(100)), true);
});
