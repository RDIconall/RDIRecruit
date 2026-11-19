/**
 * Drives the real cron route handlers and Clerk middleware.
 *
 * The stand-in boundary is the network: PostgREST responses are served from
 * fixture rows by the same URL shape @supabase/postgrest-js builds, SMTP is a
 * local server speaking the commands nodemailer sends, and Postgres is a TCP
 * listener that records connection attempts. Nothing is forwarded off-box.
 */
import http from "node:http";
import net from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildPublishableKey } from "@clerk/shared/keys";

const APPLICANT_NAME = "Averyquill North";
const APPLICANT_ROLE = "Data Lead";
const APPLICANT_COMPANY = "Northwindlabs";
const APPLICANT_WHY = "Quillrationale77";
const JOB_TITLE = "Clinical Data Manager Seat";
const JOB_SHORTCODE = "JOB1";
const CANDIDATE_ID = "cand-quill";
const PROFILE_URL = `https://rditrials.workable.com/backend/jobs/${JOB_SHORTCODE}/candidates/${CANDIDATE_ID}`;
const OUTSIDER = "outsider@example.com";
const SECRET_PLACEHOLDER = "cron-secret-placeholder";

type Row = Record<string, unknown>;
type Mutation = { method: string; table: string };

const originalFetch = globalThis.fetch.bind(globalThis);

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function listen(server: http.Server | net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("server did not bind a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function fixtureRows(): Record<string, Row[]> {
  const now = new Date().toISOString();
  const resume = "Parsed resume text for Averyquill North at Northwindlabs. ".repeat(4);
  return {
    jobs: [
      {
        shortcode: JOB_SHORTCODE,
        title: JOB_TITLE,
        status: "published",
        department: "Data",
        location: "Van Nuys, CA",
        raw: { full_description: "<p>Own data integrity reviews for the clinical program.</p>" },
      },
    ],
    candidates: [
      {
        workable_id: CANDIDATE_ID,
        name: APPLICANT_NAME,
        job_shortcode: JOB_SHORTCODE,
        created_at: now,
        stage: "Applied",
        disqualified: false,
        location: "Los Angeles, CA",
        raw: { profile_url: PROFILE_URL },
      },
    ],
    evaluations: [
      {
        id: "eval-fit",
        candidate_id: CANDIDATE_ID,
        kind: "fit_read",
        payload: {
          sentiment: "good",
          reply: APPLICANT_WHY,
          appliedFit: "matches the seat",
          rdiFit: "can take the integrity work",
          suggestedSeat: JOB_TITLE,
        },
        created_at: now,
      },
      {
        id: "eval-role",
        candidate_id: CANDIDATE_ID,
        kind: "role_read",
        payload: { role: APPLICANT_ROLE, company: APPLICANT_COMPANY },
        created_at: now,
      },
    ],
    applications: [
      {
        candidate_id: CANDIDATE_ID,
        answers: {},
        cover_letter: null,
        parsed_experience: [{ title: APPLICANT_ROLE, company: APPLICANT_COMPANY, start: "2018" }],
        resume_text: resume,
        resume_url: "https://files.example/resume.pdf",
        resume_storage_path: null,
      },
    ],
  };
}

function splitList(inner: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of inner) {
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

function matches(row: Row, column: string, expression: string): boolean {
  const value = row[column];
  if (expression.startsWith("eq.")) return String(value) === expression.slice(3);
  if (expression.startsWith("neq.")) return String(value) !== expression.slice(4);
  if (expression.startsWith("not.eq.")) return String(value) !== expression.slice(7);
  if (expression.startsWith("gte.")) return String(value ?? "") >= expression.slice(4);
  if (expression.startsWith("gt.")) return String(value ?? "") > expression.slice(3);
  if (expression.startsWith("lte.")) return String(value ?? "") <= expression.slice(4);
  if (expression.startsWith("lt.")) return String(value ?? "") < expression.slice(3);
  if (expression === "is.null") return value == null;
  if (expression === "not.is.null") return value != null;
  if (expression.startsWith("in.(") && expression.endsWith(")")) {
    return splitList(expression.slice(4, -1)).includes(String(value));
  }
  if (expression.startsWith("not.in.(") && expression.endsWith(")")) {
    return !splitList(expression.slice(8, -1)).includes(String(value));
  }
  return false;
}

const RESERVED = new Set(["select", "order", "offset", "limit", "on_conflict", "columns", "apikey"]);

function applyQuery(rows: Row[], search: URLSearchParams): Row[] {
  let filtered = rows.filter((row) => {
    for (const [column, expression] of search.entries()) {
      if (RESERVED.has(column)) continue;
      if (!matches(row, column, expression)) return false;
    }
    return true;
  });
  const order = search.get("order");
  if (order) {
    const parts = order.split(",").map((part) => {
      const [column, direction] = part.split(".");
      return { column, direction };
    });
    filtered = [...filtered].sort((a, b) => {
      for (const part of parts) {
        const left = String(a[part.column!] ?? "");
        const right = String(b[part.column!] ?? "");
        if (left === right) continue;
        const compared = left < right ? -1 : 1;
        return part.direction === "desc" ? -compared : compared;
      }
      return 0;
    });
  }
  const offset = Number(search.get("offset") ?? 0);
  const limit = search.get("limit");
  const start = Number.isFinite(offset) ? offset : 0;
  if (limit != null && Number.isFinite(Number(limit))) {
    return filtered.slice(start, start + Number(limit));
  }
  return filtered.slice(start);
}

function startPostgrest(mutations: Mutation[]): Promise<{ port: number; close: () => Promise<void> }> {
  const tables = fixtureRows();
  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.replace(/\/+$/, "");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const method = req.method ?? "GET";

    if (path.startsWith("/rest/v1/rpc/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("false");
      return;
    }

    const table = path.startsWith("/rest/v1/") ? decodeURIComponent(path.slice("/rest/v1/".length)) : "";
    if (!table) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    const bucket = (tables[table] ??= []);

    if (method === "HEAD") {
      res.writeHead(200, { "content-range": `0-0/${bucket.length}`, "content-type": "application/json" });
      res.end();
      return;
    }

    if (method === "GET") {
      const rows = applyQuery(bucket, url.searchParams);
      const wantsObject = (req.headers.accept ?? "").includes("application/vnd.pgrst.object");
      if (wantsObject) {
        if (rows.length !== 1) {
          res.writeHead(406, { "content-type": "application/json" });
          res.end(JSON.stringify({ code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(rows[0]));
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "content-range": `0-${Math.max(rows.length - 1, 0)}/${rows.length}` });
      res.end(JSON.stringify(rows));
      return;
    }

    mutations.push({ method, table });
    let stored: Row[] = [];
    if (method === "POST") {
      const parsed = rawBody ? JSON.parse(rawBody) : [];
      const incoming = Array.isArray(parsed) ? parsed : [parsed];
      for (const row of incoming) {
        const copy = { ...row };
        bucket.push(copy);
        stored.push(copy);
      }
    } else if (method === "PATCH" || method === "DELETE") {
      stored = applyQuery(bucket, url.searchParams);
      if (method === "DELETE") {
        for (const row of stored) {
          const index = bucket.indexOf(row);
          if (index >= 0) bucket.splice(index, 1);
        }
      } else if (rawBody) {
        const patch = JSON.parse(rawBody) as Row;
        for (const row of stored) Object.assign(row, patch);
      }
    }
    const wantsObject = (req.headers.accept ?? "").includes("application/vnd.pgrst.object");
    res.writeHead(method === "POST" ? 201 : 200, { "content-type": "application/json" });
    if (wantsObject) res.end(JSON.stringify(stored[0] ?? null));
    else res.end(JSON.stringify(stored));
  });
  return listen(server).then((port) => ({
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }));
}

function startSmtp(delivered: { to: string; data: string }[]): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((socket) => {
    let buffer = "";
    let mode: "command" | "data" = "command";
    let authStep = 0;
    let to = "";
    socket.write("220 localhost ESMTP ready\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (mode === "data") {
        const end = buffer.indexOf("\r\n.\r\n");
        if (end === -1) return;
        delivered.push({ to, data: buffer.slice(0, end) });
        buffer = buffer.slice(end + 5);
        mode = "command";
        socket.write("250 OK\r\n");
      }
      while (mode === "command" && buffer.includes("\r\n")) {
        const end = buffer.indexOf("\r\n");
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const upper = line.toUpperCase();
        if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
          socket.write("250-localhost\r\n250 AUTH LOGIN PLAIN\r\n");
        } else if (upper.startsWith("AUTH PLAIN")) {
          socket.write("235 Accepted\r\n");
        } else if (upper.startsWith("AUTH LOGIN")) {
          authStep = 1;
          socket.write("334 VXNlcm5hbWU6\r\n");
        } else if (authStep === 1) {
          authStep = 2;
          socket.write("334 UGFzc3dvcmQ6\r\n");
        } else if (authStep === 2) {
          authStep = 0;
          socket.write("235 Accepted\r\n");
        } else if (upper.startsWith("MAIL FROM")) {
          socket.write("250 OK\r\n");
        } else if (upper.startsWith("RCPT TO")) {
          to = line.match(/<([^>]+)>/)?.[1] ?? "";
          socket.write("250 OK\r\n");
        } else if (upper === "DATA") {
          mode = "data";
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (upper === "QUIT") {
          socket.write("221 Bye\r\n");
          socket.end();
        } else if (upper.startsWith("STARTTLS")) {
          socket.write("454 TLS not available\r\n");
        } else if (upper === "RSET" || upper === "NOOP") {
          socket.write("250 OK\r\n");
        } else {
          socket.write("250 OK\r\n");
        }
      }
    });
  });
  return listen(server).then((port) => ({
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }));
}

