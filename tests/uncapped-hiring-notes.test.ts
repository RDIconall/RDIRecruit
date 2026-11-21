/**
 * Spec for the uncapped hiring-note denial of service.
 *
 * These tests fail while activity notes, pasted transcripts, and the other
 * reviewer-supplied texts that share that path are stored without a character
 * limit and then loaded for every applicant when the hiring board is built.
 * They pass once oversized text is refused before any write, and once the
 * board loader neither fetches nor returns those full texts.
 *
 * Run: node --import tsx --test tests/uncapped-hiring-notes.test.ts
 *
 * The stand-in database enforces the foreign keys and NOT NULL columns from
 * supabase/migrations/001_initial_schema.sql, 009_working_files.sql, and
 * 011_activity_log.sql. Those migrations declare the text columns with no
 * CHECK and no length limit, and this stand-in does not add one.
 */
import assert from "node:assert/strict";
import Module from "node:module";
import { before, beforeEach, describe, it } from "node:test";

process.env.SUPABASE_URL = "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_KEY = "placeholder-service-key";
process.env.SUPABASE_ANON_KEY = "placeholder-anon-key";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.WORKABLE_TOKEN;
delete process.env.WORKABLE_API_KEY;
delete process.env.VIDEOASK_WEBHOOK_SECRET;
delete process.env.FIREFLIES_API_KEY;

/** A note, correction, reply, or chat message may be this long and no longer. */
const NOTE_MAX = 8_000;
/** Author shown on an activity entry. */
const AUTHOR_MAX = 200;
/** A pasted transcript or interview-evidence body may be this long and no longer. */
const TRANSCRIPT_MAX = 100_000;
/** Each free-text field on a hand-edited timeline row. */
const TIMELINE_FIELD_MAX = 2_000;
/** Rubric / role spec saved onto the board. */
const RUBRIC_MAX = 100_000;

const JOB = "JOB1";
const CANDIDATE_ID = "cand_real";

const session: { userId: string | null } = { userId: "user_new_signup" };

type Row = Record<string, unknown>;

const tables = new Map<string, Row[]>();
const writes: { table: string; row: Row }[] = [];
const reads: { table: string; rows: Row[] }[] = [];
let captureReads = false;

const REQUIRED: Record<string, string[]> = {
  activity: ["candidate_id", "body", "type"],
  evidence: ["candidate_id", "source_type"],
  candidate_working_files: ["candidate_id"],
  events: ["source", "type"],
};

