/**
 * Security contract for hiring-review model spend.
 *
 * These tests fail while any signed-in Clerk user can start an unbounded number
 * of Anthropic purchases. They pass once:
 * - saveCorrection, saveTranscript, runDeepAnalysis, reanalyze, compareToRubric,
 *   updateAssessment, and sendCandidateChat reject a session that is not Conall
 *   or Lara (reviewerKindFrom on the Clerk name or primary email) before any
 *   model request and before writing the candidate working file. A client-supplied
 *   reviewerKind must not count as that identity.
 * - A hiring-team session can cause at most MAX_GRADING_PURCHASES evaluator
 *   purchases (POST /v1/messages with max_tokens 8000) per candidate, and at most
 *   MAX_CHAT_TURNS war-room turns per candidate. Further attempts are rejected
 *   before the purchase. The reservation has to be atomic across the await that
 *   reaches Anthropic: a count read, then a later increment, still fails the
 *   parallel test.
 * - An identical in-flight or completed analysis fingerprint is not purchased
 *   again.
 *
 * The Anthropic stand-in is global fetch, used by @anthropic-ai/sdk 0.54.0
 * (client.mjs buildURL + fetchWithTimeout, messages.mjs create → POST /v1/messages).
 * The database stand-in applies the filters and the claim_candidate_analysis /
 * claim_candidate_analysis_projection updates from
 * supabase/migrations/20260831002527_canonical_candidate_analyses.sql.
 */
import assert from "node:assert/strict";
import { mock, test } from "node:test";

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "test-service-key-placeholder";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key-placeholder";
delete process.env.WORKABLE_TOKEN;
delete process.env.WORKABLE_API_KEY;
delete process.env.ANTHROPIC_BASE_URL;

const MAX_GRADING_PURCHASES = 2;
const MAX_CHAT_TURNS = 2;

interface Session {
  userId: string | null;
  firstName: string;
  lastName: string;
  email: string;
}

const session: Session = {
  userId: "user_outsider",
  firstName: "Pat",
  lastName: "Outsider",
  email: "outsider@example.com",
};

function asOutsider(): void {
  session.userId = "user_outsider";
  session.firstName = "Pat";
  session.lastName = "Outsider";
  session.email = "outsider@example.com";
}

function asHiringTeam(): void {
  session.userId = "user_conall";
  session.firstName = "Conall";
  session.lastName = "Hiring";
  session.email = "conall@example.com";
}

function asSignedOut(): void {
  session.userId = null;
  session.firstName = "";
  session.lastName = "";
  session.email = "";
}

mock.module("server-only", {
  namedExports: {},
});

mock.module("@clerk/nextjs/server", {
  namedExports: {
    auth: async () => ({ userId: session.userId }),
    currentUser: async () =>
      session.userId
        ? {
            id: session.userId,
            firstName: session.firstName,
            lastName: session.lastName,
            emailAddresses: [{ emailAddress: session.email }],
          }
        : null,
  },
});

mock.module("next/cache", {
  namedExports: {
    revalidatePath: () => {},
    revalidateTag: () => {},
    unstable_cache: (fn: unknown) => fn,
  },
});

type Row = Record<string, unknown>;

class MemorySupabase {
  tables = new Map<string, Row[]>();

  from(table: string): Query {
    const query = new Query(this, table);
    return new Proxy(query, {
      get(target, prop, receiver) {
        if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);
        if (prop in target) return Reflect.get(target, prop, receiver);
        return (...args: unknown[]) => {
          throw new Error(
            `memory supabase: ${table}.${String(prop)}(${JSON.stringify(args).slice(0, 180)}) is not implemented`,
          );
        };
      },
    });
  }

  rpc(name: string, args: Record<string, unknown>) {
    if (name === "claim_candidate_analysis") {
      const row = (this.tables.get("candidate_analyses") ?? []).find((item) => item.id === args.p_analysis_id);
      const claimable =
        !!row &&
        (row.batch_id == null) &&
        (row.status === "pending" || row.status === "failed");
      if (claimable && row) {
        const now = new Date().toISOString();
        row.status = "processing";
        row.started_at = now;
        row.updated_at = now;
        row.attempt_count = Number(row.attempt_count ?? 0) + 1;
        row.error = null;
      }
      return Promise.resolve({ data: claimable, error: null });
    }
    if (name === "claim_candidate_analysis_projection") {
      const row = (this.tables.get("candidate_analyses") ?? []).find((item) => item.id === args.p_analysis_id);
      const staleMinutes = Number(args.p_stale_minutes ?? 15);
      const started = row?.projection_started_at ? Date.parse(String(row.projection_started_at)) : null;
      const stale = started == null || started < Date.now() - staleMinutes * 60_000;
      const claimable =
        !!row && row.status === "completed" && row.projected_at == null && stale;
      if (claimable && row) {
        const now = new Date().toISOString();
        row.projection_started_at = now;
        row.updated_at = now;
      }
      return Promise.resolve({ data: claimable, error: null });
    }
    return Promise.resolve({ data: null, error: { message: `unknown rpc ${name}` } });
  }
}

