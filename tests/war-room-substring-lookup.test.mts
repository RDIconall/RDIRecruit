/**
 * War-room get_candidate_materials must resolve another applicant only by exact
 * id or exact full name (trim + case-fold). These tests drive sendCandidateChat
 * on the real loaders, the real roster order, the real dossier render, and the
 * shipped Anthropic SDK's JSON parse. They fail while a non-exact query can
 * still return a different applicant's file.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mock, test } from "node:test";

const require = createRequire(import.meta.url);

process.env.NEXT_RUNTIME = "";
process.env.SUPABASE_URL = "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_KEY = "placeholder-service-key";
process.env.ANTHROPIC_API_KEY = "placeholder-anthropic-key";

mock.module("server-only", { namedExports: {} });

mock.module("next/cache", {
  namedExports: {
    revalidatePath: () => {},
    revalidateTag: () => {},
    unstable_cache: (fn: unknown) => fn,
    unstable_noStore: () => {},
    updateTag: () => {},
    refresh: () => {},
    cacheLife: () => {},
    cacheTag: () => {},
  },
});

// tsx loads this server action as CommonJS, so the mock has to replace the
// resolved CJS entry. The package specifier alone stays the real Clerk module.
mock.module(require.resolve("@clerk/nextjs/server"), {
  namedExports: {
    auth: async () => ({ userId: "user_reviewer" }),
    currentUser: async () => ({
      id: "user_reviewer",
      firstName: "Reviewer",
      lastName: "One",
      emailAddresses: [{ emailAddress: "reviewer@example.com" }],
    }),
  },
});

const JOB = "JOB1";
const FOCUS_ID = "cand_focus";

type Row = Record<string, unknown>;

const tables = new Map<string, Row[]>();

function resetTables(): void {
  tables.clear();
}

function add(table: string, row: Row): void {
  const rows = tables.get(table) ?? [];
  rows.push(row);
  tables.set(table, rows);
}

const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

function splitInList(inner: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (ch === "," && !quoted) {
      values.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.length) values.push(current);
  return values;
}

function compareValue(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/**
 * Applies the PostgREST filters supabase-js 2.49 encodes on the query string
 * (`eq.`, `in.()`, `gte.`, `order`, `offset`/`limit`). Rows the product did
 * not ask for are not returned.
 */
function applyQuery(rows: Row[], url: URL): Row[] {
  let out = rows.slice();
  for (const [key, value] of url.searchParams) {
    if (RESERVED.has(key)) continue;
    if (value.startsWith("eq.")) {
      const expected = value.slice(3);
      out = out.filter((row) => String(row[key] ?? "") === expected);
    } else if (value.startsWith("neq.")) {
      const expected = value.slice(4);
      out = out.filter((row) => String(row[key] ?? "") !== expected);
    } else if (value.startsWith("in.(") && value.endsWith(")")) {
      const allowed = new Set(splitInList(value.slice(4, -1)));
      out = out.filter((row) => allowed.has(String(row[key] ?? "")));
    } else if (value.startsWith("gte.")) {
      const expected = value.slice(4);
      out = out.filter((row) => String(row[key] ?? "") >= expected);
    } else if (value.startsWith("gt.")) {
      const expected = value.slice(3);
      out = out.filter((row) => String(row[key] ?? "") > expected);
    } else if (value.startsWith("lte.")) {
      const expected = value.slice(4);
      out = out.filter((row) => String(row[key] ?? "") <= expected);
    } else if (value.startsWith("lt.")) {
      const expected = value.slice(3);
      out = out.filter((row) => String(row[key] ?? "") < expected);
    } else if (value === "is.null") {
      out = out.filter((row) => row[key] == null);
    } else {
      throw new Error(`Unhandled PostgREST filter ${key}=${value} on ${url.pathname}`);
    }
  }

  const order = url.searchParams.get("order");
  if (order) {
    const parts = order.split(",").map((part) => {
      const [column, direction] = part.split(".");
      return { column, direction };
    });
    out.sort((a, b) => {
      for (const part of parts) {
        const cmp = compareValue(a[part.column], b[part.column]);
        if (cmp === 0) continue;
        return part.direction === "desc" ? -cmp : cmp;
      }
      return 0;
    });
  }

  const offset = Number(url.searchParams.get("offset") ?? "0");
  const limit = url.searchParams.get("limit");
  if (Number.isFinite(offset) && offset > 0) out = out.slice(offset);
  if (limit != null) out = out.slice(0, Number(limit));
  return out;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
  const body = init?.body ?? (typeof input !== "string" && !(input instanceof URL) ? input.body : undefined);
  if (body == null) return "";
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return await new Response(body as BodyInit).text();
}

