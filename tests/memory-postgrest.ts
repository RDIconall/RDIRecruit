/**
 * In-process PostgREST for the supabase-js the app actually ships
 * (@supabase/postgrest-js 2.108.1). The client builds the request; this store
 * only applies that request. Filter grammar is the one PostgrestFilterBuilder
 * writes (`eq.`, `in.()`, `like.`, `is.`, `order`, `limit`, `offset`,
 * `on_conflict`, Prefer resolution/return). RPC bodies follow the SQL in
 * supabase/migrations.
 */

export type Row = Record<string, unknown>;

const DEFAULT_CONFLICT: Record<string, string[]> = {
  sync_state: ["key"],
  candidates: ["workable_id"],
  applications: ["candidate_id"],
  candidate_overlay: ["candidate_id"],
  candidate_working_files: ["candidate_id"],
  job_rubrics: ["job_shortcode"],
};

export function createMemoryPostgrest() {
  const tables = new Map<string, Row[]>();
  let clock = Date.parse("2026-01-01T00:00:00.000Z");

  function bucket(table: string): Row[] {
    let rows = tables.get(table);
    if (!rows) {
      rows = [];
      tables.set(table, rows);
    }
    return rows;
  }

  function stamp(table: string, row: Row): Row {
    const next = { ...row };
    if (table !== "sync_state" && (next.id === undefined || next.id === null)) {
      next.id = crypto.randomUUID();
    }
    if (next.created_at === undefined || next.created_at === null) {
      clock += 1000;
      next.created_at = new Date(clock).toISOString();
    }
    return next;
  }

  function clone<T>(value: T): T {
    return structuredClone(value);
  }

  function rows(table: string): Row[] {
    return clone(bucket(table));
  }

  function reset() {
    tables.clear();
  }

  function updateWhere(table: string, pred: (row: Row) => boolean, patch: Row) {
    for (const row of bucket(table)) {
      if (pred(row)) Object.assign(row, patch);
    }
  }

  function handle(urlString: string, init?: RequestInit): Response {
    const url = new URL(urlString);
    const method = (init?.method ?? "GET").toUpperCase();
    const prefer = header(init, "prefer");
    const accept = header(init, "accept");
    const body = parseBody(init?.body);

    if (url.pathname.includes("/rpc/")) {
      const name = decodeURIComponent(url.pathname.split("/rpc/")[1] ?? "");
      const data = callRpc(name, (body ?? {}) as Row);
      return json(data, 200);
    }

    const table = decodeURIComponent(url.pathname.split("/rest/v1/")[1] ?? "").replace(/^\//, "");
    const filters = parseFilters(url);
    const order = parseOrder(url.searchParams.get("order"));
    const limit = numberParam(url.searchParams.get("limit"));
    const offset = numberParam(url.searchParams.get("offset")) ?? 0;
    const wantObject = accept.includes("application/vnd.pgrst.object+json");
    const returning = prefer.includes("return=representation");
    const countExact = prefer.includes("count=exact");

    if (method === "GET" || method === "HEAD") {
      const matched = sortRows(applyFilters(bucket(table), filters), order);
      const total = matched.length;
      const page = matched.slice(offset, limit == null ? undefined : offset + limit);
      const projected = project(page, url.searchParams.get("select"));
      if (method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "content-range": `*/${total}` },
        });
      }
      return respondRows(projected, { wantObject, total, countExact });
    }

    if (method === "POST") {
      const incoming = Array.isArray(body) ? (body as Row[]) : [((body ?? {}) as Row)];
      const conflict = (url.searchParams.get("on_conflict") ?? DEFAULT_CONFLICT[table]?.join(","))
        ?.split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      const ignore = prefer.includes("resolution=ignore-duplicates");
      const written: Row[] = [];
      for (const raw of incoming) {
        const next = stamp(table, raw);
        if (conflict?.length) {
          const existing = bucket(table).find((row) =>
            conflict.every((column) => row[column] === next[column]),
          );
          if (existing) {
            if (!ignore) {
              Object.assign(existing, next, { id: existing.id, created_at: existing.created_at });
              written.push(existing);
            }
            continue;
          }
        }
        bucket(table).push(next);
        written.push(next);
      }
      if (!returning) return new Response(null, { status: 201 });
      return respondRows(project(written, url.searchParams.get("select")), { wantObject, total: written.length });
    }

    if (method === "PATCH") {
      const matched = applyFilters(bucket(table), filters);
      for (const row of matched) Object.assign(row, (body ?? {}) as Row);
      if (!returning) return new Response(null, { status: 204 });
      return respondRows(project(matched, url.searchParams.get("select")), {
        wantObject,
        total: matched.length,
      });
    }

    if (method === "DELETE") {
      const all = bucket(table);
      const matched = applyFilters(all, filters);
      const drop = new Set(matched);
      tables.set(
        table,
        all.filter((row) => !drop.has(row)),
      );
      if (!returning) return new Response(null, { status: 204 });
      return respondRows(project(matched, url.searchParams.get("select")), {
        wantObject,
        total: matched.length,
      });
    }

    return json({ message: `unsupported method ${method}`, code: "PGRST000" }, 400);
  }

  function callRpc(name: string, args: Row): unknown {
    if (name === "try_acquire_scoring_lock") {
      const ttl = Number(args.ttl_minutes ?? 6);
      const now = new Date();
      const rowsFor = bucket("sync_state");
      const existing = rowsFor.find((row) => row.key === "scoring_lock");
      const at = (existing?.value as { at?: string | null } | undefined)?.at ?? null;
      const stale =
        !existing ||
        at == null ||
        new Date(at).getTime() < now.getTime() - ttl * 60_000;
      if (!stale) return false;
      const value = { at: now.toISOString() };
      if (!existing) {
        rowsFor.push({ key: "scoring_lock", value, updated_at: now.toISOString() });
      } else {
        existing.value = value;
        existing.updated_at = now.toISOString();
      }
      return true;
    }
    if (name === "release_scoring_lock") {
      const existing = bucket("sync_state").find((row) => row.key === "scoring_lock");
      if (existing) {
        existing.value = { at: null };
        existing.updated_at = new Date().toISOString();
      }
      return null;
    }
    if (name === "claim_candidate_analysis") {
      const row = bucket("candidate_analyses").find((item) => item.id === args.p_analysis_id);
      if (!row || row.batch_id != null) return false;
      if (row.status !== "pending" && row.status !== "failed") return false;
      const now = new Date().toISOString();
      row.status = "processing";
      row.started_at = now;
      row.updated_at = now;
      row.attempt_count = Number(row.attempt_count ?? 0) + 1;
      row.error = null;
      return true;
    }
    if (name === "claim_candidate_analysis_projection") {
      const row = bucket("candidate_analyses").find((item) => item.id === args.p_analysis_id);
      if (!row || row.status !== "completed" || row.projected_at != null) return false;
      const staleMinutes = Number(args.p_stale_minutes ?? 15);
      const started = row.projection_started_at ? new Date(String(row.projection_started_at)).getTime() : null;
      const fresh = started != null && started >= Date.now() - staleMinutes * 60_000;
      if (fresh) return false;
      const now = new Date().toISOString();
      row.projection_started_at = now;
      row.updated_at = now;
      return true;
    }
    if (name === "attach_candidate_analyses_to_batch") {
      const ids = new Set((args.p_analysis_ids as string[]) ?? []);
      const now = new Date().toISOString();
      for (const row of bucket("candidate_analyses")) {
        if (!ids.has(String(row.id))) continue;
        if (row.batch_id != null || row.status !== "processing") continue;
        row.status = "submitted";
        row.batch_id = args.p_batch_id;
        row.submitted_at = now;
        row.updated_at = now;
        row.error = null;
      }
      return bucket("candidate_analyses").filter(
        (row) => ids.has(String(row.id)) && row.batch_id === args.p_batch_id && row.status === "submitted",
      ).length;
    }
    throw new Error(`memory postgrest has no rpc ${name}`);
  }

  return { handle, reset, rows, updateWhere };
}

