/**
 * Spec for the hiring-board denial of service: activity notes, pasted
 * transcripts, and the other reviewer-authored texts that share that path.
 *
 * These tests fail while the vulnerability is present. They pass once each
 * write rejects oversized text before any database write, and once building
 * the pool no longer reads the full stored texts into the list payload.
 *
 * Run:
 *   node --experimental-test-module-mocks --import tsx --test tests/uncapped-notes-dos.test.ts
 *
 * `npm test` does not enable Node's module mocks, so this file skips there.
 */

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";

const canMock = typeof (mock as { module?: unknown }).module === "function";

/** Reviewer note, comment, correction, reply, chat message, timeline field. */
const TEXT_MAX = 4_000;
/** Pasted interview transcript or VideoAsk answers. */
const TRANSCRIPT_MAX = 20_000;
/** Author label stored on an activity row. */
const AUTHOR_MAX = 200;
/**
 * Activity `body` characters the pool builder may read while listing the board.
 * Three max-length notes are a normal log and must still be stored; the list
 * read has to stay under this budget.
 */
const POOL_ACTIVITY_BODY_BUDGET = 8_000;

const JOB = "JOB1";
const CANDIDATE = "app-1001";
const OTHER = "app-1002";

/** Under Next.js 16.2.9's default 1 MB server-action body limit, so the framework would deliver it. */
const OVERSIZE = 200_000;

type Row = Record<string, unknown>;

const tables: Record<string, Row[]> = {};
const writes: { table: string; row: Row }[] = [];
const reads: { table: string; rows: Row[] }[] = [];
let captureReads = false;
let signedIn = true;

const FK_CANDIDATE: Record<string, string> = {
  activity: "candidate_id",
  candidate_working_files: "candidate_id",
  evidence: "candidate_id",
  applications: "candidate_id",
  evaluations: "candidate_id",
  narratives: "candidate_id",
  scores: "candidate_id",
  ro_assessments: "candidate_id",
  candidate_overlay: "candidate_id",
};

function table(name: string): Row[] {
  if (!tables[name]) tables[name] = [];
  return tables[name];
}

function candidateExists(id: unknown): boolean {
  return table("candidates").some((row) => row.workable_id === id);
}

function project(row: Row, columns: string): Row {
  const spec = columns.trim();
  if (!spec || spec === "*") return { ...row };
  const out: Row = {};
  for (const part of spec.split(",")) {
    const col = part.trim();
    if (!col || col === "*") continue;
    // Plain column list, which is what the pool loader sends. Expressions are
    // not rewritten; a named column is returned in full, as PostgREST does.
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(col)) out[col] = row[col];
  }
  return out;
}

class Query {
  private filters: Array<(row: Row) => boolean> = [];
  private orders: Array<{ col: string; asc: boolean }> = [];
  private rangeBounds: [number, number] | null = null;
  private limitN: number | null = null;
  private mode: "select" | "insert" | "update" | "upsert" = "select";
  private payload: Row | Row[] | null = null;
  private columns = "*";
  private onConflict: string | null = null;
  private returning = false;

  constructor(private readonly name: string) {}

  select(columns = "*") {
    this.columns = columns;
    if (this.mode === "select") this.mode = "select";
    else this.returning = true;
    return this;
  }
  insert(payload: Row | Row[]) {
    this.mode = "insert";
    this.payload = payload;
    return this;
  }
  upsert(payload: Row, opts?: { onConflict?: string }) {
    this.mode = "upsert";
    this.payload = payload;
    this.onConflict = opts?.onConflict ?? null;
    return this;
  }
  update(payload: Row) {
    this.mode = "update";
    this.payload = payload;
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push((row) => row[col] === val);
    return this;
  }
  neq(col: string, val: unknown) {
    this.filters.push((row) => row[col] !== val);
    return this;
  }
  in(col: string, vals: readonly unknown[]) {
    const set = new Set(vals);
    this.filters.push((row) => set.has(row[col]));
    return this;
  }
  gte(col: string, val: unknown) {
    this.filters.push((row) => String(row[col] ?? "") >= String(val ?? ""));
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orders.push({ col, asc: opts?.ascending !== false });
    return this;
  }
  range(from: number, to: number) {
    this.rangeBounds = [from, to];
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }

  private matched(source: Row[]): Row[] {
    let out = source.filter((row) => this.filters.every((fn) => fn(row)));
    if (this.orders.length) {
      out = [...out].sort((a, b) => {
        for (const order of this.orders) {
          const av = String(a[order.col] ?? "");
          const bv = String(b[order.col] ?? "");
          if (av === bv) continue;
          const cmp = av < bv ? -1 : 1;
          return order.asc ? cmp : -cmp;
        }
        return 0;
      });
    }
    if (this.rangeBounds) {
      const [from, to] = this.rangeBounds;
      out = out.slice(from, to + 1);
    } else if (this.limitN != null) {
      out = out.slice(0, this.limitN);
    }
    return out;
  }