function handlePostgrest(url: URL, method: string, rawBody: string): Response {
  const table = url.pathname.split("/").filter(Boolean).at(-1);
  if (!table) return jsonResponse({ message: "missing table" }, 404);
  const rows = tables.get(table) ?? [];

  if (method === "GET" || method === "HEAD") {
    return jsonResponse(applyQuery(rows, url));
  }

  if (method === "POST") {
    const parsed = rawBody ? (JSON.parse(rawBody) as Row | Row[]) : {};
    const incoming = Array.isArray(parsed) ? parsed : [parsed];
    const onConflict = url.searchParams.get("on_conflict");
    const stored = tables.get(table) ?? [];
    const written: Row[] = [];
    for (const row of incoming) {
      if (onConflict) {
        const index = stored.findIndex((existing) => existing[onConflict] === row[onConflict]);
        if (index >= 0) stored[index] = { ...stored[index], ...row };
        else stored.push({ ...row });
        written.push(stored[index >= 0 ? index : stored.length - 1]);
      } else {
        stored.push({ ...row });
        written.push(stored[stored.length - 1]);
      }
    }
    tables.set(table, stored);
    return jsonResponse(written);
  }

  throw new Error(`Unhandled PostgREST ${method} ${url.pathname}`);
}

interface ToolExchange {
  toolOffered: boolean;
  toolResult: string | null;
}

let scriptedToolQuery = "";
let lastExchange: ToolExchange = { toolOffered: false, toolResult: null };

function toolResultFromMessages(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if ((block as { type?: string }).type === "tool_result") {
        const text = (block as { content?: unknown }).content;
        return typeof text === "string" ? text : JSON.stringify(text);
      }
    }
  }
  return null;
}

function handleAnthropic(rawBody: string): Response {
  const body = rawBody ? (JSON.parse(rawBody) as { tools?: { name?: string }[]; messages?: unknown }) : {};
  const offered = (body.tools ?? []).some((tool) => tool.name === "get_candidate_materials");
  const prior = toolResultFromMessages(body.messages);
  lastExchange = { toolOffered: offered, toolResult: prior };
  if (prior != null) {
    return jsonResponse({
      id: "msg_final",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "text", text: prior }],
    });
  }
  return jsonResponse({
    id: "msg_tool",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    content: [
      {
        type: "tool_use",
        id: "toolu_test",
        name: "get_candidate_materials",
        input: { candidate: scriptedToolQuery },
      },
    ],
  });
}

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(requestUrl(input));
  const method = (init?.method ?? (typeof input !== "string" && !(input instanceof URL) ? input.method : "GET")).toUpperCase();
  if (url.hostname === "api.anthropic.com") {
    return handleAnthropic(await readBody(input, init));
  }
  if (url.protocol === "http:" && url.hostname === "127.0.0.1" && url.pathname.includes("/rest/v1/")) {
    return handlePostgrest(url, method, await readBody(input, init));
  }
  throw new Error(`Unexpected network request ${method} ${url.origin}${url.pathname}`);
};

function candidate(id: string, name: string, createdAt: string): void {
  add("candidates", {
    workable_id: id,
    job_shortcode: JOB,
    name,
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
    created_at: createdAt,
    synced_at: createdAt,
  });
}

function dossier(id: string, marker: string): void {
  add("applications", {
    candidate_id: id,
    answers: { "Why this role?": `${marker}_ANSWER owned the deviation log.` },
    cover_letter: `${marker}_COVER letter about the monitoring plan.`,
    parsed_experience: [],
    resume_text: `${marker}_RESUME extracted résumé text.`,
    resume_url: null,
  });
  add("evidence", {
    id: `ev_${id}`,
    candidate_id: id,
    source_type: "fireflies",
    label: "Hiring screen",
    transcript: `${marker}_TRANSCRIPT speaker described the CAPA they owned.`,
    captured_at: "2026-05-01T00:00:00.000Z",
    created_at: "2026-05-01T00:00:00.000Z",
  });
  add("activity", {
    id: `act_${id}`,
    candidate_id: id,
    type: "interview",
    author: "Lara",
    body: `${marker}_ACTIVITY Interviewer: walk me through the last audit.`,
    created_at: "2026-05-02T00:00:00.000Z",
  });
  add("candidate_working_files", {
    candidate_id: id,
    content: null,
    read: null,
    workspace: { transcript: `${marker}_PASTED pasted interview notes.` },
    updated_at: "2026-05-02T00:00:00.000Z",
    updated_by: null,
  });
}