function header(init: RequestInit | undefined, name: string): string {
  const headers = new Headers(init?.headers);
  return headers.get(name) ?? "";
}

function parseBody(body: BodyInit | null | undefined): unknown {
  if (body == null || body === "") return null;
  if (typeof body === "string") return JSON.parse(body);
  return null;
}

function numberParam(value: string | null): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

type Filter =
  | { op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte"; column: string; value: string }
  | { op: "like" | "ilike"; column: string; value: string }
  | { op: "is"; column: string; value: string }
  | { op: "in" | "not.in"; column: string; values: string[] };

function parseFilters(url: URL): Filter[] {
  const filters: Filter[] = [];
  const reserved = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);
  for (const [column, raw] of url.searchParams.entries()) {
    if (reserved.has(column)) continue;
    if (raw.startsWith("not.in.(") && raw.endsWith(")")) {
      filters.push({ op: "not.in", column, values: splitList(raw.slice("not.in.(".length, -1)) });
    } else if (raw.startsWith("in.(") && raw.endsWith(")")) {
      filters.push({ op: "in", column, values: splitList(raw.slice("in.(".length, -1)) });
    } else if (raw.startsWith("is.")) {
      filters.push({ op: "is", column, value: raw.slice(3) });
    } else if (raw.startsWith("ilike.")) {
      filters.push({ op: "ilike", column, value: raw.slice(6) });
    } else if (raw.startsWith("like.")) {
      filters.push({ op: "like", column, value: raw.slice(5) });
    } else {
      const match = /^(eq|neq|gt|gte|lt|lte)\.(.*)$/.exec(raw);
      if (!match) throw new Error(`unparsed postgrest filter ${column}=${raw}`);
      filters.push({
        op: match[1] as "eq" | "neq" | "gt" | "gte" | "lt" | "lte",
        column,
        value: match[2] ?? "",
      });
    }
  }
  return filters;
}