interface Filter {
  kind: "eq" | "in" | "is" | "gte";
  column: string;
  value: unknown;
}

class Query {
  private op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  private payload: Row | Row[] | null = null;
  private filters: Filter[] = [];
  private orders: Array<{ column: string; ascending: boolean }> = [];
  private rowLimit: number | null = null;
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private onConflict: string[] = [];
  private ignoreDuplicates = false;
  private selected = false;

  constructor(
    private readonly db: MemorySupabase,
    private readonly table: string,
  ) {}

  select(_columns?: string, _options?: unknown): this {
    this.selected = true;
    return this;
  }

  insert(payload: Row | Row[]): this {
    this.op = "insert";
    this.payload = payload;
    return this;
  }

  upsert(payload: Row | Row[], options?: { onConflict?: string; ignoreDuplicates?: boolean }): this {
    this.op = "upsert";
    this.payload = payload;
    this.onConflict = (options?.onConflict ?? "id").split(",").map((part) => part.trim());
    this.ignoreDuplicates = Boolean(options?.ignoreDuplicates);
    return this;
  }

  update(payload: Row): this {
    this.op = "update";
    this.payload = payload;
    return this;
  }

  delete(): this {
    this.op = "delete";
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push({ kind: "eq", column, value });
    return this;
  }

  in(column: string, value: unknown[]): this {
    this.filters.push({ kind: "in", column, value });
    return this;
  }

  is(column: string, value: unknown): this {
    this.filters.push({ kind: "is", column, value });
    return this;
  }

  gte(column: string, value: unknown): this {
    this.filters.push({ kind: "gte", column, value });
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.orders.push({ column, ascending: options?.ascending !== false });
    return this;
  }

  limit(count: number): this {
    this.rowLimit = count;
    return this;
  }

  range(from: number, to: number): this {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }

  maybeSingle(): Promise<{ data: Row | null; error: { message: string } | null }> {
    return this.execute("maybe");
  }

  single(): Promise<{ data: Row | null; error: { message: string } | null }> {
    return this.execute("one");
  }