function seed(people: Array<{ id: string; name: string; createdAt: string; marker: string }>): void {
  resetTables();
  candidate(FOCUS_ID, "Morgan Hale", "2026-06-01T00:00:00.000Z");
  dossier(FOCUS_ID, "FOCUS");
  for (const person of people) {
    candidate(person.id, person.name, person.createdAt);
    dossier(person.id, person.marker);
  }
}

function workspaceOf(id: string): Row | null {
  return (tables.get("candidate_working_files") ?? []).find((row) => row.candidate_id === id) ?? null;
}

function miss(query: string): string {
  const trimmed = query.trim();
  return `No candidate matching "${trimmed}" is in this job's pool. Only candidates listed in the POOL ROSTER can be retrieved.`;
}

interface ChatResult {
  ok: boolean;
  messages: Array<{ role: string; content: string }>;
  message?: string;
}

let sendCandidateChat: (input: { candidateId: string; message: string }) => Promise<ChatResult>;

async function ask(toolQuery: string): Promise<{ result: ChatResult; exchange: ToolExchange; saved: string }> {
  scriptedToolQuery = toolQuery;
  lastExchange = { toolOffered: false, toolResult: null };
  const result = await sendCandidateChat({
    candidateId: FOCUS_ID,
    message: "Compare this file with the other person I named.",
  });
  const saved =
    result.messages.filter((message) => message.role === "assistant").at(-1)?.content ?? "";
  return { result, exchange: lastExchange, saved };
}

test.before(async () => {
  const actions = await import("../src/app/actions/triage.ts");
  const exported = actions as typeof actions & { default?: { sendCandidateChat: typeof sendCandidateChat } };
  sendCandidateChat = exported.sendCandidateChat ?? exported.default?.sendCandidateChat;
  if (!sendCandidateChat) throw new Error("sendCandidateChat export missing");
});

const NEWER = "2026-11-01T00:00:00.000Z";
const OLDER = "2026-01-01T00:00:00.000Z";

test("a query that merely contains a short legal name does not load that applicant", async () => {
  seed([
    { id: "cand_li", name: "Li", createdAt: NEWER, marker: "LI" },
    { id: "cand_jane", name: "Jane Smith", createdAt: OLDER, marker: "JANE" },
  ]);
  const liBefore = structuredClone(workspaceOf("cand_li"));
  const { result, exchange, saved } = await ask("applied");

  assert.equal(result.message, undefined);
  assert.equal(exchange.toolOffered, true);
  assert.equal(exchange.toolResult, miss("applied"));
  assert.equal(saved, miss("applied"));
  assert.equal(saved.includes("LI_TRANSCRIPT"), false);
  assert.equal(saved.includes("LI_COVER"), false);
  assert.equal(saved.includes("LI_ANSWER"), false);
  assert.equal(saved.includes("LI_RESUME"), false);
  assert.equal(saved.includes("LI_ACTIVITY"), false);
  assert.equal(saved.includes("LI_PASTED"), false);
  const focus = workspaceOf(FOCUS_ID);
  const focusChat = (focus?.workspace as { chat?: { role: string; content: string }[] } | undefined)?.chat ?? [];
  assert.equal(focusChat.at(-1)?.content, miss("applied"));
  assert.deepEqual(workspaceOf("cand_li"), liBefore);
});

test("the word compared does not load an applicant named Ed who sorts first", async () => {
  seed([
    { id: "cand_ed", name: "Ed", createdAt: NEWER, marker: "ED" },
    { id: "cand_jane", name: "Jane Smith", createdAt: OLDER, marker: "JANE" },
  ]);
  const edBefore = structuredClone(workspaceOf("cand_ed"));
  const { exchange, saved } = await ask("compared");

  assert.equal(exchange.toolOffered, true);
  assert.equal(exchange.toolResult, miss("compared"));
  assert.equal(saved, miss("compared"));
  assert.equal(saved.includes("ED_TRANSCRIPT"), false);
  assert.equal(saved.includes("ED_ACTIVITY"), false);
  assert.deepEqual(workspaceOf("cand_ed"), edBefore);
});

