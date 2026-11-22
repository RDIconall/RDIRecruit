/**
 * Spec for the uncapped cut-reason denial of service.
 *
 * These tests fail while a signed-in caller can store an oversized disqualify
 * or withdraw reason and a later inbox load copies that full text into the
 * page payload. They pass once both of these are true:
 *
 * - setDisqualified, denyCandidate, and withdrawCandidate reject a reason
 *   longer than MAX_CUT_REASON_CHARS (500) and do not write the overlay.
 * - The inbox board query does not select candidate_overlay.status_reason, and
 *   the pool object handed to the page does not contain that full text.
 *
 * A reason of at most 500 characters is still stored, and a cut applicant is
 * still marked cut. Run with:
 *
 *   node --conditions=react-server --experimental-test-module-mocks \
 *     --import tsx --test --test-concurrency=1 tests/uncapped-cut-reason.test.ts
 *
 * The stand-in HTTP server speaks the PostgREST requests this repo's
 * @supabase/postgrest-js client actually sends (select, eq/neq/gte/in, order,
 * offset/limit, upsert). It projects columns the way a `select` list does:
 * `*` returns every stored column, and a column list returns only those
 * columns. Postgres `status_reason text` has no length check in the migration,
 * so the stand-in stores the JSON string it is given.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { after, before, mock, test } from "node:test";
import { once } from "node:events";

const require = createRequire(path.join(process.cwd(), "package.json"));

const MAX_CUT_REASON_CHARS = 500;

const clerkServer = {
  auth: async () => ({ userId: "user_attacker" }),
  currentUser: async () => ({
    id: "user_attacker",
    firstName: "Ada",
    lastName: "Example",
    emailAddresses: [{ emailAddress: "ada@example.com" }],
  }),
};
const nextCache = {
  revalidatePath: () => {},
  revalidateTag: () => {},
};
// tsx compiles the app to CommonJS require(), which loads these resolved files.
// revalidatePath only tags a route after the write; it does not read the reason.
mock.module(require.resolve("@clerk/nextjs/server"), { namedExports: clerkServer });
mock.module(require.resolve("next/cache"), { namedExports: nextCache });

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("workable.com")) {
    return new Response("", { status: 404, statusText: "Not Found" });
  }
  return originalFetch(input, init);
};

type Row = Record<string, unknown>;

interface LoggedRequest {
  method: string;
  table: string;
  select: string | null;
  body: unknown;
}

const tables = new Map<string, Row[]>();
const requestLog: LoggedRequest[] = [];

const RESERVED = new Set([
  "select",
  "order",
  "offset",
  "limit",
  "columns",
  "on_conflict",
  "apikey",
]);

function tableRows(name: string): Row[] {
  const rows = tables.get(name);
  if (rows) return rows;
  const created: Row[] = [];
  tables.set(name, created);
  return created;
}

function primaryKey(table: string, row: Row): { column: string; value: unknown } | null {
  const column: Record<string, string> = {
    candidate_overlay: "candidate_id",
    candidate_working_files: "candidate_id",
    candidates: "workable_id",
    jobs: "shortcode",
    job_rubrics: "job_shortcode",
  };
  const col = column[table];
  if (col && row[col] != null) return { column: col, value: row[col] };
  if (row.id != null) return { column: "id", value: row.id };
  return null;
}

function upsert(table: string, body: unknown): Row[] {
  const incoming = Array.isArray(body) ? body : [body];
  const stored: Row[] = [];
  const list = tableRows(table);
  for (const item of incoming) {
    if (!item || typeof item !== "object") continue;
    const row = item as Row;
    const key = primaryKey(table, row);
    if (!key) {
      list.push({ ...row });
      stored.push(list[list.length - 1]!);
      continue;
    }
    const idx = list.findIndex((existing) => String(existing[key.column]) === String(key.value));
    if (idx >= 0) list[idx] = { ...list[idx], ...row };
    else list.push({ ...row });
    stored.push(list[idx >= 0 ? idx : list.length - 1]!);
  }
  return stored;
}

function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i += 1) {
    const ch = list[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      out.push(list.slice(start, i));
      start = i + 1;
    }
  }
  out.push(list.slice(start));
  return out.map((part) => part.trim()).filter(Boolean);
}

function project(row: Row, select: string | null): Row {
  if (!select || select === "*") return { ...row };
  const cols = splitTopLevel(select);
  if (cols.length === 0 || cols.includes("*")) return { ...row };
  const out: Row = {};
  for (const col of cols) {
    if (col.includes("(") || col.includes(":")) continue;
    if (col in row) out[col] = row[col];
  }
  return out;
}

function selectsFullReason(select: string | null): boolean {
  if (!select || select.trim() === "" || select.trim() === "*") return true;
  return splitTopLevel(select).some((col) => col === "*" || /\bstatus_reason\b/.test(col));
}

function parseInList(value: string): string[] {
  const inner = value.startsWith("(") && value.endsWith(")") ? value.slice(1, -1) : value;
  if (!inner) return [];
  return inner.split(",").map((part) => part.trim().replace(/^"|"$/g, ""));
}

function matches(row: Row, column: string, raw: string): boolean {
  const op = raw.match(/^(eq|neq|gt|gte|lt|lte|in|is)\.(.*)$/);
  if (!op) return true;
  const [, operator, value] = op;
  const cell = row[column];
  if (operator === "in") return parseInList(value!).includes(String(cell));
  if (operator === "is") {
    if (value === "null") return cell == null;
    return String(cell) === value;
  }
  if (cell == null) return false;
  const text = String(cell);
  if (operator === "eq") return text === value;
  if (operator === "neq") return text !== value;
  if (operator === "gt") return text > value!;
  if (operator === "gte") return text >= value!;
  if (operator === "lt") return text < value!;
  if (operator === "lte") return text <= value!;
  return true;
}

function applyQuery(rows: Row[], url: URL): Row[] {
  let next = rows.filter((row) => {
    for (const [column, raw] of url.searchParams.entries()) {
      if (RESERVED.has(column)) continue;
      if (!matches(row, column, raw)) return false;
    }
    return true;
  });

  const order = url.searchParams.get("order");
  if (order) {
    const keys = order.split(",").map((part) => {
      const parsed = part.trim().match(/^(.*)\.(asc|desc)(?:\.nullsfirst|\.nullslast)?$/);
      return {
        column: parsed?.[1] ?? part,
        dir: parsed?.[2] === "desc" ? -1 : 1,
      };
    });
    next = [...next].sort((a, b) => {
      for (const key of keys) {
        const av = String(a[key.column] ?? "");
        const bv = String(b[key.column] ?? "");
        if (av === bv) continue;
        return av < bv ? -key.dir : key.dir;
      }
      return 0;
    });
  }

  const offset = Number(url.searchParams.get("offset") ?? "0");
  const limitRaw = url.searchParams.get("limit");
  const start = Number.isFinite(offset) ? offset : 0;
  if (limitRaw == null) return next.slice(start);
  const limit = Number(limitRaw);
  return next.slice(start, start + (Number.isFinite(limit) ? limit : 0));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "rest" || parts[1] !== "v1" || !parts[2]) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    const table = decodeURIComponent(parts[2]);
    const method = (req.method ?? "GET").toUpperCase();
    const select = url.searchParams.get("select");
    const text = method === "GET" || method === "HEAD" ? "" : await readBody(req);
    const body = text ? (JSON.parse(text) as unknown) : null;
    requestLog.push({ method, table, select, body });

    if (method === "POST" || method === "PATCH") {
      const stored = upsert(table, body);
      const prefer = req.headers.prefer ?? "";
      const wantsRow = prefer.includes("return=representation");
      res.writeHead(201, { "content-type": "application/json" });
      res.end(wantsRow ? JSON.stringify(stored.map((row) => project(row, select))) : "");
      return;
    }

    const projected = applyQuery(tableRows(table), url).map((row) => project(row, select));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(projected));
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }));
  }
});

let setDisqualified: (input: { candidateId: string; disqualified: boolean; reason?: string }) => Promise<{ ok: boolean }>;
let denyCandidate: (input: { jobShortcode: string; candidateId: string; reason?: string }) => Promise<{ ok: boolean }>;
let withdrawCandidate: (input: { jobShortcode: string; candidateId: string; reason?: string }) => Promise<{ ok: boolean }>;
let loadTriagePool: (jobShortcode: string) => Promise<{ candidates: Array<{ id: string; decision: string; cutReason?: string }> }>;

before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test database failed to listen");

  process.env.SUPABASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.SUPABASE_SERVICE_KEY = "test-service-key-placeholder";
  process.env.WORKABLE_TOKEN = "test-workable-token-placeholder";
  delete process.env.WORKABLE_MEMBER_ID;
  delete process.env.WORKABLE_API_KEY;

  const triage = await import("../src/app/actions/triage.ts");
  const candidates = await import("../src/app/actions/candidates.ts");
  const load = await import("../src/lib/triage/load.ts");
  const triageExports = triage.default ?? triage;
  const candidateExports = candidates.default ?? candidates;
  const loadExports = load.default ?? load;
  setDisqualified = triageExports.setDisqualified;
  denyCandidate = candidateExports.denyCandidate;
  withdrawCandidate = candidateExports.withdrawCandidate;
  loadTriagePool = loadExports.loadTriagePool;
});

after(() => {
  server.close();
});

function resetStore() {
  tables.clear();
  requestLog.length = 0;
}

function overlayWritesSince(mark: number): Row[] {
  return requestLog
    .slice(mark)
    .filter((entry) => entry.method === "POST" && entry.table === "candidate_overlay")
    .flatMap((entry) => {
      const body = entry.body;
      return Array.isArray(body) ? (body as Row[]) : body && typeof body === "object" ? [body as Row] : [];
    });
}

function overlayRow(candidateId: string): Row | undefined {
  return tableRows("candidate_overlay").find((row) => row.candidate_id === candidateId);
}

async function invoke<T>(run: () => Promise<T>): Promise<{ result: T | null; error: Error | null }> {
  try {
    return { result: await run(), error: null };
  } catch (error) {
    return { result: null, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

function assertRejectedWithoutWrite(candidateId: string, attack: string, mark: number, outcome: { result: { ok?: boolean } | null }) {
  const writes = overlayWritesSince(mark);
  const leaked = writes.filter((row) => {
    const reason = row.status_reason;
    return (
      typeof reason === "string" &&
      reason.length > 0 &&
      (reason.length > MAX_CUT_REASON_CHARS || attack.startsWith(reason))
    );
  });
  assert.equal(
    leaked.length,
    0,
    `overlay write accepted an oversized reason: ${leaked.map((row) => String(row.status_reason).length).join(",")}`,
  );
  const stored = overlayRow(candidateId);
  assert.ok(
    stored == null || stored.status === "active" || stored.status_reason == null,
    "oversized reason must not leave the applicant disqualified or withdrawn",
  );
  if (stored && typeof stored.status_reason === "string") {
    assert.ok(stored.status_reason.length <= MAX_CUT_REASON_CHARS);
    assert.equal(attack.startsWith(stored.status_reason), false);
  }
  if (outcome.result && "ok" in outcome.result) assert.notEqual(outcome.result.ok, true);
}

function assertShortReasonStored(candidateId: string, reason: string, status: string, error: Error | null) {
  if (error) assert.match(error.message, /static generation store missing/);
  const stored = overlayRow(candidateId);
  assert.ok(stored, "a reason within the cap must still be stored");
  assert.equal(stored.status, status);
  assert.equal(stored.status_reason, reason);
}

const shortReason = "R".repeat(MAX_CUT_REASON_CHARS);
const overReason = "R".repeat(MAX_CUT_REASON_CHARS + 1);
const largeReason = `ATTACK-${"Q".repeat(100_000)}`;

test("setDisqualified stores a reason at the 500 character cap", async () => {
  resetStore();
  const outcome = await invoke(() =>
    setDisqualified({ candidateId: "short-dq", disqualified: true, reason: shortReason }),
  );
  assertShortReasonStored("short-dq", shortReason, "disqualified", outcome.error);
});

test("setDisqualified rejects a reason one character over the cap before writing", async () => {
  resetStore();
  const mark = requestLog.length;
  const outcome = await invoke(() =>
    setDisqualified({ candidateId: "long-dq", disqualified: true, reason: overReason }),
  );
  assertRejectedWithoutWrite("long-dq", overReason, mark, outcome);
});

test("setDisqualified rejects a reason whose trimmed length exceeds the cap", async () => {
  resetStore();
  const padded = `  ${overReason}  `;
  const mark = requestLog.length;
  const outcome = await invoke(() =>
    setDisqualified({ candidateId: "padded-dq", disqualified: true, reason: padded }),
  );
  assertRejectedWithoutWrite("padded-dq", overReason, mark, outcome);
});

test("setDisqualified rejects a 100000 character reason before writing", async () => {
  resetStore();
  const mark = requestLog.length;
  const outcome = await invoke(() =>
    setDisqualified({ candidateId: "huge-dq", disqualified: true, reason: largeReason }),
  );
  assertRejectedWithoutWrite("huge-dq", largeReason, mark, outcome);
});

test("denyCandidate stores a reason at the 500 character cap", async () => {
  resetStore();
  const outcome = await invoke(() =>
    denyCandidate({ jobShortcode: "JOB1", candidateId: "short-deny", reason: shortReason }),
  );
  assertShortReasonStored("short-deny", shortReason, "disqualified", outcome.error);
});

test("denyCandidate rejects a reason one character over the cap before writing", async () => {
  resetStore();
  const mark = requestLog.length;
  const outcome = await invoke(() =>
    denyCandidate({ jobShortcode: "JOB1", candidateId: "long-deny", reason: overReason }),
  );
  assertRejectedWithoutWrite("long-deny", overReason, mark, outcome);
});

test("denyCandidate rejects a 100000 character reason before writing", async () => {
  resetStore();
  const mark = requestLog.length;
  const outcome = await invoke(() =>
    denyCandidate({ jobShortcode: "JOB1", candidateId: "huge-deny", reason: largeReason }),
  );
  assertRejectedWithoutWrite("huge-deny", largeReason, mark, outcome);
});

test("withdrawCandidate stores a reason at the 500 character cap", async () => {
  resetStore();
  const outcome = await invoke(() =>
    withdrawCandidate({ jobShortcode: "JOB1", candidateId: "short-wd", reason: shortReason }),
  );
  assertShortReasonStored("short-wd", shortReason, "withdrawn", outcome.error);
});

test("withdrawCandidate rejects a reason one character over the cap before writing", async () => {
  resetStore();
  const mark = requestLog.length;
  const outcome = await invoke(() =>
    withdrawCandidate({ jobShortcode: "JOB1", candidateId: "long-wd", reason: overReason }),
  );
  assertRejectedWithoutWrite("long-wd", overReason, mark, outcome);
});

test("withdrawCandidate rejects a 100000 character reason before writing", async () => {
  resetStore();
  const mark = requestLog.length;
  const outcome = await invoke(() =>
    withdrawCandidate({ jobShortcode: "JOB1", candidateId: "huge-wd", reason: largeReason }),
  );
  assertRejectedWithoutWrite("huge-wd", largeReason, mark, outcome);
});

function seedInbox() {
  resetStore();
  const now = new Date().toISOString();
  tableRows("jobs").push({
    shortcode: "JOB1",
    title: "Clinical Data Manager",
    status: "published",
    department: "Clinical",
    location: "Van Nuys, CA",
    raw: null,
  });
  const people = [
    { id: "c-dq", status: "disqualified", reason: `CUTREASON-DQ-${"A".repeat(8_000)}` },
    { id: "c-wd", status: "withdrawn", reason: `CUTREASON-WD-${"B".repeat(8_000)}` },
    { id: "c-ok", status: "active", reason: null },
  ];
  for (const person of people) {
    tableRows("candidates").push({
      workable_id: person.id,
      job_shortcode: "JOB1",
      name: person.id,
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
    if (person.reason) {
      tableRows("candidate_overlay").push({
        candidate_id: person.id,
        status: person.status,
        status_reason: person.reason,
        complement: null,
        complement_removes: null,
        salary_vector: null,
        updated_by: "user_attacker",
        updated_at: now,
      });
    }
  }
  return people.filter((person) => person.reason).map((person) => person.reason!);
}

function assertInboxOmitsReasons(pool: { candidates: Array<{ id: string; decision: string; cutReason?: string }> }, markers: string[]) {
  const byId = new Map(pool.candidates.map((candidate) => [candidate.id, candidate]));
  assert.equal(byId.get("c-dq")?.decision, "reject");
  assert.equal(byId.get("c-wd")?.decision, "reject");
  assert.ok(byId.has("c-ok"));
  const payload = JSON.stringify(pool);
  for (const marker of markers) {
    assert.equal(payload.includes(marker), false, "inbox payload contains the full cut reason");
  }
  for (const candidate of pool.candidates) {
    assert.ok((candidate.cutReason?.length ?? 0) <= MAX_CUT_REASON_CHARS);
  }
  const overlayReads = requestLog.filter((entry) => entry.method === "GET" && entry.table === "candidate_overlay");
  assert.ok(overlayReads.length > 0, "inbox load did not read overlays");
  for (const entry of overlayReads) {
    assert.equal(
      selectsFullReason(entry.select),
      false,
      `board query selected the full cut reason (${entry.select})`,
    );
  }
}

test("single-job inbox omits full cut reasons from the page payload", async () => {
  const markers = seedInbox();
  const pool = await loadTriagePool("JOB1");
  assertInboxOmitsReasons(pool, markers);
});

test("cross-role inbox omits full cut reasons from the page payload", async () => {
  const markers = seedInbox();
  const pool = await loadTriagePool("all");
  assertInboxOmitsReasons(pool, markers);
});
