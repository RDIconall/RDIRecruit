import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

type Row = Record<string, unknown>;

const RESERVED = new Set([
  "select",
  "order",
  "limit",
  "offset",
  "on_conflict",
  "columns",
  "and",
  "or",
]);

/**
 * In-process stand-in for the PostgREST and Storage HTTP APIs that
 * `@supabase/supabase-js` 2.108.1 speaks. It implements the filters, upsert
 * conflict behavior, and RPC transitions the grading path actually calls.
 * Tables are created on first write.
 */
export async function startMemoryApi(): Promise<{ url: string; close: () => Promise<void>; rows: (table: string) => Row[] }> {
  const tables = new Map<string, Row[]>();

  function table(name: string): Row[] {
    let rows = tables.get(name);
    if (!rows) {
      rows = [];
      tables.set(name, rows);
    }
    return rows;
  }

  function send(res: ServerResponse, status: number, body: unknown) {
    const payload = body == null ? "" : JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-range": "0-0/*",
    });
    res.end(payload);
  }

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  function project(row: Row, select: string | null): Row {
    if (!select || select === "*") return { ...row };
    const cols = select.split(",").map((col) => col.trim()).filter(Boolean);
    const out: Row = {};
    for (const col of cols) {
      if (!col.includes("(") && !col.includes(".")) out[col] = row[col];
    }
    return out;
  }

  function compare(op: string, value: unknown, raw: string): boolean {
    if (op === "is") {
      if (raw === "null") return value == null;
      if (raw === "true") return value === true;
      if (raw === "false") return value === false;
      return false;
    }
    if (op === "in") {
      const inner = raw.replace(/^\(/, "").replace(/\)$/, "");
      const options = inner.split(",").map((item) => item.trim().replace(/^"|"$/g, ""));
      return options.includes(value == null ? "" : String(value));
    }
    if (value == null) return false;
    const left = value instanceof Date ? value.toISOString() : String(value);
    if (op === "eq") return left === raw || (typeof value === "boolean" && String(value) === raw);
    if (op === "neq") return left !== raw;
    if (op === "gte") return left >= raw;
    if (op === "gt") return left > raw;
    if (op === "lte") return left <= raw;
    if (op === "lt") return left < raw;
    throw new Error(`Unsupported PostgREST operator ${op}.${raw}`);
  }

  function matches(row: Row, params: URLSearchParams): boolean {
    for (const [key, raw] of params.entries()) {
      if (RESERVED.has(key)) continue;
      const parsed = /^([a-z]+)\.(.*)$/s.exec(raw);
      if (!parsed) throw new Error(`Unsupported filter ${key}=${raw}`);
      if (!compare(parsed[1], row[key], parsed[2])) return false;
    }
    return true;
  }

  function sortRows(rows: Row[], order: string | null): Row[] {
    if (!order) return rows;
    const keys = order.split(",").map((part) => {
      const [column, direction, nulls] = part.split(".");
      return {
        column,
        desc: direction === "desc",
        nullsLast: nulls !== "nullsfirst",
      };
    });
    return [...rows].sort((a, b) => {
      for (const key of keys) {
        const av = a[key.column];
        const bv = b[key.column];
        if (av == null && bv == null) continue;
        if (av == null || bv == null) {
          if (!key.nullsLast) return av == null ? -1 : 1;
          return av == null ? 1 : -1;
        }
        if (av === bv) continue;
        const cmp = String(av) < String(bv) ? -1 : 1;
        return key.desc ? -cmp : cmp;
      }
      return 0;
    });
  }

  function conflictColumns(params: URLSearchParams): string[] {
    const raw = params.get("on_conflict");
    if (!raw) return [];
    return raw.split(",").map((col) => col.trim()).filter(Boolean);
  }

  function sameConflict(row: Row, incoming: Row, cols: string[]): boolean {
    return cols.every((col) => row[col] === incoming[col]);
  }

  async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL) {
    const prefer = (req.headers.prefer ?? "").toString();
    const accept = (req.headers.accept ?? "").toString();
    const wantsObject = accept.includes("application/vnd.pgrst.object+json");
    const wantsRepresentation = prefer.includes("return=representation");
    const ignoreDuplicates = prefer.includes("resolution=ignore-duplicates");
    const name = url.pathname.replace(/^\/rest\/v1\//, "").split("/")[0];
    const method = req.method ?? "GET";

    if (name === "rpc") {
      const fn = url.pathname.replace(/^\/rest\/v1\/rpc\//, "");
      const args = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
      send(res, 200, callRpc(fn, args));
      return;
    }

    const rows = table(name);
    if (method === "GET" || method === "HEAD") {
      let found = sortRows(rows.filter((row) => matches(row, url.searchParams)), url.searchParams.get("order"));
      const limit = url.searchParams.get("limit");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      if (offset) found = found.slice(offset);
      if (limit) found = found.slice(0, Number(limit));
      const projected = found.map((row) => project(row, url.searchParams.get("select")));
      if (wantsObject) {
        if (projected.length !== 1) {
          send(res, 406, {
            code: "PGRST116",
            details: `Results contain ${projected.length} rows`,
            hint: null,
            message: "JSON object requested, multiple (or no) rows returned",
          });
          return;
        }
        send(res, 200, projected[0]);
        return;
      }
      send(res, 200, projected);
      return;
    }

    const raw = await readBody(req);
    const payload = raw ? (JSON.parse(raw) as Row | Row[]) : {};
    const incoming = Array.isArray(payload) ? payload : [payload];

    if (method === "POST") {
      const cols = conflictColumns(url.searchParams);
      const written: Row[] = [];
      for (const item of incoming) {
        const conflict = cols.length ? rows.find((row) => sameConflict(row, item, cols)) : undefined;
        if (conflict && ignoreDuplicates) continue;
        if (conflict) {
          Object.assign(conflict, item);
          written.push(conflict);
          continue;
        }
        const row: Row = {
          id: typeof item.id === "string" ? item.id : crypto.randomUUID(),
          created_at: new Date().toISOString(),
          ...item,
        };
        // Match the column defaults in
        // supabase/migrations/20260831002527_canonical_candidate_analyses.sql.
        // A missing attempt_count is 0, not null, so the pending-batch filter
        // `attempt_count < 3` selects the row.
        if (name === "candidate_analyses") {
          if (row.attempt_count == null) row.attempt_count = 0;
          if (row.requested_at == null) row.requested_at = row.created_at;
          if (row.status == null) row.status = "pending";
        }
        rows.push(row);
        written.push(row);
      }
      if (!wantsRepresentation) {
        send(res, 201, null);
        return;
      }
      const projected = written.map((row) => project(row, url.searchParams.get("select")));
      if (wantsObject) {
        if (projected.length !== 1) {
          send(res, 406, {
            code: "PGRST116",
            details: `Results contain ${projected.length} rows`,
            hint: null,
            message: "JSON object requested, multiple (or no) rows returned",
          });
          return;
        }
        send(res, 201, projected[0]);
        return;
      }
      send(res, 201, projected);
      return;
    }

    if (method === "PATCH" || method === "DELETE") {
      const matched = rows.filter((row) => matches(row, url.searchParams));
      if (method === "DELETE") {
        const keep = rows.filter((row) => !matched.includes(row));
        tables.set(name, keep);
        send(res, wantsRepresentation ? 200 : 204, wantsRepresentation ? matched : null);
        return;
      }
      const patch = incoming[0] ?? {};
      for (const row of matched) Object.assign(row, patch);
      send(res, 200, wantsRepresentation ? matched.map((row) => project(row, url.searchParams.get("select"))) : null);
      return;
    }

    send(res, 405, { message: `Unsupported method ${method}` });
  }

  function callRpc(fn: string, args: Record<string, unknown>): unknown {
    if (fn === "claim_candidate_analysis") {
      const row = table("candidate_analyses").find((item) => item.id === args.p_analysis_id);
      if (!row || row.batch_id != null) return false;
      if (row.status !== "pending" && row.status !== "failed") return false;
      row.status = "processing";
      row.started_at = new Date().toISOString();
      row.updated_at = row.started_at;
      row.attempt_count = Number(row.attempt_count ?? 0) + 1;
      row.error = null;
      return true;
    }
    if (fn === "claim_candidate_analysis_projection") {
      const row = table("candidate_analyses").find((item) => item.id === args.p_analysis_id);
      if (!row || row.status !== "completed" || row.projected_at != null) return false;
      if (row.projection_started_at != null) return false;
      row.projection_started_at = new Date().toISOString();
      row.updated_at = row.projection_started_at;
      return true;
    }
    if (fn === "attach_candidate_analyses_to_batch") {
      const ids = Array.isArray(args.p_analysis_ids) ? args.p_analysis_ids : [];
      let attached = 0;
      for (const row of table("candidate_analyses")) {
        if (!ids.includes(row.id) || row.batch_id != null) continue;
        if (row.status !== "processing" && row.status !== "submitted") continue;
        row.batch_id = args.p_batch_id;
        row.status = "submitted";
        row.updated_at = new Date().toISOString();
        attached += 1;
      }
      return attached;
    }
    throw new Error(`Unsupported RPC ${fn}`);
  }

  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? "127.0.0.1";
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (url.pathname.startsWith("/storage/")) {
        send(res, 200, { Id: "storage-object", Key: url.pathname });
        return;
      }
      if (url.pathname.startsWith("/rest/v1/")) {
        await handleRest(req, res, url);
        return;
      }
      send(res, 404, { message: `No route ${url.pathname}` });
    } catch (error) {
      send(res, 500, { message: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Memory API failed to bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    rows: table,
  };
}