  then<TResult1 = { data: Row[] | null; error: { message: string } | null }, TResult2 = never>(
    onfulfilled?: ((value: { data: Row[] | null; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute("many").then(onfulfilled, onrejected);
  }

  private rows(): Row[] {
    if (!this.db.tables.has(this.table)) this.db.tables.set(this.table, []);
    return this.db.tables.get(this.table)!;
  }

  private matches(row: Row): boolean {
    return this.filters.every((filter) => {
      const current = row[filter.column];
      if (filter.kind === "eq") return current === filter.value;
      if (filter.kind === "in") return (filter.value as unknown[]).includes(current);
      if (filter.kind === "is") return filter.value == null ? current == null : current === filter.value;
      if (filter.kind === "gte") return String(current ?? "") >= String(filter.value ?? "");
      return false;
    });
  }

  private matching(): Row[] {
    return this.rows().filter((row) => this.matches(row));
  }

  private ordered(rows: Row[]): Row[] {
    if (!this.orders.length) return rows;
    return [...rows].sort((left, right) => {
      for (const order of this.orders) {
        const a = String(left[order.column] ?? "");
        const b = String(right[order.column] ?? "");
        if (a === b) continue;
        const cmp = a < b ? -1 : 1;
        return order.ascending ? cmp : -cmp;
      }
      return 0;
    });
  }

  private window(rows: Row[]): Row[] {
    let sliced = rows;
    if (this.rangeFrom != null && this.rangeTo != null) {
      sliced = sliced.slice(this.rangeFrom, this.rangeTo + 1);
    }
    if (this.rowLimit != null) sliced = sliced.slice(0, this.rowLimit);
    return sliced;
  }

  private clone<T>(value: T): T {
    return structuredClone(value);
  }

  private execute(shape: "many" | "maybe" | "one"): Promise<{ data: Row[] | Row | null; error: { message: string } | null }> {
    try {
      if (this.op === "insert" || this.op === "upsert") {
        const incoming = Array.isArray(this.payload) ? this.payload : [this.payload ?? {}];
        const stored: Row[] = [];
        for (const item of incoming) {
          const next = this.clone(item);
          if (next.id == null) next.id = crypto.randomUUID();
          if (this.op === "upsert") {
            const found = this.rows().find((row) =>
              this.onConflict.every((column) => row[column] === next[column]),
            );
            if (found) {
              if (this.ignoreDuplicates) continue;
              Object.assign(found, next);
              stored.push(found);
              continue;
            }
          }
          this.rows().push(next);
          stored.push(next);
        }
        return Promise.resolve(this.shapeResult(stored.map((row) => this.clone(row)), shape));
      }

      if (this.op === "update") {
        const patch = (this.payload ?? {}) as Row;
        const updated = this.matching();
        for (const row of updated) Object.assign(row, this.clone(patch));
        return Promise.resolve(this.shapeResult(updated.map((row) => this.clone(row)), shape));
      }

      if (this.op === "delete") {
        const keep = this.rows().filter((row) => !this.matches(row));
        this.db.tables.set(this.table, keep);
        return Promise.resolve(this.shapeResult([], shape));
      }

      const selected = this.window(this.ordered(this.matching())).map((row) => this.clone(row));
      return Promise.resolve(this.shapeResult(selected, shape));
    } catch (error) {
      return Promise.resolve({
        data: null,
        error: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private shapeResult(
    rows: Row[],
    shape: "many" | "maybe" | "one",
  ): { data: Row[] | Row | null; error: { message: string } | null } {
    if (shape === "many") return { data: rows, error: null };
    if (rows.length > 1) return { data: null, error: { message: `expected at most one ${this.table} row, found ${rows.length}` } };
    if (shape === "one" && rows.length === 0) return { data: null, error: { message: `no ${this.table} row` } };
    return { data: rows[0] ?? null, error: null };
  }
}

const db = new MemorySupabase();

mock.module("@/lib/supabase/server", {
  namedExports: {
    getServiceSupabase: () => db,
    getAnonSupabase: () => db,
  },
});

interface Purchase {
  url: string;
  maxTokens: number;
  body: string;
  candidateHint: string;
}

const purchases: Purchase[] = [];
let purchaseDelayMs = 0;

const EVALUATION_JSON = JSON.stringify({
  summary: "Owned a monitoring program and stated the sample size.",
  categoryScores: { principal: 10, environment: 8, scope: 8, writing: 6, tenure: 5, local: 4 },
  triage: { why: "Owned a monitoring program.", risk: "Confirm the sample size live." },
  salaryAsk: "120000",
  salaryValue: "justified",
  verification: { read: "Unverified (no profile)", claims: [] },
});

const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith("https://api.anthropic.com/v1/messages") && !url.includes("count_tokens")) {
    const body = typeof init?.body === "string" ? init.body : "";
    const parsed = body ? (JSON.parse(body) as { max_tokens?: number }) : {};
    purchases.push({
      url,
      maxTokens: Number(parsed.max_tokens ?? 0),
      body,
      candidateHint: body,
    });
    if (purchaseDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, purchaseDelayMs));
    const maxTokens = Number(parsed.max_tokens ?? 0);
    const text = maxTokens >= 8000 ? EVALUATION_JSON : "Hold as backup until the transcript is confirmed.";
    return new Response(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 12,
          output_tokens: 8,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        content: [{ type: "text", text }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return originalFetch(input, init);
};

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const nodeModule = require("module") as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = nodeModule._load;
nodeModule._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "@clerk/nextjs/server" || request.includes("@clerk/nextjs/dist/cjs/server/index")) {
    return {
      auth: async () => ({ userId: session.userId }),
      currentUser: async () =>
        session.userId
          ? {
              id: session.userId,
              firstName: session.firstName,
              lastName: session.lastName,
              emailAddresses: [{ emailAddress: session.email }],
            }
          : null,
    };
  }
  if (request === "next/cache" || request.endsWith("/next/cache.js")) {
    return {
      revalidatePath() {},
      revalidateTag() {},
      unstable_cache: (fn: unknown) => fn,
    };
  }
  if (request === "server-only") return {};
  if (request.includes("/lib/supabase/server")) {
    return { getServiceSupabase: () => db, getAnonSupabase: () => db };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const triage = await import("../src/app/actions/triage.ts");

const JOB = "CRA-TEST";

async function seedCandidate(candidateId: string, name: string): Promise<void> {
  const createdAt = new Date().toISOString();
  await db.from("candidates").insert({
    id: candidateId,
    workable_id: candidateId,
    job_shortcode: JOB,
    name,
    location: "Van Nuys, CA",
    stage: "Applied",
    disqualified: false,
    created_at: createdAt,
    raw: {},
  });
  await db.from("applications").insert({
    id: crypto.randomUUID(),
    candidate_id: candidateId,
    answers: { ownership: "I built the monitoring plan and owned the deviation log." },
    resume_text:
      "Clinical research associate. Built the monitoring plan, owned the deviation log, and trained two site staff over three years at a diagnostics sponsor.",
    cover_letter: "I want the operational load on this seat.",
    parsed_experience: [{ title: "CRA", company: "North Lab", start: "2019-01-01", end: "2022-01-01" }],
    resume_url: null,
    resume_storage_path: null,
  });
  if (!db.tables.get("jobs")?.some((row) => row.shortcode === JOB)) {
    await db.from("jobs").insert({
      id: crypto.randomUUID(),
      shortcode: JOB,
      title: "Clinical Operations Lead",
      department: "Clinical",
      location: "Van Nuys, CA",
      status: "published",
      raw: { full_description: "<p>Own monitoring standards and the deviation log for the diagnostics study.</p>" },
    });
  }
}

function workspaceSnapshot(candidateId: string): string {
  const row = (db.tables.get("candidate_working_files") ?? []).find((item) => item.candidate_id === candidateId);
  return JSON.stringify(row?.workspace ?? null);
}

function gradingPosts(name: string): Purchase[] {
  return purchases.filter((purchase) => purchase.maxTokens >= 8000 && purchase.body.includes(name));
}

function chatPosts(name: string): Purchase[] {
  return purchases.filter((purchase) => purchase.maxTokens === 1500 && purchase.body.includes(name));
}

async function settled<T>(run: () => Promise<T>): Promise<{ ok: boolean; message: string }> {
  try {
    const result = await run();
    if (result && typeof result === "object" && "ok" in result) {
      const message = "message" in result && typeof result.message === "string" ? result.message : "";
      return { ok: Boolean(result.ok), message };
    }
    return { ok: true, message: "" };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

test("a signed-out session never purchases a model call", async () => {
  asSignedOut();
  const name = "Signed Out Candidate";
  const id = "cand-signed-out";
  await seedCandidate(id, name);
  const before = purchases.length;
  const result = await settled(() => triage.saveCorrection({ candidateId: id, text: "should not run" }));
  assert.equal(result.ok, false);
  assert.match(result.message, /unauthorized/i);
  assert.equal(purchases.length, before);
});

test("an outsider session cannot purchase grading or chat, or write the working file", async () => {
  asOutsider();
  const name = "Outsider Candidate";
  const id = "cand-outsider";
  await seedCandidate(id, name);
  const beforeFile = workspaceSnapshot(id);
  const before = purchases.length;

  const calls = [
    () => triage.saveCorrection({ candidateId: id, text: "outsider note", reviewerKind: "conall" }),
    () => triage.saveTranscript({ candidateId: id, transcript: "Interviewer: tell me about a study you owned." }),
    () => triage.runDeepAnalysis({ candidateId: id }),
    () => triage.reanalyze({ candidateId: id }),
    () => triage.compareToRubric({ candidateId: id }),
    () => triage.updateAssessment({ candidateId: id }),
    () => triage.sendCandidateChat({ candidateId: id, message: "Should we interview them?" }),
  ];

  const results = [];
  for (const call of calls) results.push(await settled(call));

  assert.equal(purchases.length, before);
  assert.equal(workspaceSnapshot(id), beforeFile);
  assert.equal(gradingPosts(name).length + chatPosts(name).length, 0);
  for (const result of results) {
    assert.equal(result.ok, false, result.message);
    assert.match(result.message, /hiring|not allowed|unauthorized|forbidden|rate|limit|budget/i);
  }
});

test("a hiring-team correction purchases one analysis and sends the note", async () => {
  asHiringTeam();
  const name = "Single Note Candidate";
  const id = "cand-single-note";
  await seedCandidate(id, name);
  const note = "The deviation log was theirs, not the team's.";
  const result = await settled(() => triage.saveCorrection({ candidateId: id, text: note }));
  const posts = gradingPosts(name);
  assert.equal(posts.length, 1, result.message);
  assert.equal(posts[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(posts[0].maxTokens, 8000);
  assert.ok(posts[0].body.includes(note));
  assert.equal(result.ok, true, result.message);
});

test("distinct corrections past the per-candidate budget do not purchase again", async () => {
  asHiringTeam();
  const name = "Burst Note Candidate";
  const id = "cand-burst-notes";
  await seedCandidate(id, name);
  const attempts = 6;
  for (let index = 0; index < attempts; index += 1) {
    await settled(() => triage.saveCorrection({ candidateId: id, text: `Distinct hiring note ${index}` }));
  }
  const posts = gradingPosts(name);
  assert.ok(posts.length <= MAX_GRADING_PURCHASES, `evaluator purchases=${posts.length}`);
  assert.ok(posts.length >= 1);
});

test("parallel war-room messages share one atomic purchase budget", async () => {
  asHiringTeam();
  const name = "ParallelChatOnly";
  const id = "cand-parallel-chat";
  await seedCandidate(id, name);
  purchaseDelayMs = 40;
  try {
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        settled(() => triage.sendCandidateChat({ candidateId: id, message: `Parallel war room question ${index}` })),
      ),
    );
  } finally {
    purchaseDelayMs = 0;
  }
  const posts = chatPosts(name);
  assert.ok(posts.length <= MAX_CHAT_TURNS, `parallel chat purchases=${posts.length}`);
  assert.ok(posts.length >= 1);
});

test("distinct transcripts past the budget do not purchase again", async () => {
  asHiringTeam();
  const name = "Transcript Candidate";
  const id = "cand-transcripts";
  await seedCandidate(id, name);
  for (let index = 0; index < 4; index += 1) {
    await settled(() =>
      triage.saveTranscript({
        candidateId: id,
        transcript: `Interviewer: what did you own in study ${index}?\nCandidate: the monitoring plan.`,
      }),
    );
  }
  const posts = gradingPosts(name);
  assert.ok(posts.length <= MAX_GRADING_PURCHASES, `transcript purchases=${posts.length}`);
  assert.ok(posts.length >= 1);
});

test("a changed reply plus reanalyze past the budget does not purchase again", async () => {
  asHiringTeam();
  const name = "Reply Reanalyze Candidate";
  const id = "cand-reply-reanalyze";
  await seedCandidate(id, name);
  for (let index = 0; index < 4; index += 1) {
    await settled(() => triage.saveReply({ candidateId: id, key: "scope", value: `Owned study packet ${index}` }));
    await settled(() => triage.reanalyze({ candidateId: id }));
  }
  const posts = gradingPosts(name);
  assert.ok(posts.length <= MAX_GRADING_PURCHASES, `reanalyze purchases=${posts.length}`);
  assert.ok(posts.length >= 1);
});

test("an identical in-flight reanalysis is not purchased twice", async () => {
  asHiringTeam();
  const name = "Fingerprint Candidate";
  const id = "cand-fingerprint";
  await seedCandidate(id, name);
  purchaseDelayMs = 30;
  try {
    await Promise.all([
      settled(() => triage.reanalyze({ candidateId: id })),
      settled(() => triage.reanalyze({ candidateId: id })),
    ]);
  } finally {
    purchaseDelayMs = 0;
  }
  const posts = gradingPosts(name);
  assert.equal(posts.length, 1, `identical reanalyze purchases=${posts.length}`);
});

test("a second reanalyze of unchanged materials does not purchase again", async () => {
  asHiringTeam();
  const name = "Repeat Reanalyze Candidate";
  const id = "cand-repeat-reanalyze";
  await seedCandidate(id, name);
  await settled(() => triage.reanalyze({ candidateId: id }));
  await settled(() => triage.reanalyze({ candidateId: id }));
  assert.equal(gradingPosts(name).length, 1);
});

test("war-room messages past the per-candidate turn budget do not purchase again", async () => {
  asHiringTeam();
  const name = "SequentialChatOnly";
  const id = "cand-war-room";
  await seedCandidate(id, name);
  for (let index = 0; index < 5; index += 1) {
    await settled(() => triage.sendCandidateChat({ candidateId: id, message: `War room question ${index}` }));
  }
  const posts = chatPosts(name);
  assert.ok(posts.length <= MAX_CHAT_TURNS, `chat purchases=${posts.length}`);
  assert.ok(posts.every((post) => post.maxTokens === 1500));
  assert.ok(posts.length >= 1);
});

test("runDeepAnalysis, compareToRubric, and updateAssessment share the grading budget", async () => {
  asHiringTeam();
  const name = "Shared Grade Candidate";
  const id = "cand-shared-grade";
  await seedCandidate(id, name);
  await settled(() => triage.runDeepAnalysis({ candidateId: id }));
  await settled(() => triage.compareToRubric({ candidateId: id }));
  await settled(() => triage.updateAssessment({ candidateId: id }));
  for (let index = 0; index < 3; index += 1) {
    await settled(() => triage.saveCorrection({ candidateId: id, text: `Shared budget note ${index}` }));
  }
  const posts = gradingPosts(name);
  assert.ok(posts.length <= MAX_GRADING_PURCHASES, `shared grading purchases=${posts.length}`);
});