const FOREIGN_KEYS: Record<string, Array<[string, string, string]>> = {
  activity: [["candidate_id", "candidates", "workable_id"]],
  evidence: [["candidate_id", "candidates", "workable_id"]],
  candidate_working_files: [["candidate_id", "candidates", "workable_id"]],
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function tableRows(name: string): Row[] {
  let rows = tables.get(name);
  if (!rows) {
    rows = [];
    tables.set(name, rows);
  }
  return rows;
}

function applyDefaults(table: string, row: Row): Row {
  const next = { ...row };
  if ((table === "activity" || table === "evidence" || table === "events") && next.id == null) {
    next.id = crypto.randomUUID();
  }
  if ((table === "activity" || table === "evidence") && next.created_at == null) {
    next.created_at = new Date().toISOString();
  }
  if (table === "activity" && next.type == null) next.type = "note";
  if (table === "candidate_working_files" && next.workspace == null) next.workspace = {};
  if (table === "events" && next.processed == null) next.processed = false;
  return next;
}

function constraintError(row: Row, table: string): { message: string; code: string } | null {
  for (const column of REQUIRED[table] ?? []) {
    if (row[column] == null || row[column] === "") {
      return { message: `null value in column "${column}" of relation "${table}" violates not-null constraint`, code: "23502" };
    }
  }
  for (const [column, refTable, refColumn] of FOREIGN_KEYS[table] ?? []) {
    const value = row[column];
    if (value == null) continue;
    const ok = tableRows(refTable).some((ref) => ref[refColumn] === value);
    if (!ok) {
      return {
        message: `insert or update on table "${table}" violates foreign key constraint (${column})`,
        code: "23503",
      };
    }
  }
  return null;
}

function matches(row: Row, filters: Array<[string, string, unknown]>): boolean {
  return filters.every(([op, column, value]) => {
    const cell = row[column];
    if (op === "eq") return cell === value;
    if (op === "neq") return cell !== value;
    if (op === "in") return Array.isArray(value) && value.includes(cell);
    if (op === "gte") return cell != null && String(cell) >= String(value);
    if (op === "ilike") return String(cell ?? "").toLowerCase() === String(value ?? "").toLowerCase();
    return false;
  });
}

function project(row: Row, returning: string | null): Row {
  if (!returning || returning.trim() === "*") return clone(row);
  const out: Row = {};
  for (const column of returning.split(",").map((part) => part.trim()).filter(Boolean)) {
    out[column] = row[column];
  }
  return out;
}

function finish(rows: Row[], card: string): { data: Row | Row[] | null; error: { message: string; code: string } | null } {
  if (card === "many") return { data: rows, error: null };
  if (rows.length === 1) return { data: rows[0], error: null };
  if (card === "maybe" && rows.length === 0) return { data: null, error: null };
  return {
    data: null,
    error: { message: rows.length === 0 ? "JSON object requested, multiple (or no) rows returned" : "multiple rows returned", code: "PGRST116" },
  };
}

function commit(table: string, row: Row): { data: null; error: { message: string; code: string } } | null {
  const error = constraintError(row, table);
  if (error) return { data: null, error };
  tableRows(table).push(row);
  writes.push({ table, row: clone(row) });
  return null;
}

function execute(state: {
  table: string;
  filters: Array<[string, string, unknown]>;
  orders: Array<[string, boolean]>;
  range: [number, number] | null;
  limit: number | null;
  op: string;
  payload: Row | Row[] | null;
  onConflict: string | null;
  returning: string | null;
  card: string;
}): { data: Row | Row[] | null; error: { message: string; code: string } | null } {
  if (state.op === "insert" || state.op === "upsert") {
    const incoming = Array.isArray(state.payload) ? state.payload : [state.payload ?? {}];
    const stored: Row[] = [];
    for (const raw of incoming) {
      const row = applyDefaults(state.table, raw);
      if (state.op === "upsert" && state.onConflict) {
        const key = state.onConflict;
        const existing = tableRows(state.table).find((item) => item[key] === row[key]);
        if (existing) {
          const merged = applyDefaults(state.table, { ...existing, ...row });
          const error = constraintError(merged, state.table);
          if (error) return { data: null, error };
          Object.keys(existing).forEach((column) => delete existing[column]);
          Object.assign(existing, merged);
          writes.push({ table: state.table, row: clone(existing) });
          stored.push(existing);
          continue;
        }
      }
      const rejected = commit(state.table, row);
      if (rejected) return rejected;
      stored.push(row);
    }
    const projected = state.returning ? stored.map((row) => project(row, state.returning)) : [];
    if (!state.returning && state.card === "many") return { data: null, error: null };
    return finish(projected, state.card);
  }

  if (state.op === "update") {
    const matched = tableRows(state.table).filter((row) => matches(row, state.filters));
    for (const row of matched) {
      Object.assign(row, state.payload ?? {});
      writes.push({ table: state.table, row: clone(row) });
    }
    const projected = matched.map((row) => project(row, state.returning));
    return finish(projected, state.card);
  }

  let rows = tableRows(state.table).filter((row) => matches(row, state.filters));
  if (state.orders.length) {
    rows = [...rows].sort((a, b) => {
      for (const [column, ascending] of state.orders) {
        const left = a[column] ?? "";
        const right = b[column] ?? "";
        if (left < right) return ascending ? -1 : 1;
        if (left > right) return ascending ? 1 : -1;
      }
      return 0;
    });
  }
  if (state.range) {
    const [from, to] = state.range;
    rows = rows.slice(from, to + 1);
  } else if (state.limit != null) {
    rows = rows.slice(0, state.limit);
  }
  const projected = rows.map((row) => project(row, state.returning ?? "*"));
  if (captureReads) reads.push({ table: state.table, rows: projected });
  return finish(projected, state.card);
}

function query(table: string) {
  const state = {
    table,
    filters: [] as Array<[string, string, unknown]>,
    orders: [] as Array<[string, boolean]>,
    range: null as [number, number] | null,
    limit: null as number | null,
    op: "select",
    payload: null as Row | Row[] | null,
    onConflict: null as string | null,
    returning: null as string | null,
    card: "many",
  };
  const api = {
    select(cols = "*") {
      state.returning = cols;
      return api;
    },
    insert(payload: Row | Row[]) {
      state.op = "insert";
      state.payload = payload;
      return api;
    },
    upsert(payload: Row, opts?: { onConflict?: string }) {
      state.op = "upsert";
      state.payload = payload;
      state.onConflict = opts?.onConflict ?? null;
      return api;
    },
    update(payload: Row) {
      state.op = "update";
      state.payload = payload;
      return api;
    },
    delete() {
      state.op = "delete";
      return api;
    },
    eq(column: string, value: unknown) {
      state.filters.push(["eq", column, value]);
      return api;
    },
    neq(column: string, value: unknown) {
      state.filters.push(["neq", column, value]);
      return api;
    },
    in(column: string, value: unknown[]) {
      state.filters.push(["in", column, value]);
      return api;
    },
    gte(column: string, value: unknown) {
      state.filters.push(["gte", column, value]);
      return api;
    },
    ilike(column: string, value: unknown) {
      state.filters.push(["ilike", column, value]);
      return api;
    },
    order(column: string, opts?: { ascending?: boolean }) {
      state.orders.push([column, !opts || opts.ascending !== false]);
      return api;
    },
    range(from: number, to: number) {
      state.range = [from, to];
      return api;
    },
    limit(count: number) {
      state.limit = count;
      return api;
    },
    maybeSingle() {
      state.card = "maybe";
      return api;
    },
    single() {
      state.card = "single";
      return api;
    },
    then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
      return Promise.resolve(execute(state)).then(onFulfilled, onRejected);
    },
  };
  return api;
}