function startTcpSink(connections: { count: number }): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((socket) => {
    connections.count += 1;
    socket.destroy();
  });
  return listen(server).then((port) => ({
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }));
}

function installFetchGuard(outbound: string[]) {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    const hostname = new URL(url).hostname;
    if (hostname === "127.0.0.1" || hostname === "localhost") {
      return originalFetch(input, init);
    }
    outbound.push(url);
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  };
}

function markers(body: string) {
  return {
    includesName: body.includes("Averyquill"),
    includesRole: body.includes(APPLICANT_ROLE),
    includesCompany: body.includes(APPLICANT_COMPANY),
    includesRationale: body.includes(APPLICANT_WHY),
    includesProfile: body.includes(PROFILE_URL),
    includesJob: body.includes(JOB_TITLE),
  };
}

async function callRoute(
  handler: (request: import("next/server").NextRequest) => Promise<Response>,
  path: string,
  authorization?: string,
) {
  const { NextRequest } = await import("next/server");
  const headers = new Headers({ accept: "application/json" });
  if (authorization !== undefined) headers.set("authorization", authorization);
  const response = await handler(new NextRequest(`http://127.0.0.1${path}`, { headers }));
  const body = await response.text();
  return { status: response.status, body, ...markers(body) };
}

async function loadRoutes() {
  const [summary, reanalyze, reconcile, migrate, batches, backfill, radar] = await Promise.all([
    import("../../src/app/api/cron/daily-summary/route"),
    import("../../src/app/api/cron/reanalyze/route"),
    import("../../src/app/api/cron/reconcile/route"),
    import("../../src/app/api/cron/migrate/route"),
    import("../../src/app/api/cron/analysis-batches/route"),
    import("../../src/app/api/cron/backfill-resumes/route"),
    import("../../src/app/api/cron/radar-enrich/route"),
  ]);
  return [
    { path: "/api/cron/daily-summary?dry=1&hours=168", handler: summary.GET, name: "daily-summary-dry" },
    { path: `/api/cron/daily-summary?hours=24&to=${encodeURIComponent(OUTSIDER)}`, handler: summary.GET, name: "daily-summary-send" },
    { path: `/api/cron/reanalyze?job=${JOB_SHORTCODE}&limit=1&budgetMs=1000`, handler: reanalyze.GET, name: "reanalyze" },
    { path: "/api/cron/reconcile", handler: reconcile.GET, name: "reconcile" },
    { path: "/api/cron/migrate", handler: migrate.GET, name: "migrate" },
    { path: "/api/cron/analysis-batches", handler: batches.GET, name: "analysis-batches" },
    { path: "/api/cron/backfill-resumes", handler: backfill.GET, name: "backfill-resumes" },
    { path: "/api/cron/radar-enrich", handler: radar.GET, name: "radar-enrich" },
  ];
}