  private execute(): { data: Row[] | null; error: { message: string; code?: string } | null } {
    if (this.mode === "insert" || this.mode === "upsert") {
      const incoming = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      const stored: Row[] = [];
      for (const raw of incoming) {
        const fk = FK_CANDIDATE[this.name];
        if (fk && raw[fk] != null && !candidateExists(raw[fk])) {
          return {
            data: null,
            error: {
              message: `insert or update on table "${this.name}" violates foreign key constraint`,
              code: "23503",
            },
          };
        }
        const row: Row = { ...raw };
        if (!row.id && (this.name === "activity" || this.name === "evidence")) row.id = crypto.randomUUID();
        if (!row.created_at && (this.name === "activity" || this.name === "evidence")) {
          row.created_at = new Date().toISOString();
        }
        writes.push({ table: this.name, row: { ...row } });
        if (this.mode === "upsert" && this.onConflict) {
          const key = this.onConflict;
          const idx = table(this.name).findIndex((existing) => existing[key] === row[key]);
          if (idx >= 0) table(this.name)[idx] = row;
          else table(this.name).push(row);
        } else {
          table(this.name).push(row);
        }
        stored.push(row);
      }
      return { data: this.returning ? stored.map((row) => project(row, this.columns)) : stored, error: null };
    }

    if (this.mode === "update") {
      const matched = table(this.name).filter((row) => this.filters.every((fn) => fn(row)));
      for (const row of matched) {
        Object.assign(row, this.payload);
        writes.push({ table: this.name, row: { ...row } });
      }
      return { data: this.returning ? matched.map((row) => project(row, this.columns)) : matched, error: null };
    }

    const matched = this.matched(table(this.name)).map((row) => project(row, this.columns));
    if (captureReads) reads.push({ table: this.name, rows: matched.map((row) => ({ ...row })) });
    return { data: matched, error: null };
  }

  maybeSingle() {
    const result = this.execute();
    if (result.error) return Promise.resolve({ data: null, error: result.error });
    const rows = result.data ?? [];
    if (rows.length > 1) return Promise.resolve({ data: null, error: { message: "multiple rows", code: "PGRST116" } });
    return Promise.resolve({ data: rows[0] ?? null, error: null });
  }

  single() {
    const result = this.execute();
    if (result.error) return Promise.resolve({ data: null, error: result.error });
    const rows = result.data ?? [];
    if (rows.length !== 1) return Promise.resolve({ data: null, error: { message: "expected one row" } });
    return Promise.resolve({ data: rows[0], error: null });
  }