function splitList(value: string): string[] {
  if (!value) return [];
  return value.split(",").map((part) => part.replace(/^"|"$/g, ""));
}

function applyFilters(rows: Row[], filters: Filter[]): Row[] {
  return rows.filter((row) => filters.every((filter) => matches(row, filter)));
}

function matches(row: Row, filter: Filter): boolean {
  const value = row[filter.column];
  if (filter.op === "in") return filter.values.some((item) => same(value, item));
  if (filter.op === "not.in") return !filter.values.some((item) => same(value, item));
  if (filter.op === "is") {
    if (filter.value === "null") return value == null;
    if (filter.value === "true") return value === true;
    if (filter.value === "false") return value === false;
    return false;
  }
  if (filter.op === "like" || filter.op === "ilike") {
    const source = value == null ? "" : String(value);
    const pattern = likeToRegExp(filter.value, filter.op === "ilike");
    return pattern.test(source);
  }
  if (value == null) return false;
  const cmp = compare(value, filter.value);
  if (filter.op === "eq") return cmp === 0;
  if (filter.op === "neq") return cmp !== 0;
  if (filter.op === "gt") return cmp > 0;
  if (filter.op === "gte") return cmp >= 0;
  if (filter.op === "lt") return cmp < 0;
  return cmp <= 0;
}

function same(value: unknown, encoded: string): boolean {
  if (value == null) return false;
  return compare(value, encoded) === 0;
}

function compare(value: unknown, encoded: string): number {
  if (typeof value === "number" && encoded !== "" && !Number.isNaN(Number(encoded))) {
    return value === Number(encoded) ? 0 : value < Number(encoded) ? -1 : 1;
  }
  if (typeof value === "boolean") {
    return String(value) === encoded ? 0 : -1;
  }
  const text = String(value);
  if (text === encoded) return 0;
  return text < encoded ? -1 : 1;
}

function likeToRegExp(pattern: string, insensitive: boolean): RegExp {
  let source = "";
  for (const char of pattern) {
    if (char === "%") source += ".*";
    else if (char === "_") source += ".";
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, insensitive ? "i" : "");
}

function parseOrder(value: string | null): Array<{ column: string; ascending: boolean }> {
  if (!value) return [];
  return value.split(",").map((part) => {
    const [column, direction] = part.split(".");
    return { column: column ?? "", ascending: direction !== "desc" };
  });
}

function sortRows(rows: Row[], order: Array<{ column: string; ascending: boolean }>): Row[] {
  if (!order.length) return rows;
  return [...rows].sort((a, b) => {
    for (const key of order) {
      const av = a[key.column];
      const bv = b[key.column];
      if (av === bv) continue;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av < bv) return key.ascending ? -1 : 1;
      if (av > bv) return key.ascending ? 1 : -1;
    }
    return 0;
  });
}

function project(rows: Row[], select: string | null): Row[] {
  if (!select || select === "*") return rows.map((row) => structuredClone(row));
  const columns = select.split(",").map((column) => column.trim()).filter(Boolean);
  return rows.map((row) => {
    const next: Row = {};
    for (const column of columns) next[column] = structuredClone(row[column]);
    return next;
  });
}

function respondRows(
  rows: Row[],
  options: { wantObject: boolean; total: number; countExact?: boolean },
): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.countExact) headers.set("content-range", `0-${Math.max(rows.length - 1, 0)}/${options.total}`);
  if (options.wantObject) {
    if (rows.length !== 1) {
      return json(
        {
          code: "PGRST116",
          details: `Results contain ${rows.length} rows`,
          hint: null,
          message: "JSON object requested, multiple (or no) rows returned",
        },
        406,
      );
    }
    return json(rows[0], 200, headers);
  }
  return json(rows, 200, headers);
}

function json(data: unknown, status: number, headers?: Headers): Response {
  const next = headers ?? new Headers({ "content-type": "application/json" });
  if (!next.has("content-type")) next.set("content-type", "application/json");
  return new Response(JSON.stringify(data), { status, headers: next });
}
