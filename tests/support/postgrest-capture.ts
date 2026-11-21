import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

/**
 * Records the JSON bodies the shipped Supabase client POSTs.
 *
 * @supabase/postgrest-js 2.108.1 `insert` puts the row object on the request and
 * `PostgrestBuilder.then` sends `JSON.stringify(body)` to `/rest/v1/<table>`
 * (dist/index.mjs around the insert method and the fetch in `then`).
 * Filters are the query operators that client appends (`eq.`, `lt.`, `in.()`).
 * This server stores that JSON. It does not reinterpret it.
 */
export type CapturedRow = { id: string } & Record<string, unknown>;

const RESERVED = new Set(["select", "order", "limit", "offset", "columns"]);

function normalize(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null || value === undefined) return "";
  return String(value);
}

function compare(actual: unknown, expected: string): number {
  return normalize(actual) < expected ? -1 : normalize(actual) > expected ? 1 : 0;
}

function matchesExpr(actual: unknown, expr: string): boolean {
  if (expr.startsWith("eq.")) return normalize(actual) === expr.slice(3);
  if (expr.startsWith("neq.")) return normalize(actual) !== expr.slice(4);
  if (expr.startsWith("lt.")) return compare(actual, expr.slice(3)) < 0;
  if (expr.startsWith("lte.")) return compare(actual, expr.slice(4)) <= 0;
  if (expr.startsWith("gt.")) return compare(actual, expr.slice(3)) > 0;
  if (expr.startsWith("gte.")) return compare(actual, expr.slice(4)) >= 0;
  if (expr.startsWith("is.")) {
    const want = expr.slice(3);
    if (want === "null") return actual === null || actual === undefined;
    if (want === "true") return actual === true;
    if (want === "false") return actual === false;
    return normalize(actual) === want;
  }
  if (expr.startsWith("in.(") && expr.endsWith(")")) {
    const options = expr.slice(4, -1).split(",").filter((part) => part.length > 0);
    return options.includes(normalize(actual));
  }
  return false;
}

function matching(rows: CapturedRow[], params: URLSearchParams): CapturedRow[] {
  let found = rows.filter((row) => {
    for (const [key, value] of params.entries()) {
      if (RESERVED.has(key)) continue;
      if (!matchesExpr(row[key], value)) return false;
    }
    return true;
  });
  const order = params.get("order");
  if (order) {
    const [column, direction] = order.split(".");
    found = [...found].sort((a, b) => {
      const cmp = compare(a[column], normalize(b[column]));
      return direction === "desc" ? -cmp : cmp;
    });
  }
  const limit = params.get("limit");
  if (limit) found = found.slice(0, Number(limit));
  return found;
}

function project(rows: CapturedRow[], select: string | null): CapturedRow[] {
  if (!select || select === "*") return rows.map((row) => ({ ...row }));
  const columns = select.split(",").map((column) => column.trim()).filter(Boolean);
  return rows.map((row) => {
    const copy: CapturedRow = { id: row.id };
    for (const column of columns) copy[column] = row[column];
    return copy;
  });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export async function startPostgrestCapture(): Promise<{
  url: string;
  close: () => Promise<void>;
  reset: () => void;
  seed: (table: string, row: Record<string, unknown>) => CapturedRow;
  rows: (table: string) => CapturedRow[];
}> {
  const tables = new Map<string, CapturedRow[]>();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const table = url.pathname.replace(/^\/rest\/v1\//, "").replace(/\/$/, "");
    if (!table || table.startsWith("auth") || table.startsWith("realtime")) {
      res.statusCode = 404;
      res.end(JSON.stringify({ message: "unhandled", code: "PGRST000" }));
      return;
    }
    const rows = tables.get(table) ?? [];
    tables.set(table, rows);
    const method = req.method ?? "GET";
    const prefer = req.headers.prefer ?? "";
    const wantsRow = prefer.includes("return=representation");

    if (method === "GET") {
      const selected = project(matching(rows, url.searchParams), url.searchParams.get("select"));
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(selected));
      return;
    }

    if (method === "POST") {
      const raw = await readBody(req);
      const parsed = raw ? JSON.parse(raw) : {};
      const incoming = Array.isArray(parsed) ? parsed : [parsed];
      const inserted: CapturedRow[] = incoming.map((row: Record<string, unknown>) => {
        const stored: CapturedRow = {
          ...row,
          id: typeof row.id === "string" ? row.id : randomUUID(),
        };
        if (stored.received_at === undefined) stored.received_at = new Date().toISOString();
        rows.push(stored);
        return stored;
      });
      if (wantsRow) {
        res.statusCode = 201;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(inserted));
        return;
      }
      res.statusCode = 201;
      res.end();
      return;
    }

    if (method === "PATCH") {
      const raw = await readBody(req);
      const patch = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const hits = matching(rows, url.searchParams);
      for (const row of hits) Object.assign(row, patch);
      if (wantsRow) {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(hits));
        return;
      }
      res.statusCode = 204;
      res.end();
      return;
    }

    if (method === "DELETE") {
      const hits = new Set(matching(rows, url.searchParams));
      const kept = rows.filter((row) => !hits.has(row));
      tables.set(table, kept);
      if (wantsRow) {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify([...hits]));
        return;
      }
      res.statusCode = 204;
      res.end();
      return;
    }

    res.statusCode = 405;
    res.end(JSON.stringify({ message: `method ${method}`, code: "PGRST000" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("capture server did not bind");
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    reset: () => tables.clear(),
    seed: (table, row) => {
      const list = tables.get(table) ?? [];
      tables.set(table, list);
      const stored: CapturedRow = {
        ...row,
        id: typeof row.id === "string" ? row.id : randomUUID(),
      };
      list.push(stored);
      return stored;
    },
    rows: (table) => [...(tables.get(table) ?? [])],
  };
}
