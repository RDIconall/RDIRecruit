import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

/**
 * Minimal PostgREST stand-in for the calls this app's Supabase client makes.
 * Request shape follows @supabase/postgrest-js 2.108.1:
 * - inserts are POST JSON (`PostgrestQueryBuilder.insert` + `JSON.stringify` in `then`)
 * - filters are query params `column=eq.value|in.(...)|gte.value|neq.value|ilike.value`
 * - `.order` / `.limit` / `.range` are `order`, `limit`, and `offset` query params
 * - `.select()` after insert sets `Prefer: return=representation`
 * - `.maybeSingle()` unwraps a one-element JSON array on the client, so GET returns an array
 */

export type Row = Record<string, unknown>;

const SKIP = new Set(["select", "order", "offset", "limit", "columns", "on_conflict"]);
const OPS = ["ilike", "gte", "neq", "lte", "like", "eq", "gt", "lt", "in", "is"] as const;

export function createPostgrestStub(seed: Record<string, Row[]>) {
  const tables = new Map<string, Row[]>();
  for (const [name, rows] of Object.entries(seed)) tables.set(name, rows.map((row) => ({ ...row })));

  const server = createServer(async (req, res) => {
    try {
      await handle(tables, req, res);
    } catch (error) {
      const message = error instanceof Error ? error.message : "stub failure";
      send(res, 500, { message, code: "stub" });
    }
  });

  return {
    tables,
    listen(): Promise<string> {
      return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const { port } = server.address() as AddressInfo;
          resolve(`http://127.0.0.1:${port}`);
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function handle(tables: Map<string, Row[]>, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const table = url.pathname.replace(/^\/rest\/v1\//, "").replace(/\/$/, "");
  if (!table || table.includes("/")) {
    send(res, 404, { message: "not found", code: "PGRST" });
    return;
  }
  const rows = tables.get(table) ?? [];
  tables.set(table, rows);

  if (req.method === "GET" || req.method === "HEAD") {
    const matched = project(applyQuery(rows, url), url.searchParams.get("select"));
    if (req.method === "HEAD") {
      res.writeHead(200);
      res.end();
      return;
    }
    send(res, 200, matched);
    return;
  }

  if (req.method === "POST") {
    const body = JSON.parse(await readBody(req)) as Row | Row[];
    const incoming = Array.isArray(body) ? body : [body];
    const stored: Row[] = [];
    for (const item of incoming) {
      if (table === "evidence") {
        const rawRef = item.raw_ref;
        if (typeof rawRef === "string" && rawRef.length > 0) {
          const duplicate = rows.some(
            (row) => row.candidate_id === item.candidate_id && row.raw_ref === rawRef,
          );
          if (duplicate) {
            send(res, 409, {
              code: "23505",
              message: "duplicate key value violates unique constraint",
              details: "idx_evidence_candidate_raw_ref",
              hint: null,
            });
            return;
          }
        }
      }
      const row: Row = {
        id: typeof item.id === "string" ? item.id : randomUUID(),
        created_at: typeof item.created_at === "string" ? item.created_at : new Date().toISOString(),
        ...item,
      };
      rows.push(row);
      stored.push(row);
    }
    const prefer = req.headers.prefer ?? "";
    if (prefer.includes("return=representation")) send(res, 201, stored);
    else {
      res.writeHead(201, { "content-type": "application/json" });
      res.end();
    }
    return;
  }

  send(res, 405, { message: "method not allowed", code: "stub" });
}

function applyQuery(rows: Row[], url: URL): Row[] {
  let out = rows.slice();
  for (const [key, raw] of url.searchParams) {
    if (SKIP.has(key)) continue;
    const parsed = parseOp(raw);
    if (!parsed) continue;
    out = out.filter((row) => match(row[key], parsed.op, parsed.value));
  }

  const order = url.searchParams.get("order");
  if (order) {
    const keys = order.split(",").map((part) => {
      const [column, direction] = part.split(".");
      return { column, desc: direction === "desc" };
    });
    out.sort((a, b) => {
      for (const key of keys) {
        const av = String(a[key.column] ?? "");
        const bv = String(b[key.column] ?? "");
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        if (cmp !== 0) return key.desc ? -cmp : cmp;
      }
      return 0;
    });
  }

  const offset = Number(url.searchParams.get("offset") ?? "0");
  const limit = url.searchParams.get("limit");
  const start = Number.isFinite(offset) ? offset : 0;
  if (limit != null) out = out.slice(start, start + Number(limit));
  else if (start) out = out.slice(start);
  return out;
}

function project(rows: Row[], select: string | null): Row[] {
  if (!select || select.trim() === "*") return rows;
  const columns = select.split(",").map((column) => column.trim()).filter(Boolean);
  return rows.map((row) => {
    const picked: Row = {};
    for (const column of columns) {
      if (column in row) picked[column] = row[column];
    }
    return picked;
  });
}

function parseOp(raw: string): { op: (typeof OPS)[number]; value: string } | null {
  for (const op of OPS) {
    const prefix = `${op}.`;
    if (raw.startsWith(prefix)) return { op, value: raw.slice(prefix.length) };
  }
  return null;
}

function match(actual: unknown, op: (typeof OPS)[number], expected: string): boolean {
  if (op === "in") {
    const inner = expected.startsWith("(") && expected.endsWith(")") ? expected.slice(1, -1) : expected;
    const values = inner.split(",").map((part) => part.trim().replace(/^"|"$/g, ""));
    return values.includes(String(actual ?? ""));
  }
  const text = actual == null ? "" : String(actual);
  if (op === "eq") return text === expected;
  if (op === "neq") return text !== expected;
  if (op === "gte" || op === "gt") return text >= expected;
  if (op === "lte" || op === "lt") return text <= expected;
  if (op === "ilike" || op === "like") {
    const needle = expected.replace(/%/g, "").toLowerCase();
    return text.toLowerCase().includes(needle);
  }
  if (op === "is") return expected === "null" ? actual == null : text === expected;
  return false;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
