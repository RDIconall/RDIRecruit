/**
 * Concurrent case-file saves must keep every note, reply, and chat line.
 *
 * The stand-in below speaks the PostgREST HTTP shape used by
 * @supabase/postgrest-js 2.108.1 (the version in package-lock.json):
 * - GET returns the current rows matching the eq/in filters.
 * - POST with Prefer: resolution=merge-duplicates inserts, or on a
 *   candidate_id conflict replaces each column present in the JSON body
 *   (PostgREST v13.0.8 QueryBuilder.hs DO UPDATE SET col = EXCLUDED.col).
 *   Nested JSON is stored as the new column value. It is not deep-merged.
 * - POST without that Prefer header is an insert and returns 23505 when
 *   candidate_id already exists.
 * - PATCH updates only rows that match every filter at the moment the
 *   statement runs, and returns those rows. A version filter that no longer
 *   matches updates nothing.
 *
 * While two saves are armed, their writes are held until both have arrived,
 * then applied in an order that commits the staler workspace last. That is a
 * schedule the unlocked read-modify-write allows: both snapshots are taken
 * before either write, and the earlier snapshot is stored second. A fix that
 * reads the row again and then writes the array from the first read still
 * loses. A conditional write that fails and retries against the committed row
 * keeps both updates.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Module = require("module") as {
  _resolveFilename: (request: string, parent: unknown, isMain: boolean, options: unknown) => string;
};
const clerkStub = fileURLToPath(new URL("../../../tests/support/clerk-server-stub.cjs", import.meta.url));
const serverOnlyStub = fileURLToPath(new URL("../../../tests/support/server-only-stub.cjs", import.meta.url));
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolveFilename(request: string, parent: unknown, isMain: boolean, options: unknown) {
  if (request === "@clerk/nextjs/server") return clerkStub;
  if (request === "server-only") return serverOnlyStub;
  return originalResolve.call(this, request, parent, isMain, options);
};

const NON_FILTER = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

type Row = Record<string, unknown>;

const tables = new Map<string, Row[]>();

interface HeldWrite {
  body: Row | Row[];
  apply: () => Row[];
  finish: (rows: Row[]) => void;
}

const gate = {
  /** Number of overlapping case-file writes to hold. 0 applies each write immediately. */
  expect: 0,
  held: [] as HeldWrite[],
};

