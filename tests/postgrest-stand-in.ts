import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

/**
 * Minimal PostgREST stand-in for the filters this repo's service client sends.
 *
 * `ilike` follows PostgREST v12.2.12 `pgFmtFilter` (SqlFragment.hs:375-377 and
 * the `star` map at line 403): `*` becomes `%`, and `%` / `_` are left in place
 * for PostgreSQL ILIKE. Matching follows PostgreSQL 15 `MatchText`
 * (src/backend/utils/adt/like_match.c) with ILIKE case-folding. `eq` stays
 * case-sensitive, the same as PostgREST's `=` operator.
 */

const LIKE_TRUE = 1;
const LIKE_FALSE = 0;
const LIKE_ABORT = -1;

export function postgrestIlikePattern(raw: string): string {
  let out = "";
  for (const char of raw) out += char === "*" ? "%" : char;
  return out;
}

function matchText(text: string[], ti: number, pattern: string[], pi: number): number {
  const tlen = () => text.length - ti;
  const plen = () => pattern.length - pi;
  if (plen() === 1 && pattern[pi] === "%") return LIKE_TRUE;

  while (tlen() > 0 && plen() > 0) {
    if (pattern[pi] === "\\") {
      pi += 1;
      if (plen() <= 0) {
        throw new Error("LIKE pattern must not end with escape character");
      }
      if (pattern[pi].toLowerCase() !== text[ti].toLowerCase()) return LIKE_FALSE;
    } else if (pattern[pi] === "%") {
      pi += 1;
      while (plen() > 0) {
        if (pattern[pi] === "%") pi += 1;
        else if (pattern[pi] === "_") {
          if (tlen() <= 0) return LIKE_ABORT;
          ti += 1;
          pi += 1;
        } else break;
      }
      if (plen() <= 0) return LIKE_TRUE;
      const firstpat = (pattern[pi] === "\\" ? pattern[pi + 1] : pattern[pi]).toLowerCase();
      if (pattern[pi] === "\\" && plen() < 2) {
        throw new Error("LIKE pattern must not end with escape character");
      }
      while (tlen() > 0) {
        if (text[ti].toLowerCase() === firstpat) {
          const matched = matchText(text, ti, pattern, pi);
          if (matched !== LIKE_FALSE) return matched;
        }
        ti += 1;
      }
      return LIKE_ABORT;
    } else if (pattern[pi] === "_") {
      ti += 1;
      pi += 1;
      continue;
    } else if (pattern[pi].toLowerCase() !== text[ti].toLowerCase()) {
      return LIKE_FALSE;
    }
    ti += 1;
    pi += 1;
  }

  if (tlen() > 0) return LIKE_FALSE;
  while (plen() > 0 && pattern[pi] === "%") pi += 1;
  if (plen() <= 0) return LIKE_TRUE;
  return LIKE_ABORT;
}

export function ilike(value: unknown, pattern: string): boolean {
  if (typeof value !== "string") return false;
  const folded = postgrestIlikePattern(pattern);
  return matchText(Array.from(value), 0, Array.from(folded), 0) === LIKE_TRUE;
}

export type Row = Record<string, unknown>;

const tables = new Map<string, Row[]>();

export function resetTables(): void {
  tables.clear();
}

export function rows(table: string): Row[] {
  return tables.get(table) ?? [];
}

export function seed(table: string, row: Row): void {
  const list = tables.get(table) ?? [];
  list.push({ ...row });
  tables.set(table, list);
}

const RESERVED = new Set(["select", "columns", "on_conflict", "order", "limit", "offset"]);

function parseList(raw: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      values.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.length) values.push(current);
  return values;
}

function compare(left: unknown, right: string): number {
  if (typeof left === "number" && right !== "" && !Number.isNaN(Number(right))) {
    return left - Number(right);
  }
  return String(left ?? "").localeCompare(right);
}

function rowMatches(row: Row, column: string, raw: string): boolean {
  const dot = raw.indexOf(".");
  if (dot < 0) return false;
  const op = raw.slice(0, dot);
  const value = raw.slice(dot + 1);
  if (op === "not") {
    const inner = value.indexOf(".");
    if (inner < 0) return false;
    return !rowMatches(row, column, value);
  }
  const cell = row[column];
  if (op === "eq") return cell !== null && cell !== undefined && String(cell) === value;
  if (op === "ilike") return ilike(cell, value);
  if (op === "is") {
    if (value === "null") return cell === null || cell === undefined;
    if (value === "true") return cell === true;
    if (value === "false") return cell === false;
    return false;
  }
  if (op === "in") {
    const inner = value.startsWith("(") && value.endsWith(")") ? value.slice(1, -1) : value;
    return parseList(inner).includes(String(cell));
  }
  if (op === "lt") return cell !== null && cell !== undefined && compare(cell, value) < 0;
  if (op === "lte") return cell !== null && cell !== undefined && compare(cell, value) <= 0;
  if (op === "gt") return cell !== null && cell !== undefined && compare(cell, value) > 0;
  if (op === "gte") return cell !== null && cell !== undefined && compare(cell, value) >= 0;
  throw new Error(`unsupported PostgREST operator ${op} on ${column}`);
}

