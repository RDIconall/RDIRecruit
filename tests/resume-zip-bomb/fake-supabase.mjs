import { createServer } from "node:http";

const FILTER_OPS = /^(eq|neq|gt|gte|lt|lte|is|in|not|like|ilike)\./;
const SKIP_PARAMS = new Set([
  "select",
  "order",
  "limit",
  "offset",
  "on_conflict",
  "columns",
  "prefer",
  "apikey",
]);

function matchRaw(value, expr) {
  const dot = expr.indexOf(".");
  const op = dot === -1 ? expr : expr.slice(0, dot);
  const rest = dot === -1 ? "" : expr.slice(dot + 1);
  if (op === "eq") return String(value ?? "") === rest;
  if (op === "neq") return String(value ?? "") !== rest;
  if (op === "is") {
    if (rest === "null") return value == null;
    if (rest === "true") return value === true;
    if (rest === "false") return value === false;
  }
  if (op === "in") {
    const inner = rest.startsWith("(") && rest.endsWith(")") ? rest.slice(1, -1) : rest;
    const items = inner.length ? inner.split(",") : [];
    return items.includes(String(value ?? ""));
  }
  const actual = Number(value);
  const expected = Number(rest);
  if (op === "gt") return actual > expected;
  if (op === "gte") return actual >= expected;
  if (op === "lt") return actual < expected;
  if (op === "lte") return actual <= expected;
  return false;
}

function matches(row, params) {
  for (const [key, raw] of params.entries()) {
    if (SKIP_PARAMS.has(key)) continue;
    if (!FILTER_OPS.test(raw)) continue;
    const expr = raw.startsWith("not.") ? raw.slice(4) : raw;
    const ok = matchRaw(row[key], expr);
    if (raw.startsWith("not.") ? ok : !ok) return false;
  }
  return true;
}

function conflictKey(params) {
  return params.get("on_conflict");
}

function summarize(body) {
  if (!body || typeof body !== "object") return body;
  const copy = { ...body };
  if (typeof copy.resume_text === "string") {
    copy.resume_text = `[${copy.resume_text.length} chars] ${copy.resume_text.slice(0, 80)}`;
  }
  return copy;
}

/**
 * Loopback stand-in for the Supabase REST and Storage calls ingest and backfill
 * make. Filters are applied the way PostgREST encodes them so a later fix can
 * exclude a candidate with a new column without this double pretending the
 * query changed.
 */
export async function startFixtureServer({ files, rows }) {
  const tables = {
    candidates: structuredClone(rows.candidates ?? []),
    applications: structuredClone(rows.applications ?? []),
    evidence: [],
    narratives: [],
    evaluations: [],
    audit_log: [],
    candidate_overlay: [],
  };
  const downloads = {};
  const uploads = [];
  const applicationWrites = [];
  const requests = [];

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      requests.push(`${req.method} ${url.pathname}${url.search}`);
      if (requests.length > 40) requests.shift();
      if (req.method === "GET" && url.pathname.startsWith("/files/")) {
        const name = decodeURIComponent(url.pathname.slice("/files/".length));
        const file = files[name];
        downloads[name] = (downloads[name] ?? 0) + 1;
        if (!file) {
          res.writeHead(404).end("missing");
          return;
        }
        res.writeHead(200, {
          "content-type": file.mime,
          "content-length": String(file.body.length),
        });
        res.end(file.body);
        return;
      }

      if (url.pathname.startsWith("/storage/v1/object/")) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        uploads.push(url.pathname);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ Key: url.pathname, size: Buffer.concat(chunks).length }));
        return;
      }

      const tableMatch = url.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      if (!tableMatch) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: `unhandled ${req.method} ${url.pathname}` }));
        return;
      }
      const table = tableMatch[1];
      if (!tables[table]) tables[table] = [];
      const bucket = tables[table];
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) : null;

      if (req.method === "GET" || req.method === "HEAD") {
        let found = bucket.filter((row) => matches(row, url.searchParams));
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw == null ? NaN : Number(limitRaw);
        if (Number.isFinite(limit) && limit >= 0) found = found.slice(0, limit);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(found));
        return;
      }

      if (req.method === "POST") {
        const incoming = Array.isArray(body) ? body : [body];
        const key = conflictKey(url.searchParams);
        const stored = [];
        for (const row of incoming) {
          if (key && row && row[key] != null) {
            const index = bucket.findIndex((existing) => existing[key] === row[key]);
            if (index >= 0) {
              bucket[index] = { ...bucket[index], ...row };
              stored.push(bucket[index]);
              continue;
            }
          }
          bucket.push({ ...row });
          stored.push(bucket[bucket.length - 1]);
        }
        if (table === "applications") applicationWrites.push(summarize(stored[0]));
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify(stored));
        return;
      }

      if (req.method === "PATCH") {
        const updated = [];
        for (const row of bucket) {
          if (!matches(row, url.searchParams)) continue;
          Object.assign(row, body);
          updated.push(row);
        }
        if (table === "applications") applicationWrites.push(summarize(body));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(updated));
        return;
      }

      if (req.method === "DELETE") {
        const kept = [];
        for (const row of bucket) {
          if (matches(row, url.searchParams)) continue;
          kept.push(row);
        }
        tables[table] = kept;
        res.writeHead(200, { "content-type": "application/json" });
        res.end("[]");
        return;
      }

      res.writeHead(405).end();
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }));
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    load(next) {
      tables.candidates = structuredClone(next.candidates ?? []);
      tables.applications = structuredClone(next.applications ?? []);
      tables.evidence = [];
      tables.narratives = [];
      tables.evaluations = [];
      tables.audit_log = [];
      tables.candidate_overlay = [];
    },
    snapshot() {
      return {
        downloads: { ...downloads },
        requests: [...requests],
        uploads: [...uploads],
        applicationWrites: structuredClone(applicationWrites),
        applications: structuredClone(tables.applications),
      };
    },
    async close() {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