function clone<T>(value: T): T {
  return value == null ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function tableRows(name: string): Row[] {
  let rows = tables.get(name);
  if (!rows) {
    rows = [];
    tables.set(name, rows);
  }
  return rows;
}

function filtersOf(url: URL): Array<{ column: string; op: string; value: string }> {
  const filters: Array<{ column: string; op: string; value: string }> = [];
  for (const [column, raw] of url.searchParams) {
    if (NON_FILTER.has(column) || column.endsWith(".order") || column.endsWith(".limit")) continue;
    const dot = raw.indexOf(".");
    if (dot <= 0) continue;
    filters.push({ column, op: raw.slice(0, dot), value: raw.slice(dot + 1) });
  }
  return filters;
}

function matches(row: Row, filters: ReturnType<typeof filtersOf>): boolean {
  return filters.every((filter) => {
    const cell = row[filter.column];
    if (filter.op === "eq") return String(cell) === filter.value;
    if (filter.op === "is") return filter.value === "null" ? cell == null : String(cell) === filter.value;
    if (filter.op === "in") {
      const inner = filter.value.startsWith("(") && filter.value.endsWith(")") ? filter.value.slice(1, -1) : filter.value;
      const parts = inner.length === 0 ? [] : inner.split(",").map((part) => part.replace(/^"|"$/g, ""));
      return parts.includes(String(cell));
    }
    return false;
  });
}

function correctionsCount(body: Row): number {
  const workspace = body.workspace;
  if (!workspace || typeof workspace !== "object") return -1;
  const corrections = (workspace as { corrections?: unknown }).corrections;
  return Array.isArray(corrections) ? corrections.length : -1;
}

function preferHeader(req: IncomingMessage): string {
  const value = req.headers.prefer;
  return (Array.isArray(value) ? value.join(",") : value ?? "").toLowerCase();
}

function isMergeUpsert(req: IncomingMessage): boolean {
  return preferHeader(req).includes("resolution=merge-duplicates");
}

function applyMerge(table: string, body: Row): Row {
  const rows = tableRows(table);
  const key = "candidate_id";
  const id = body[key];
  const index = rows.findIndex((row) => row[key] === id);
  if (index === -1) {
    const created = clone(body);
    rows.push(created);
    return created;
  }
  // Column replace from the request body. Keys absent from the body stay.
  // workspace is one column: the object in the body replaces the stored object.
  const next = { ...rows[index] };
  for (const [column, value] of Object.entries(body)) next[column] = clone(value);
  rows[index] = next;
  return next;
}

function applyInsert(table: string, body: Row): { row: Row | null; conflict: boolean } {
  const rows = tableRows(table);
  if (body.candidate_id != null && rows.some((row) => row.candidate_id === body.candidate_id)) {
    return { row: null, conflict: true };
  }
  const created = clone(body);
  rows.push(created);
  return { row: created, conflict: false };
}

function applyPatch(table: string, body: Row, filters: ReturnType<typeof filtersOf>): Row[] {
  const updated: Row[] = [];
  for (const row of tableRows(table)) {
    if (!matches(row, filters)) continue;
    for (const [column, value] of Object.entries(body)) row[column] = clone(value);
    updated.push(clone(row));
  }
  return updated;
}

function seedCaseFile(candidateId: string): void {
  const rows = tableRows("candidate_working_files");
  const without = rows.filter((row) => row.candidate_id !== candidateId);
  rows.length = 0;
  rows.push(...without, {
    candidate_id: candidateId,
    content: `# ${candidateId}\n`,
    read: null,
    workspace: {
      corrections: [{ ts: "2026-01-01 00:00 UTC", text: "Existing hiring note" }],
      replies: { keep: "already on file" },
      chat: [{ role: "user", content: "Existing chat line", ts: "2026-01-01T00:00:00.000Z" }],
      transcript: "Existing transcript",
    },
    updated_at: "2026-01-01T00:00:00.000Z",
    updated_by: "seed",
  });
}

function releaseHeld(): void {
  const batch = gate.held.splice(0, gate.held.length);
  gate.expect = 0;
  batch.sort((a, b) => {
    const left = Array.isArray(a.body) ? -1 : correctionsCount(a.body);
    const right = Array.isArray(b.body) ? -1 : correctionsCount(b.body);
    return right - left;
  });
  for (const write of batch) write.finish(write.apply());
}

async function holdWrite(body: Row | Row[], apply: () => Row[]): Promise<Row[]> {
  if (gate.expect < 2) return apply();
  return new Promise((finish) => {
    gate.held.push({ body, apply, finish });
    if (gate.held.length >= gate.expect) releaseHeld();
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function handle(req: IncomingMessage, res: ServerResponse, parsed: URL, body: unknown): Promise<void> | void {
  const table = decodeURIComponent(parsed.pathname.replace(/^\/rest\/v1\//, "").split("/")[0] ?? "");
  const method = req.method ?? "GET";
  const filters = filtersOf(parsed);

  if (method === "GET" || method === "HEAD") {
    const rows = tableRows(table).filter((row) => matches(row, filters)).map((row) => clone(row));
    sendJson(res, 200, rows);
    return;
  }

  if (method === "POST") {
    const records = Array.isArray(body) ? (body as Row[]) : [body as Row];
    return holdWrite(records.length === 1 ? records[0] : records, () => {
      if (isMergeUpsert(req)) return records.map((record) => clone(applyMerge(table, record)));
      const inserted: Row[] = [];
      for (const record of records) {
        const result = applyInsert(table, record);
        if (result.conflict) {
          sendJson(res, 409, {
            code: "23505",
            message: "duplicate key value violates unique constraint",
            details: `Key (candidate_id)=(${String(record.candidate_id)}) already exists.`,
            hint: null,
          });
          return [];
        }
        if (result.row) inserted.push(clone(result.row));
      }
      return inserted;
    }).then((rows) => {
      if (res.writableEnded) return;
      if (preferHeader(req).includes("return=representation")) sendJson(res, 201, rows);
      else {
        res.writeHead(201, { "content-type": "application/json" });
        res.end();
      }
    });
  }

  if (method === "PATCH") {
    const patch = (body ?? {}) as Row;
    return holdWrite(patch, () => applyPatch(table, patch, filters)).then((rows) => {
      if (res.writableEnded) return;
      if (preferHeader(req).includes("return=representation")) sendJson(res, 200, rows);
      else {
        res.writeHead(204);
        res.end();
      }
    });
  }

  sendJson(res, 404, { code: "PGRST000", message: `Unhandled ${method} ${parsed.pathname}`, details: null, hint: null });
}

const server = createServer((req, res) => {
  const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
  void readBody(req)
    .then((body) => handle(req, res, parsed, body))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "bad request";
      if (!res.writableEnded) sendJson(res, 400, { message });
    });
});

let actions: typeof import("../../app/actions/triage");
let getWorkingFile: typeof import("./store").getWorkingFile;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_KEY = "test-service-key-placeholder";
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.WORKABLE_TOKEN;
  delete process.env.WORKABLE_API_KEY;
  actions = await import("../../app/actions/triage");
  ({ getWorkingFile } = await import("./store"));
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

function armOverlap(): void {
  gate.expect = 2;
  gate.held = [];
}

async function workspaceOf(candidateId: string): Promise<Record<string, unknown>> {
  const row = await getWorkingFile(candidateId);
  assert.ok(row, `case file for ${candidateId} was not stored`);
  return row.workspace as Record<string, unknown>;
}

function textsOf(workspace: Record<string, unknown>): string[] {
  const corrections = workspace.corrections;
  assert.ok(Array.isArray(corrections), "corrections list missing from the case file");
  return corrections.map((entry) => String((entry as { text?: string }).text ?? ""));
}

describe("concurrent case-file saves", () => {
  it("keeps both hiring notes when two note saves overlap", async () => {
    const candidateId = "cand_two_notes";
    seedCaseFile(candidateId);
    armOverlap();

    await Promise.all([
      actions.saveCorrection({ candidateId, text: "Reviewer note: led the monitoring visit" }),
      actions.saveCorrection({ candidateId, text: "Second signed-in note: ask about the deviation log" }),
    ]);

    const texts = textsOf(await workspaceOf(candidateId));
    assert.ok(texts.includes("Existing hiring note"));
    assert.ok(texts.includes("Reviewer note: led the monitoring visit"));
    assert.ok(texts.includes("Second signed-in note: ask about the deviation log"));
  });

  it("keeps both reply keys when two reply saves overlap", async () => {
    const candidateId = "cand_two_replies";
    seedCaseFile(candidateId);
    armOverlap();

    await Promise.all([
      actions.saveReply({ candidateId, key: "screen", value: "Owned the source-document check" }),
      actions.saveReply({ candidateId, key: "followup", value: "Wants the protocol number confirmed" }),
    ]);

    const workspace = await workspaceOf(candidateId);
    const replies = workspace.replies as Record<string, string>;
    assert.equal(replies.keep, "already on file");
    assert.equal(replies.screen, "Owned the source-document check");
    assert.equal(replies.followup, "Wants the protocol number confirmed");
    assert.ok(textsOf(workspace).includes("Existing hiring note"));
  });

  it("keeps a note saved in the same moment as a reply", async () => {
    const candidateId = "cand_note_and_reply";
    seedCaseFile(candidateId);
    armOverlap();

    await Promise.all([
      actions.saveCorrection({ candidateId, text: "Reviewer note written while a reply was saving" }),
      actions.saveReply({ candidateId, key: "screen", value: "Reply written while a note was saving" }),
    ]);

    const workspace = await workspaceOf(candidateId);
    assert.ok(textsOf(workspace).includes("Existing hiring note"));
    assert.ok(textsOf(workspace).includes("Reviewer note written while a reply was saving"));
    const replies = workspace.replies as Record<string, string>;
    assert.equal(replies.keep, "already on file");
    assert.equal(replies.screen, "Reply written while a note was saving");
  });

  it("keeps both war-room messages when two chat saves overlap", async () => {
    const candidateId = "cand_two_chats";
    seedCaseFile(candidateId);
    armOverlap();

    await Promise.all([
      actions.sendCandidateChat({ candidateId, message: "First overlapping war-room message" }),
      actions.sendCandidateChat({ candidateId, message: "Second overlapping war-room message" }),
    ]);

    const workspace = await workspaceOf(candidateId);
    const contents = (workspace.chat as Array<{ content: string }>).map((message) => message.content);
    assert.ok(contents.includes("Existing chat line"));
    assert.ok(contents.includes("First overlapping war-room message"));
    assert.ok(contents.includes("Second overlapping war-room message"));
    assert.ok(textsOf(workspace).includes("Existing hiring note"));
  });

  it("keeps a note saved in the same moment as a chat message", async () => {
    const candidateId = "cand_note_and_chat";
    seedCaseFile(candidateId);
    armOverlap();

    await Promise.all([
      actions.saveCorrection({ candidateId, text: "Note saved while the war room was writing" }),
      actions.sendCandidateChat({ candidateId, message: "War-room message saved while a note was writing" }),
    ]);

    const workspace = await workspaceOf(candidateId);
    assert.ok(textsOf(workspace).includes("Note saved while the war room was writing"));
    const contents = (workspace.chat as Array<{ content: string }>).map((message) => message.content);
    assert.ok(contents.includes("Existing chat line"));
    assert.ok(contents.includes("War-room message saved while a note was writing"));
  });

  it("keeps a note saved in the same moment as a transcript", async () => {
    const candidateId = "cand_note_and_transcript";
    seedCaseFile(candidateId);
    armOverlap();

    await Promise.all([
      actions.saveCorrection({ candidateId, text: "Note saved while a transcript was writing" }),
      actions.saveTranscript({ candidateId, transcript: "Transcript saved while a note was writing" }),
    ]);

    const workspace = await workspaceOf(candidateId);
    assert.ok(textsOf(workspace).includes("Note saved while a transcript was writing"));
    assert.equal(workspace.transcript, "Transcript saved while a note was writing");
  });

  it("keeps a note saved in the same moment as a timeline replace", async () => {
    const candidateId = "cand_note_and_timeline";
    seedCaseFile(candidateId);
    armOverlap();
    const timeline = [
      { type: "role" as const, period: "2020–2024", org: "Site", role: "Coordinator", tenure: "4 yr", scope: "Visits", lang: "—", signal: "Positive" },
    ];

    await Promise.all([
      actions.saveCorrection({ candidateId, text: "Note saved while the timeline was writing" }),
      actions.saveTimeline({ candidateId, ovr: timeline }),
    ]);

    const workspace = await workspaceOf(candidateId);
    assert.ok(textsOf(workspace).includes("Note saved while the timeline was writing"));
    assert.deepEqual(workspace.ovr, timeline);
  });

  it("keeps a note saved in the same moment as a decision", async () => {
    const candidateId = "cand_note_and_decision";
    seedCaseFile(candidateId);
    armOverlap();

    await Promise.all([
      actions.saveCorrection({ candidateId, text: "Note saved while the decision was writing" }),
      actions.setDecision({ candidateId, decision: "interview" }),
    ]);

    const workspace = await workspaceOf(candidateId);
    assert.ok(textsOf(workspace).includes("Note saved while the decision was writing"));
    assert.equal(workspace.decisionOverride, "interview");
  });

  it("keeps a note saved in the same moment as a process status", async () => {
    const candidateId = "cand_note_and_process";
    seedCaseFile(candidateId);
    armOverlap();

    await Promise.all([
      actions.saveCorrection({ candidateId, text: "Note saved while process status was writing" }),
      actions.setProcessStatus({ candidateId, status: "interviewing" }),
    ]);

    const workspace = await workspaceOf(candidateId);
    assert.ok(textsOf(workspace).includes("Note saved while process status was writing"));
    assert.equal(workspace.processStatus, "interviewing");
  });

  it("keeps a note saved in the same moment as a deep-analysis flag", async () => {
    const candidateId = "cand_note_and_deep";
    seedCaseFile(candidateId);
    armOverlap();

    await Promise.all([
      actions.saveCorrection({ candidateId, text: "Note saved while deep analysis was flagged" }),
      actions.runDeepAnalysis({ candidateId }),
    ]);

    const workspace = await workspaceOf(candidateId);
    assert.ok(textsOf(workspace).includes("Note saved while deep analysis was flagged"));
    assert.equal(workspace.deep, true);
  });

  it("keeps a note saved in the same moment as a re-analysis", async () => {
    const candidateId = "cand_note_and_reanalyze";
    seedCaseFile(candidateId);
    armOverlap();

    await Promise.all([
      actions.saveCorrection({ candidateId, text: "Note saved while re-analysis was writing" }),
      actions.reanalyze({ candidateId }),
    ]);

    const texts = textsOf(await workspaceOf(candidateId));
    assert.ok(texts.includes("Note saved while re-analysis was writing"));
  });

  it("keeps a note saved in the same moment as a rubric comparison", async () => {
    const candidateId = "cand_note_and_rubric";
    seedCaseFile(candidateId);
    armOverlap();

    await Promise.all([
      actions.saveCorrection({ candidateId, text: "Note saved while rubric comparison was writing" }),
      actions.compareToRubric({ candidateId }),
    ]);

    const texts = textsOf(await workspaceOf(candidateId));
    assert.ok(texts.includes("Note saved while rubric comparison was writing"));
  });

  it("keeps a note saved in the same moment as clearing the war room", async () => {
    const candidateId = "cand_note_and_clear_chat";
    seedCaseFile(candidateId);
    armOverlap();

    await Promise.all([
      actions.saveCorrection({ candidateId, text: "Note saved while the war room was cleared" }),
      actions.clearCandidateChat({ candidateId }),
    ]);

    const workspace = await workspaceOf(candidateId);
    assert.ok(textsOf(workspace).includes("Note saved while the war room was cleared"));
    assert.deepEqual(workspace.chat, []);
  });
});