const client = { from: (table: string) => query(table) };

const clerkServer = {
  auth: async () => ({ userId: session.userId }),
  currentUser: async () =>
    session.userId
      ? {
          id: session.userId,
          firstName: "New",
          lastName: "Signup",
          emailAddresses: [{ emailAddress: "new.signup@example.com" }],
        }
      : null,
  clerkMiddleware: () => () => {},
  createRouteMatcher: () => () => false,
};
const supabaseJs = { createClient: () => client };
const nextCache = { revalidatePath() {}, revalidateTag() {} };

// tsx loads this test as CommonJS, and Node's module mock does not intercept
// those require() calls. Replace the two clients the actions construct and the
// markers that would throw outside a request.
const nodeModule = Module as unknown as { prototype: { require: NodeRequire } };
const originalRequire = nodeModule.prototype.require;
nodeModule.prototype.require = function patchedRequire(this: unknown, id: string, ...rest: unknown[]) {
  if (id === "@clerk/nextjs/server") return clerkServer;
  if (id === "@supabase/supabase-js") return supabaseJs;
  if (id === "server-only") return {};
  if (id === "next/cache") return nextCache;
  return originalRequire.apply(this, [id, ...rest] as unknown as Parameters<NodeRequire>);
} as NodeRequire;

type TriageActions = typeof import("../src/app/actions/triage.ts");
type InterviewActions = typeof import("../src/app/actions/interviews.ts");
type PoolLoader = typeof import("../src/lib/triage/load.ts");
type FirefliesRoute = typeof import("../src/app/api/ingest/fireflies/route.ts");
type VideoAskRoute = typeof import("../src/app/api/hooks/videoask/route.ts");

let triage: TriageActions;
let interviews: InterviewActions;
let pool: PoolLoader;
let firefliesRoute: FirefliesRoute;
let videoaskRoute: VideoAskRoute;
let NextRequest: typeof import("next/server").NextRequest;