test("a sentence that mentions one applicant does not load an earlier short name inside that sentence", async () => {
  seed([
    { id: "cand_ed", name: "Ed", createdAt: NEWER, marker: "ED" },
    { id: "cand_jane", name: "Jane Smith", createdAt: OLDER, marker: "JANE" },
  ]);
  const query = "materials compared for Jane Smith";
  const { exchange, saved } = await ask(query);

  assert.equal(exchange.toolOffered, true);
  assert.equal(exchange.toolResult, miss(query));
  assert.equal(saved, miss(query));
  assert.equal(saved.includes("ED_TRANSCRIPT"), false);
  assert.equal(saved.includes("JANE_TRANSCRIPT"), false);
  assert.equal(saved.includes("ED_PASTED"), false);
  assert.equal(saved.includes("JANE_COVER"), false);
});

test("a first name does not load a different applicant whose full name contains that string", async () => {
  seed([
    { id: "cand_janet", name: "Janet Cho", createdAt: NEWER, marker: "JANET" },
    { id: "cand_jane", name: "Jane Smith", createdAt: OLDER, marker: "JANE" },
  ]);
  const janetBefore = structuredClone(workspaceOf("cand_janet"));
  const { exchange, saved } = await ask("Jane");

  assert.equal(exchange.toolOffered, true);
  assert.equal(exchange.toolResult, miss("Jane"));
  assert.equal(saved, miss("Jane"));
  assert.equal(saved.includes("JANET_TRANSCRIPT"), false);
  assert.equal(saved.includes("JANE_TRANSCRIPT"), false);
  assert.deepEqual(workspaceOf("cand_janet"), janetBefore);
});

test("a partial last name does not load the first roster row that contains it", async () => {
  seed([
    { id: "cand_smithson", name: "Smithson Blair", createdAt: NEWER, marker: "SMITHSON" },
    { id: "cand_jane", name: "Jane Smith", createdAt: OLDER, marker: "JANE" },
  ]);
  const { exchange, saved } = await ask("Smith");

  assert.equal(exchange.toolOffered, true);
  assert.equal(exchange.toolResult, miss("Smith"));
  assert.equal(saved, miss("Smith"));
  assert.equal(saved.includes("SMITHSON_TRANSCRIPT"), false);
  assert.equal(saved.includes("SMITHSON_RESUME"), false);
  assert.equal(saved.includes("JANE_ANSWER"), false);
});

test("an exact full name still returns that applicant's dossier and stores the reply on the opened candidate", async () => {
  seed([
    { id: "cand_ed", name: "Ed", createdAt: NEWER, marker: "ED" },
    { id: "cand_jane", name: "Jane Smith", createdAt: OLDER, marker: "JANE" },
  ]);
  const { exchange, saved } = await ask("Jane Smith");

  assert.equal(exchange.toolOffered, true);
  assert.match(exchange.toolResult ?? "", /^Record for Jane Smith /);
  for (const marker of ["JANE_TRANSCRIPT", "JANE_COVER", "JANE_ANSWER", "JANE_RESUME", "JANE_ACTIVITY", "JANE_PASTED"]) {
    assert.equal(saved.includes(marker), true, marker);
  }
  assert.equal(saved.includes("ED_TRANSCRIPT"), false);
  const focusChat = (
    (workspaceOf(FOCUS_ID)?.workspace as { chat?: { content: string }[] } | undefined)?.chat ?? []
  );
  assert.equal(focusChat.at(-1)?.content.includes("JANE_TRANSCRIPT"), true);
  assert.equal(workspaceOf("cand_jane")?.workspace && JSON.stringify(workspaceOf("cand_jane")?.workspace).includes("chat"), false);
});

test("an exact id still returns that applicant even when a short name sorts first", async () => {
  seed([
    { id: "cand_ed", name: "Ed", createdAt: NEWER, marker: "ED" },
    { id: "cand_jane", name: "Jane Smith", createdAt: OLDER, marker: "JANE" },
  ]);
  const { exchange, saved } = await ask("cand_jane");

  assert.match(exchange.toolResult ?? "", /^Record for Jane Smith /);
  assert.equal(saved.includes("JANE_TRANSCRIPT"), true);
  assert.equal(saved.includes("ED_TRANSCRIPT"), false);
});

test("exact full name match trims and case-folds", async () => {
  seed([
    { id: "cand_ed", name: "Ed", createdAt: NEWER, marker: "ED" },
    { id: "cand_jane", name: "Jane Smith", createdAt: OLDER, marker: "JANE" },
  ]);
  const { exchange, saved } = await ask("  jAnE sMiTh  ");

  assert.match(exchange.toolResult ?? "", /^Record for Jane Smith /);
  assert.equal(saved.includes("JANE_RESUME"), true);
  assert.equal(saved.includes("ED_RESUME"), false);
});