async function runRoutes(authorization?: string) {
  const routes = await loadRoutes();
  const results = [];
  for (const route of routes) {
    try {
      const result = await callRoute(route.handler, route.path, authorization);
      results.push({ name: route.name, path: route.path, ...result });
    } catch (error) {
      results.push({
        name: route.name,
        path: route.path,
        status: 0,
        body: error instanceof Error ? error.message : String(error),
        includesName: false,
        includesRole: false,
        includesCompany: false,
        includesRationale: false,
        includesProfile: false,
        includesJob: false,
      });
    }
  }
  return results;
}

async function runMiddleware() {
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = buildPublishableKey("example.com");
  process.env.CLERK_SECRET_KEY = "placeholder-not-a-real-clerk-secret";
  process.env.NEXT_PUBLIC_CLERK_TELEMETRY_DISABLED = "true";
  process.env.NEXT_PUBLIC_CLERK_KEYLESS_DISABLED = "true";
  const [{ unstable_doesMiddlewareMatch }, middlewareModule, { NextRequest }] = await Promise.all([
    import("next/experimental/testing/server"),
    import("../../src/middleware"),
    import("next/server"),
  ]);
  const matcher = middlewareModule.config;
  const cronPaths = [
    "/api/cron/daily-summary",
    "/api/cron/reanalyze",
    "/api/cron/reconcile",
    "/api/cron/migrate",
    "/api/cron/analysis-batches",
    "/api/cron/backfill-resumes",
    "/api/cron/radar-enrich",
  ];
  const matched = Object.fromEntries(
    cronPaths.map((pathname) => [
      pathname,
      unstable_doesMiddlewareMatch({
        config: matcher,
        url: `http://127.0.0.1${pathname}`,
        headers: { accept: "application/json" },
      }),
    ]),
  );
  const middleware = middlewareModule.default;
  async function invoke(pathname: string) {
    const request = new NextRequest(`http://127.0.0.1${pathname}`, {
      headers: { accept: "application/json" },
    });
    const response = await middleware(request, { waitUntil() {} });
    return {
      status: response?.status ?? null,
      location: response?.headers.get("location") ?? null,
      rewrite: response?.headers.get("x-middleware-rewrite") ?? null,
      next: response?.headers.get("x-middleware-next") ?? null,
    };
  }
  return {
    matched,
    cron: await invoke("/api/cron/daily-summary"),
    guarded: await invoke("/candidates"),
  };
}