before(async () => {
  triage = await import("../src/app/actions/triage.ts");
  interviews = await import("../src/app/actions/interviews.ts");
  pool = await import("../src/lib/triage/load.ts");
  firefliesRoute = await import("../src/app/api/ingest/fireflies/route.ts");
  videoaskRoute = await import("../src/app/api/hooks/videoask/route.ts");
  NextRequest = (await import("next/server")).NextRequest;
});

function resetDb() {
  tables.clear();
  writes.length = 0;
  reads.length = 0;
  captureReads = false;
  session.userId = "user_new_signup";
  const now = new Date().toISOString();
  tableRows("jobs").push({
    shortcode: JOB,
    title: "Clinical Data Manager",
    status: "published",
    department: null,
    location: null,
    raw: null,
  });
  tableRows("candidates").push({
    workable_id: CANDIDATE_ID,
    job_shortcode: JOB,
    name: "Pat Applicant",
    email: "pat.applicant@example.com",
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

function text(length: number, marker: string): string {
  return `${"n".repeat(Math.max(0, length - marker.length))}${marker}`;
}

function writesContain(marker: string): boolean {
  return JSON.stringify(writes).includes(marker);
}

function poolContains(value: unknown, marker: string): boolean {
  return JSON.stringify(value).includes(marker);
}

async function loadBoard() {
  reads.length = 0;
  captureReads = true;
  try {
    const [crossRole, singleJob] = await Promise.all([
      pool.loadTriagePool(pool.CROSS_ROLE_SHORTCODE),
      pool.loadTriagePool(JOB),
    ]);
    return { crossRole, singleJob };
  } finally {
    captureReads = false;
  }
}

beforeEach(() => {
  resetDb();
});

describe("uncapped hiring notes", () => {
  it("refuses an activity note, comment, or interview body over the character limit before writing", async () => {
    for (const type of ["note", "comment", "interview"] as const) {
      writes.length = 0;
      const marker = `OVERSIZE-ACTIVITY-${type}`;
      const body = text(NOTE_MAX + 1, marker);
      const result = await triage.logActivity({ candidateId: CANDIDATE_ID, type, body });
      assert.equal(result.ok, false);
      assert.equal(result.entry, null);
      assert.equal(writesContain(marker), false);
      assert.equal(tableRows("activity").length, 0);
    }
  });

  it("refuses an activity author over the character limit before writing", async () => {
    const marker = "OVERSIZE-AUTHOR";
    const result = await triage.logActivity({
      candidateId: CANDIDATE_ID,
      type: "note",
      author: text(AUTHOR_MAX + 1, marker),
      body: "A normal note",
    });
    assert.equal(result.ok, false);
    assert.equal(writesContain(marker), false);
    assert.equal(tableRows("activity").length, 0);
  });

  it("appends several in-limit notes and still withholds their text from the board payload and the queries that build it", async () => {
    const markers = ["NOTE-ONE-MARKER", "NOTE-TWO-MARKER", "NOTE-THREE-MARKER"];
    for (const marker of markers) {
      const result = await triage.logActivity({
        candidateId: CANDIDATE_ID,
        type: "note",
        body: text(4_000, marker),
      });
      assert.equal(result.ok, true);
      assert.equal(result.entry?.body.includes(marker), true);
    }
    assert.equal(tableRows("activity").length, 3);

    const before = JSON.stringify(await loadBoard()).length;
    const fourth = "NOTE-FOUR-MARKER";
    await triage.logActivity({
      candidateId: CANDIDATE_ID,
      type: "note",
      body: text(4_000, fourth),
    });
    const loaded = await loadBoard();
    const after = JSON.stringify(loaded).length;
    for (const marker of [...markers, fourth]) {
      assert.equal(poolContains(loaded, marker), false, marker);
      assert.equal(poolContains(reads, marker), false, marker);
    }
    assert.ok(after - before < 1_000, `board payload grew by ${after - before} bytes after one more note`);
  });

  it("refuses a pasted transcript over the character limit before writing it", async () => {
    const marker = "OVERSIZE-TRANSCRIPT";
    const result = await triage.saveTranscript({
      candidateId: CANDIDATE_ID,
      transcript: text(TRANSCRIPT_MAX + 1, marker),
    });
    assert.equal(result.ok, false);
    assert.equal(writesContain(marker), false);
  });

  it("keeps an in-limit transcript available when that applicant is opened and off the board", async () => {
    const marker = "TRANSCRIPT-MARKER";
    const transcript = text(20_000, marker);
    const saved = await triage.saveTranscript({ candidateId: CANDIDATE_ID, transcript });
    assert.equal(saved.ok, true);
    assert.equal(writesContain(marker), true);

    const one = await pool.loadOneCandidate(CANDIDATE_ID);
    assert.equal(one?.slice.transcript?.includes(marker), true);

    const loaded = await loadBoard();
    assert.equal(poolContains(loaded, marker), false);
    assert.equal(poolContains(reads, marker), false);
  });

  it("refuses an oversized correction, reply, chat message, and timeline field before writing", async () => {
    const correction = text(NOTE_MAX + 1, "OVERSIZE-CORRECTION");
    const corrected = await triage.saveCorrection({ candidateId: CANDIDATE_ID, text: correction });
    assert.equal(corrected.ok, false);
    assert.equal(writesContain("OVERSIZE-CORRECTION"), false);

    const reply = text(NOTE_MAX + 1, "OVERSIZE-REPLY");
    const replied = await triage.saveReply({ candidateId: CANDIDATE_ID, key: "salary", value: reply });
    assert.equal(replied.ok, false);
    assert.equal(writesContain("OVERSIZE-REPLY"), false);

    const hugeKey = text(NOTE_MAX + 1, "OVERSIZE-REPLY-KEY");
    const keyed = await triage.saveReply({ candidateId: CANDIDATE_ID, key: hugeKey, value: "120k" });
    assert.equal(keyed.ok, false);
    assert.equal(writesContain("OVERSIZE-REPLY-KEY"), false);

    const chat = await triage.sendCandidateChat({
      candidateId: CANDIDATE_ID,
      message: text(NOTE_MAX + 1, "OVERSIZE-CHAT"),
    });
    assert.equal(chat.ok, false);
    assert.equal(writesContain("OVERSIZE-CHAT"), false);
    assert.equal(JSON.stringify(chat.messages).includes("OVERSIZE-CHAT"), false);

    const timeline = await triage.saveTimeline({
      candidateId: CANDIDATE_ID,
      ovr: [
        {
          type: "role",
          period: "2020",
          org: "Acme",
          role: "Analyst",
          tenure: "2y",
          scope: text(TIMELINE_FIELD_MAX + 1, "OVERSIZE-TIMELINE"),
          lang: "—",
          signal: "Positive",
        },
      ],
    });
    assert.equal(timeline.ok, false);
    assert.equal(writesContain("OVERSIZE-TIMELINE"), false);
  });

  it("keeps in-limit corrections, replies, chat, and timeline text off the board", async () => {
    const correction = text(4_000, "CORRECTION-MARKER");
    const reply = text(4_000, "REPLY-MARKER");
    const message = text(4_000, "CHAT-MARKER");
    const scope = text(1_000, "TIMELINE-MARKER");
    assert.equal((await triage.saveCorrection({ candidateId: CANDIDATE_ID, text: correction })).ok, true);
    assert.equal((await triage.saveReply({ candidateId: CANDIDATE_ID, key: "salary", value: reply })).ok, true);
    const chat = await triage.sendCandidateChat({ candidateId: CANDIDATE_ID, message });
    assert.equal(chat.messages.some((entry) => entry.content.includes("CHAT-MARKER")), true);
    assert.equal(
      (
        await triage.saveTimeline({
          candidateId: CANDIDATE_ID,
          ovr: [
            {
              type: "role",
              period: "2020",
              org: "Acme",
              role: "Analyst",
              tenure: "2y",
              scope,
              lang: "—",
              signal: "Positive",
            },
          ],
        })
      ).ok,
      true,
    );

    const loaded = await loadBoard();
    for (const marker of ["CORRECTION-MARKER", "REPLY-MARKER", "CHAT-MARKER", "TIMELINE-MARKER"]) {
      assert.equal(poolContains(loaded, marker), false, marker);
      assert.equal(poolContains(reads, marker), false, marker);
    }
  });

  it("refuses oversized interview evidence and VideoAsk answers before writing", async () => {
    const interview = await interviews.addInterviewEvidence({
      candidateId: CANDIDATE_ID,
      jobShortcode: JOB,
      kind: "interview",
      label: "Onsite",
      transcript: text(TRANSCRIPT_MAX + 1, "OVERSIZE-EVIDENCE"),
    });
    assert.equal(interview.ok, false);
    assert.equal(writesContain("OVERSIZE-EVIDENCE"), false);

    const video = await interviews.addVideoAskAnswers({
      candidateId: CANDIDATE_ID,
      jobShortcode: JOB,
      answers: text(TRANSCRIPT_MAX + 1, "OVERSIZE-VIDEOASK-ACTION"),
    });
    assert.equal(video.ok, false);
    assert.equal(writesContain("OVERSIZE-VIDEOASK-ACTION"), false);
    assert.equal(tableRows("evidence").length, 0);
  });

  it("keeps an in-limit interview transcript off the board", async () => {
    const marker = "EVIDENCE-MARKER";
    const saved = await interviews.addInterviewEvidence({
      candidateId: CANDIDATE_ID,
      jobShortcode: JOB,
      kind: "phone_screen",
      label: "Phone screen",
      transcript: text(20_000, marker),
    });
    assert.equal(saved.ok, true);
    assert.equal(tableRows("evidence").some((row) => String(row.transcript).includes(marker)), true);

    const loaded = await loadBoard();
    assert.equal(poolContains(loaded, marker), false);
    assert.equal(poolContains(reads, marker), false);
  });

  it("refuses an oversized rubric or role spec before writing", async () => {
    const marker = "OVERSIZE-RUBRIC";
    const saved = await triage.saveJobRubric({ jobShortcode: JOB, rubricMd: text(RUBRIC_MAX + 1, marker) });
    assert.equal(saved.ok, false);
    assert.equal(writesContain(marker), false);
  });

  it("does not write an activity note for a signed-out caller or for an unknown applicant", async () => {
    session.userId = null;
    await assert.rejects(() => triage.logActivity({ candidateId: CANDIDATE_ID, type: "note", body: "hello" }));
    assert.equal(tableRows("activity").length, 0);

    session.userId = "user_new_signup";
    const missing = await triage.logActivity({
      candidateId: "cand_does_not_exist",
      type: "note",
      body: "hello",
    });
    assert.equal(missing.ok, false);
    assert.equal(tableRows("activity").length, 0);
    assert.equal(writesContain("hello"), false);
  });

  it("refuses an oversized transcript posted to the public Fireflies ingest before any write", async () => {
    const marker = "OVERSIZE-FIREFLIES";
    const request = new NextRequest("http://localhost/api/ingest/fireflies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        candidate_id: CANDIDATE_ID,
        text: text(TRANSCRIPT_MAX + 1, marker),
      }),
    });
    const response = await firefliesRoute.POST(request);
    assert.ok(response.status >= 400);
    assert.equal(writesContain(marker), false);
    assert.equal(tableRows("evidence").length, 0);
  });

  it("refuses an oversized VideoAsk transcript before any write when the webhook secret is unset", async () => {
    const marker = "OVERSIZE-VIDEOASK-HOOK";
    const request = new NextRequest("http://localhost/api/hooks/videoask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        metadata: { workable_id: CANDIDATE_ID },
        contact: { email: "pat.applicant@example.com" },
        transcript: text(TRANSCRIPT_MAX + 1, marker),
      }),
    });
    const response = await videoaskRoute.POST(request);
    assert.ok(response.status >= 400);
    assert.equal(writesContain(marker), false);
    assert.equal(tableRows("evidence").length, 0);
  });
});