function project(row: Row, select: string | null): Row {
  if (!select || select === "*") return { ...row };
  const out: Row = {};
  for (const column of select.split(",").map((part) => part.trim()).filter(Boolean)) {
    out[column] = row[column];
  }
  return out;
}

function applyOrder(list: Row[], order: string | null): Row[] {
  if (!order) return list;
  const terms = order.split(",").map((term) => {
    const [column, direction] = term.split(".");
    return { column, direction };
  });
  return [...list].sort((a, b) => {
    for (const term of terms) {
      const cmp = compare(a[term.column], String(b[term.column] ?? ""));
      if (cmp !== 0) return term.direction === "desc" ? -cmp : cmp;
    }
    return 0;
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, singular = false): void {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  const payload = singular && Array.isArray(body) ? body[0] ?? null : body;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

export async function startPostgrestStandIn(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const table = decodeURIComponent(url.pathname.replace(/^\/rest\/v1\//, "").replace(/\/$/, ""));
      if (!table || table.includes("/")) {
        send(res, 404, { message: `no route ${url.pathname}` });
        return;
      }
      const prefer = req.headers.prefer ?? "";
      const accept = req.headers.accept ?? "";
      const singular = accept.includes("application/vnd.pgrst.object+json");
      const returning = prefer.includes("return=representation");
      const list = tables.get(table) ?? [];
      tables.set(table, list);

      if (req.method === "GET" || req.method === "HEAD") {
        let matched = list.filter((row) => {
          for (const [key, value] of url.searchParams.entries()) {
            if (RESERVED.has(key)) continue;
            if (!rowMatches(row, key, value)) return false;
          }
          return true;
        });
        matched = applyOrder(matched, url.searchParams.get("order"));
        const limit = url.searchParams.get("limit");
        if (limit) matched = matched.slice(0, Number(limit));
        const projected = matched.map((row) => project(row, url.searchParams.get("select")));
        if (singular) {
          if (projected.length !== 1) {
            send(res, 406, {
              code: "PGRST116",
              details: `Results contain ${projected.length} rows, application/vnd.pgrst.object+json requires 1 row`,
              hint: null,
              message: "JSON object requested, multiple (or no) rows returned",
            });
            return;
          }
          send(res, 200, projected, true);
          return;
        }
        if (req.method === "HEAD") {
          res.writeHead(200, { "content-range": `0-0/${projected.length}` });
          res.end();
          return;
        }
        send(res, 200, projected);
        return;
      }

      const raw = await readBody(req);
      const parsed = raw ? JSON.parse(raw) : {};

      if (req.method === "POST") {
        const incoming = Array.isArray(parsed) ? parsed : [parsed];
        const conflict = url.searchParams.get("on_conflict");
        const ignore = prefer.includes("resolution=ignore-duplicates");
        const stored: Row[] = [];
        for (const item of incoming) {
          const row: Row = { id: randomUUID(), ...item };
          if (conflict) {
            const keys = conflict.split(",").map((key) => key.trim());
            const existing = list.find((candidate) => keys.every((key) => candidate[key] === row[key]));
            if (existing) {
              if (ignore) continue;
              for (const [key, value] of Object.entries(row)) {
                if (key !== "id") existing[key] = value;
              }
              stored.push(existing);
              continue;
            }
          }
          list.push(row);
          stored.push(row);
        }
        if (!returning) {
          send(res, 201, undefined);
          return;
        }
        const projected = stored.map((row) => project(row, url.searchParams.get("select")));
        send(res, 201, projected);
        return;
      }

      if (req.method === "PATCH") {
        const matched = list.filter((row) => {
          for (const [key, value] of url.searchParams.entries()) {
            if (RESERVED.has(key)) continue;
            if (!rowMatches(row, key, value)) return false;
          }
          return true;
        });
        for (const row of matched) Object.assign(row, parsed);
        if (!returning) {
          send(res, 204, undefined);
          return;
        }
        send(res, 200, matched.map((row) => project(row, url.searchParams.get("select"))));
        return;
      }

      send(res, 405, { message: `method ${req.method}` });
    } catch (error) {
      send(res, 400, { message: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stand-in failed to bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