async function main() {
  const scenario = process.argv[2] ?? "open";
  if (scenario === "middleware") {
    process.stdout.write(JSON.stringify(await runMiddleware()));
    return;
  }

  const mutations: Mutation[] = [];
  const delivered: { to: string; data: string }[] = [];
  const connections = { count: 0 };
  const outbound: string[] = [];
  installFetchGuard(outbound);
  const [postgrest, smtp, tcp] = await Promise.all([
    startPostgrest(mutations),
    startSmtp(delivered),
    startTcpSink(connections),
  ]);

  delete process.env.CRON_SECRET;
  process.env.SUPABASE_URL = `http://127.0.0.1:${postgrest.port}`;
  process.env.SUPABASE_SERVICE_KEY = "placeholder-service-key";
  process.env.DATABASE_URL = `postgresql://placeholder:placeholder@127.0.0.1:${tcp.port}/placeholder`;
  delete process.env.SUPABASE_DB_URL;
  process.env.SMTP_HOST = "127.0.0.1";
  process.env.SMTP_PORT = String(smtp.port);
  process.env.SMTP_USER = "summary-sender@example.com";
  process.env.SMTP_PASS = "placeholder-smtp-pass";
  process.env.SUMMARY_EMAIL_FROM = "RDIRecruit <summary-sender@example.com>";
  process.env.SUMMARY_EMAIL_TO = "recruiter@example.com";
  process.env.ANTHROPIC_API_KEY = "placeholder-not-a-real-anthropic-key";
  process.env.WORKABLE_TOKEN = "placeholder-not-a-real-workable-token";
  process.env.WORKABLE_SUBDOMAIN = "rditrials";
  delete process.env.WORKABLE_API_KEY;

  if (scenario === "empty") process.env.CRON_SECRET = "";
  if (scenario === "closed" || scenario === "reread") process.env.CRON_SECRET = SECRET_PLACEHOLDER;

  const routes = await loadRoutes();
  if (scenario === "reread") delete process.env.CRON_SECRET;

  let authorization: string | undefined;
  let second: Awaited<ReturnType<typeof callRoute>> | undefined;
  if (scenario === "closed") {
    const wrong = await runRoutes(`Bearer ${SECRET_PLACEHOLDER}-wrong`);
    const afterWrong = {
      delivered: delivered.length,
      tcpConnections: connections.count,
      mutations: mutations.length,
      outbound: outbound.length,
    };
    const right = await runRoutes(`Bearer ${SECRET_PLACEHOLDER}`);
    const payload = {
      wrong,
      afterWrong,
      right,
      delivered: delivered.map((message) => ({ to: message.to, ...markers(message.data) })),
      tcpConnections: connections.count,
      mutations,
      outbound,
    };
    process.stdout.write(JSON.stringify(payload));
    await Promise.all([postgrest.close(), smtp.close(), tcp.close()]);
    return;
  }
  if (scenario === "blank-bearer") authorization = "Bearer ";

  const results = await runRoutes(authorization);
  if (scenario === "open") {
    second = await callRoute(routes[0]!.handler, "/api/cron/daily-summary?dry=1&hours=168", "Bearer undefined");
  }

  process.stdout.write(
    JSON.stringify({
      routes: results,
      alternateBearer: second ?? null,
      delivered: delivered.map((message) => ({ to: message.to, ...markers(message.data) })),
      tcpConnections: connections.count,
      mutations,
      outbound,
    }),
  );
  await Promise.all([postgrest.close(), smtp.close(), tcp.close()]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