  then<TResult1 = { data: Row[] | null; error: { message: string; code?: string } | null }, TResult2 = never>(
    onfulfilled?: ((value: { data: Row[] | null; error: { message: string; code?: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }
}

function serviceClient() {
  return {
    from(name: string) {
      return new Query(name);
    },
  };
}

function resetDb() {
  for (const key of Object.keys(tables)) delete tables[key];
  writes.length = 0;
  reads.length = 0;
  captureReads = false;
  signedIn = true;
  const now = "2026-11-20T15:00:00.000Z";
  table("jobs").push({
    shortcode: JOB,
    title: "Clinical Data Manager",
    status: "published",
    department: null,
    location: null,
  });
  for (const id of [CANDIDATE, OTHER]) {
    table("candidates").push({
      workable_id: id,
      job_shortcode: JOB,
      name: id === CANDIDATE ? "Pat Example" : "Other Applicant",
      email: null,
      phone: null,
      location: "Los Angeles, CA",
      stage: "Applied",
      stage_kind: null,
      disqualified: false,
      source: null,
      assignee_id: null,
      raw: null,
      photo_url: null,
      created_at: now,
      synced_at: now,
    });
  }
}

function textOf(length: number, tail: string): string {
  if (tail.length >= length) return tail.slice(0, length);
  return `${"x".repeat(length - tail.length)}${tail}`;
}

function activityRows(): Row[] {
  return table("activity");
}

function workingFile(id = CANDIDATE): Row | undefined {
  return table("candidate_working_files").find((row) => row.candidate_id === id);
}

function evidenceRows(): Row[] {
  return table("evidence");
}

function snapshotWrites(): number {
  return writes.length;
}

function newWrites(since: number): { table: string; row: Row }[] {
  return writes.slice(since);
}

function containsText(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value.includes(needle);
  if (Array.isArray(value)) return value.some((item) => containsText(item, needle));
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((item) => containsText(item, needle));
  }
  return false;
}

if (!canMock) {
  test("uncapped hiring notes", {
    skip: "requires node --experimental-test-module-mocks --import tsx --test tests/uncapped-notes-dos.test.ts",
  });
} else {
  process.env.SUPABASE_URL = "https://placeholder.supabase.co";
  process.env.SUPABASE_SERVICE_KEY = "placeholder-not-a-secret";
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.WORKABLE_TOKEN;
  delete process.env.WORKABLE_API_KEY;

  mock.module("server-only", { namedExports: {} });
  mock.module("next/cache", {
    namedExports: {
      revalidatePath() {},
      revalidateTag() {},
      unstable_cache(fn: unknown) {
        return fn;
      },
    },
  });
  // tsx compiles the actions to CommonJS, which loads Clerk's CJS build.
  // The package specifier mock replaces the ESM entry only, so both are mocked.
  const clerkExports = {
    auth: async () => (signedIn ? { userId: "user_public_signup" } : { userId: null }),
    currentUser: async () =>
      signedIn
        ? {
            id: "user_public_signup",
            firstName: "Ada",
            lastName: "Example",
            emailAddresses: [{ emailAddress: "ada@example.com" }],
          }
        : null,
  };
  mock.module("@clerk/nextjs/server", { namedExports: clerkExports });
  mock.module(fileURLToPath(new URL("../node_modules/@clerk/nextjs/dist/cjs/server/index.js", import.meta.url)), {
    namedExports: clerkExports,
  });
  mock.module("@/lib/supabase/server", {
    namedExports: {
      getServiceSupabase: () => serviceClient(),
      getAnonSupabase: () => serviceClient(),
    },
  });

  let triage: typeof import("../src/app/actions/triage.ts");
  let interviews: typeof import("../src/app/actions/interviews.ts");
  let load: typeof import("../src/lib/triage/load.ts");

  test.before(async () => {
    triage = await import("../src/app/actions/triage.ts");
    interviews = await import("../src/app/actions/interviews.ts");
    load = await import("../src/lib/triage/load.ts");
  });

  test.beforeEach(() => {
    resetDb();
  });

  test("a signed-out caller cannot append an activity note", async () => {
    signedIn = false;
    const since = snapshotWrites();
    await assert.rejects(() => triage.logActivity({ candidateId: CANDIDATE, type: "note", body: "hello" }), /Unauthorized/);
    assert.equal(newWrites(since).length, 0);
    assert.equal(activityRows().length, 0);
  });

  test("a signed-in caller with no assignee role can append a normal note on any applicant", async () => {
    const body = "Spoke with the applicant about the start date.";
    const result = await triage.logActivity({ candidateId: OTHER, type: "note", body });
    assert.equal(result.ok, true);
    assert.equal(activityRows().filter((row) => row.candidate_id === OTHER && row.body === body).length, 1);
  });

  for (const type of ["note", "comment", "interview"] as const) {
    test(`logActivity rejects an oversized ${type} before insert`, async () => {
      const body = textOf(OVERSIZE, `OVERSIZE-${type}-TAIL`);
      const since = snapshotWrites();
      const result = await triage.logActivity({ candidateId: CANDIDATE, type, body });
      assert.equal(result.ok, false);
      assert.equal(
        newWrites(since).some((write) => write.table === "activity"),
        false,
        "the activity insert must not run for an oversized body",
      );
      assert.equal(activityRows().length, 0);
    });
  }

  test("logActivity accepts a note at the character limit and rejects one past it", async () => {
    const atLimit = textOf(TEXT_MAX, "LIMIT-NOTE");
    const over = textOf(TEXT_MAX + 1, "OVER-NOTE");
    const accepted = await triage.logActivity({ candidateId: CANDIDATE, type: "note", body: atLimit });
    assert.equal(accepted.ok, true);
    assert.equal(activityRows().some((row) => row.body === atLimit), true);

    const since = snapshotWrites();
    const rejected = await triage.logActivity({ candidateId: CANDIDATE, type: "note", body: over });
    assert.equal(rejected.ok, false);
    assert.equal(newWrites(since).some((write) => write.table === "activity"), false);
    assert.equal(activityRows().some((row) => row.body === over), false);
  });

  test("logActivity rejects an oversized author before insert", async () => {
    const author = textOf(AUTHOR_MAX + 1, "OVER-AUTHOR");
    const since = snapshotWrites();
    const result = await triage.logActivity({
      candidateId: CANDIDATE,
      type: "note",
      author,
      body: "short note",
    });
    assert.equal(result.ok, false);
    assert.equal(newWrites(since).some((write) => write.table === "activity"), false);
  });

  test("logActivity still appends several limit-sized notes", async () => {
    for (let i = 0; i < 3; i += 1) {
      const body = textOf(TEXT_MAX, `NOTE-TAIL-${i}`);
      const result = await triage.logActivity({ candidateId: CANDIDATE, type: "note", body });
      assert.equal(result.ok, true, `note ${i} should be stored`);
    }
    assert.equal(activityRows().length, 3);
  });

  test("saveTranscript rejects an oversized paste before writing the working file", async () => {
    const transcript = textOf(OVERSIZE, "OVERSIZE-TRANSCRIPT-TAIL");
    const since = snapshotWrites();
    const result = await triage.saveTranscript({ candidateId: CANDIDATE, transcript });
    assert.equal(result.ok, false);
    assert.equal(
      newWrites(since).some((write) => write.table === "candidate_working_files" && containsText(write.row, transcript)),
      false,
    );
    assert.equal(containsText(workingFile()?.workspace, "OVERSIZE-TRANSCRIPT-TAIL"), false);
  });

  test("saveTranscript accepts a paste at the transcript limit", async () => {
    const transcript = textOf(TRANSCRIPT_MAX, "LIMIT-TRANSCRIPT");
    const result = await triage.saveTranscript({ candidateId: CANDIDATE, transcript });
    assert.equal(result.ok, true);
    const workspace = workingFile()?.workspace as { transcript?: string } | undefined;
    assert.equal(workspace?.transcript, transcript);
  });

  test("saveCorrection rejects an oversized note before writing it", async () => {
    const text = textOf(OVERSIZE, "OVERSIZE-CORRECTION-TAIL");
    const since = snapshotWrites();
    const result = await triage.saveCorrection({ candidateId: CANDIDATE, text });
    assert.equal(result.ok, false);
    assert.equal(
      newWrites(since).some((write) => write.table === "candidate_working_files" && containsText(write.row, "OVERSIZE-CORRECTION-TAIL")),
      false,
    );
  });

  test("saveCorrection accepts a note at the character limit", async () => {
    const text = textOf(TEXT_MAX, "LIMIT-CORRECTION");
    const result = await triage.saveCorrection({ candidateId: CANDIDATE, text });
    assert.equal(result.ok, true);
    const workspace = workingFile()?.workspace as { corrections?: { text: string }[] } | undefined;
    assert.equal(workspace?.corrections?.some((entry) => entry.text === text), true);
  });

  test("saveReply rejects an oversized reply before writing it", async () => {
    const value = textOf(OVERSIZE, "OVERSIZE-REPLY-TAIL");
    const since = snapshotWrites();
    const result = await triage.saveReply({ candidateId: CANDIDATE, key: "flag", value });
    assert.equal(result.ok, false);
    assert.equal(
      newWrites(since).some((write) => containsText(write.row, "OVERSIZE-REPLY-TAIL")),
      false,
    );
  });

  test("saveReply rejects an oversized key before writing it", async () => {
    const key = textOf(AUTHOR_MAX + 1, "OVERSIZE-KEY");
    const since = snapshotWrites();
    const result = await triage.saveReply({ candidateId: CANDIDATE, key, value: "ok" });
    assert.equal(result.ok, false);
    assert.equal(newWrites(since).some((write) => write.table === "candidate_working_files"), false);
  });

  test("sendCandidateChat rejects an oversized message before writing it", async () => {
    const message = textOf(OVERSIZE, "OVERSIZE-CHAT-TAIL");
    const since = snapshotWrites();
    const result = await triage.sendCandidateChat({ candidateId: CANDIDATE, message });
    assert.equal(result.ok, false);
    assert.equal(
      newWrites(since).some((write) => containsText(write.row, "OVERSIZE-CHAT-TAIL")),
      false,
    );
  });

  test("saveTimeline rejects an oversized row before writing it", async () => {
    const since = snapshotWrites();
    const result = await triage.saveTimeline({
      candidateId: CANDIDATE,
      ovr: [
        {
          type: "role",
          period: "2020",
          org: "Example",
          role: "Analyst",
          tenure: "1 yr",
          scope: textOf(OVERSIZE, "OVERSIZE-TIMELINE-TAIL"),
          lang: "",
          signal: "Verify",
        },
      ],
    });
    assert.equal(result.ok, false);
    assert.equal(
      newWrites(since).some((write) => containsText(write.row, "OVERSIZE-TIMELINE-TAIL")),
      false,
    );
  });

  test("addInterviewEvidence rejects an oversized transcript before insert", async () => {
    const transcript = textOf(OVERSIZE, "OVERSIZE-EVIDENCE-TAIL");
    const since = snapshotWrites();
    const result = await interviews.addInterviewEvidence({
      candidateId: CANDIDATE,
      jobShortcode: JOB,
      kind: "interview",
      label: "Onsite",
      transcript,
    });
    assert.equal(result.ok, false);
    assert.equal(newWrites(since).some((write) => write.table === "evidence"), false);
    assert.equal(evidenceRows().length, 0);
  });

  test("addVideoAskAnswers rejects an oversized paste before insert", async () => {
    const answers = textOf(OVERSIZE, "OVERSIZE-VIDEOASK-TAIL");
    const since = snapshotWrites();
    const result = await interviews.addVideoAskAnswers({
      candidateId: CANDIDATE,
      jobShortcode: JOB,
      answers,
    });
    assert.equal(result.ok, false);
    assert.equal(newWrites(since).some((write) => write.table === "evidence"), false);
    assert.equal(evidenceRows().length, 0);
  });

  test("addInterviewEvidence accepts a transcript at the limit", async () => {
    const transcript = textOf(TRANSCRIPT_MAX, "LIMIT-EVIDENCE");
    const result = await interviews.addInterviewEvidence({
      candidateId: CANDIDATE,
      jobShortcode: JOB,
      kind: "phone_screen",
      label: "Phone screen",
      transcript,
    });
    assert.equal(result.ok, true);
    assert.equal(evidenceRows().some((row) => row.transcript === transcript), true);
  });

  async function loadPool(job: string) {
    reads.length = 0;
    captureReads = true;
    try {
      return await load.loadTriagePool(job);
    } finally {
      captureReads = false;
    }
  }

  function fetchedActivityBodyChars(): number {
    let total = 0;
    for (const read of reads) {
      if (read.table !== "activity") continue;
      for (const row of read.rows) {
        if (typeof row.body === "string") total += row.body.length;
      }
    }
    return total;
  }

  function fetchedRowsContain(needle: string): boolean {
    return reads.some((read) => read.rows.some((row) => containsText(row, needle)));
  }

  test("the job pool does not read every stored note and transcript into the list", async () => {
    for (let i = 0; i < 3; i += 1) {
      const body = textOf(TEXT_MAX, `NOTE-TAIL-${i}`);
      assert.equal((await triage.logActivity({ candidateId: CANDIDATE, type: "note", body })).ok, true);
    }
    const transcript = textOf(TRANSCRIPT_MAX, "POOL-TRANSCRIPT-TAIL");
    assert.equal((await triage.saveTranscript({ candidateId: CANDIDATE, transcript })).ok, true);
    const evidence = textOf(TRANSCRIPT_MAX, "POOL-EVIDENCE-TAIL");
    assert.equal(
      (
        await interviews.addInterviewEvidence({
          candidateId: CANDIDATE,
          jobShortcode: JOB,
          kind: "interview",
          label: "Onsite",
          transcript: evidence,
        })
      ).ok,
      true,
    );

    const pool = await loadPool(JOB);
    assert.ok(pool.candidates.some((candidate) => candidate.id === CANDIDATE));
    const payload = JSON.stringify(pool);
    assert.equal(payload.includes("NOTE-TAIL-2"), false);
    assert.equal(payload.includes("POOL-TRANSCRIPT-TAIL"), false);
    assert.equal(payload.includes("POOL-EVIDENCE-TAIL"), false);
    assert.ok(fetchedActivityBodyChars() <= POOL_ACTIVITY_BODY_BUDGET);
    assert.equal(fetchedRowsContain("POOL-TRANSCRIPT-TAIL"), false);
    assert.equal(fetchedRowsContain("POOL-EVIDENCE-TAIL"), false);
  });

  test("the default cross-role board does not read every stored note into the list", async () => {
    for (let i = 0; i < 3; i += 1) {
      const body = textOf(TEXT_MAX, `CROSS-TAIL-${i}`);
      assert.equal((await triage.logActivity({ candidateId: CANDIDATE, type: "note", body })).ok, true);
    }
    const pool = await loadPool(load.CROSS_ROLE_SHORTCODE);
    assert.ok(pool.candidates.some((candidate) => candidate.id === CANDIDATE));
    assert.equal(JSON.stringify(pool).includes("CROSS-TAIL-2"), false);
    assert.ok(fetchedActivityBodyChars() <= POOL_ACTIVITY_BODY_BUDGET);
  });
}
