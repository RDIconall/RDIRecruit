/**
 * Score evidence is grading material: the claim, the verbatim quote, the
 * source reference, and the storage path of a capture. These tests exercise
 * the Data API as the anon and authenticated roles, then the capture route
 * that signs whatever path is stored on the row.
 *
 * They fail while that evidence is readable or writable by those roles, or
 * while the capture route returns it. A fix keeps service-role writes and
 * refuses capture paths the scoring ingest did not write.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JWT_SECRET = "test-jwt-secret-placeholder-not-a-real-key";
const DB_PASSWORD = "placeholder";
const DB_NAME = "score_evidence_test";
const POSTGREST = process.env.POSTGREST_BIN ?? "/tmp/postgrest-bin/postgrest";
const QUOTE = "verbatim-grade-quote";
const CLAIM = "owns the study startup";
const SOURCE = "resume:bullet-2";
const POISONED_PATH = "cand_victim/resume.pdf";
const SWAPPED_PATH = "cand_other/resume.pdf";
const SCORE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CAPTURE_ROW = "44444444-4444-4444-8444-444444444444";

const STORED_OBJECTS = new Set([POISONED_PATH, SWAPPED_PATH]);

function signJwt(role: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(
    JSON.stringify({ role, iss: "supabase-test", iat: now, exp: now + 60 * 60 }),
  ).toString("base64url");
  const signature = createHmac("sha256", JWT_SECRET).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

function roleFromAuthorization(header: string | undefined): string | null {
  const token = header?.replace(/^Bearer\s+/i, "");
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { role?: string };
    const expected = createHmac("sha256", JWT_SECRET)
      .update(token!.split(".").slice(0, 2).join("."))
      .digest("base64url");
    if (expected !== token!.split(".")[2]) return null;
    return claims.role ?? null;
  } catch {
    return null;
  }
}

function psql(database: string, sql: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("sudo", ["-u", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-d", database, "-f", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `psql exited ${code}`));
    });
    child.stdin.end(sql);
  });
}

async function bootstrapDatabase() {
  await psql(
    "postgres",
    `
    do $$ begin
      create role anon nologin noinherit;
    exception when duplicate_object then null; end $$;
    do $$ begin
      create role authenticated nologin noinherit;
    exception when duplicate_object then null; end $$;
    do $$ begin
      create role service_role nologin noinherit bypassrls;
    exception when duplicate_object then null; end $$;
    do $$ begin
      create role authenticator noinherit login password '${DB_PASSWORD}';
    exception when duplicate_object then null; end $$;
    alter role authenticator with login password '${DB_PASSWORD}' noinherit;
    grant anon, authenticated, service_role to authenticator;
    select pg_terminate_backend(pid) from pg_stat_activity where datname = '${DB_NAME}' and pid <> pg_backend_pid();
    drop database if exists ${DB_NAME};
    create database ${DB_NAME} owner postgres;
    `,
  );

  // Same grants the Supabase init script applies when migrate.sh runs it as
  // postgres, before this app's migration creates public tables.
  await psql(
    DB_NAME,
    `
    grant usage on schema public to postgres, anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to postgres, anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to postgres, anon, authenticated, service_role;
    `,
  );
  await psql(DB_NAME, fs.readFileSync(path.join(root, "supabase/migrations/001_initial_schema.sql"), "utf8"));
  await psql(
    DB_NAME,
    `
    insert into candidates (workable_id, name) values ('cand_victim', 'Victim Applicant');
    insert into scores (id, candidate_id, rubric_version, category_scores, total)
    values ('${SCORE_ID}', 'cand_victim', 1, '{}'::jsonb, 0);
    insert into score_inputs (id, score_id, claim, quote, source_ref, capture_kind, capture_path, capture_status)
    values
      ('11111111-1111-4111-8111-111111111111', '${SCORE_ID}', '${CLAIM}', '${QUOTE}', '${SOURCE}', 'text_card', null, 'ready'),
      ('22222222-2222-4222-8222-222222222222', '${SCORE_ID}', '${CLAIM}', '${QUOTE}', '${SOURCE}', 'text_card', null, 'ready'),
      ('33333333-3333-4333-8333-333333333333', '${SCORE_ID}', '${CLAIM}', '${QUOTE}', '${SOURCE}', 'text_card', null, 'ready'),
      ('${CAPTURE_ROW}', '${SCORE_ID}', '${CLAIM}', '${QUOTE}', '${SOURCE}', 'text_card', '${POISONED_PATH}', 'ready'),
      ('66666666-6666-4666-8666-666666666666', '${SCORE_ID}', '${CLAIM}', '${QUOTE}', '${SOURCE}', 'text_card', null, 'ready'),
      ('77777777-7777-4777-8777-777777777777', '${SCORE_ID}', '${CLAIM}', '${QUOTE}', '${SOURCE}', 'text_card', null, 'ready');
    `,
  );
}

function startPostgrest(port: number): ChildProcess {
  const config = path.join("/tmp", `score-evidence-postgrest-${port}.conf`);
  fs.writeFileSync(
    config,
    [
      `db-uri = "postgres://authenticator:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}"`,
      `db-schemas = "public"`,
      `db-anon-role = "anon"`,
      `jwt-secret = "${JWT_SECRET}"`,
      `server-host = "127.0.0.1"`,
      `server-port = ${port}`,
    ].join("\n"),
  );
  return spawn(POSTGREST, [config], { stdio: ["ignore", "pipe", "pipe"] });
}

async function waitForPort(port: number) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok || response.status === 401) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`postgrest did not listen on ${port}`);
}

function startGateway(postgrestPort: number) {
  let scoreInputReads = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/storage/v1/object/sign/")) {
      void handleSign(req, res, url);
      return;
    }
    if (url.pathname.startsWith("/rest/v1/")) {
      void handleRest(req, res, url, postgrestPort, () => {
        scoreInputReads += 1;
        return scoreInputReads;
      });
      return;
    }
    res.writeHead(404).end();
  });
  return server;
}

function handleSign(req: IncomingMessage, res: ServerResponse, url: URL) {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const role = roleFromAuthorization(req.headers.authorization);
    if (role !== "service_role") {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "forbidden" }));
      return;
    }
    const prefix = "/storage/v1/object/sign/captures/";
    const objectName = decodeURIComponent(url.pathname.slice(prefix.length));
    if (!STORED_OBJECTS.has(objectName)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "object not found" }));
      return;
    }
    const expiresIn = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}").expiresIn;
    if (expiresIn !== 3600) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "unexpected expiry" }));
      return;
    }
    const urlToSign = `captures/${objectName}`;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ signedURL: `/object/sign/${urlToSign}?token=signed-for-test` }));
  });
}

function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  postgrestPort: number,
  nextRead: () => number,
) {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const forward = () => {
      const upstream = httpRequest(
        {
          hostname: "127.0.0.1",
          port: postgrestPort,
          method: req.method,
          path: `${url.pathname.replace(/^\/rest\/v1/, "")}${url.search}`,
          headers: { ...req.headers, host: `127.0.0.1:${postgrestPort}` },
        },
        (upstreamResponse) => {
          res.writeHead(upstreamResponse.statusCode ?? 500, upstreamResponse.headers);
          upstreamResponse.pipe(res);
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502).end();
      });
      upstream.end(body);
    };

    const isCaptureRowRead =
      req.method === "GET" &&
      url.pathname === "/rest/v1/score_inputs" &&
      url.search.includes(CAPTURE_ROW);
    if (!isCaptureRowRead) {
      forward();
      return;
    }
    const readNumber = nextRead();
    if (readNumber < 2) {
      forward();
      return;
    }
    // A later read of the same row sees a different stored path, so a check
    // that looks the path up again still has to refuse the path it signs.
    psql(DB_NAME, `update score_inputs set capture_path = '${SWAPPED_PATH}' where id = '${CAPTURE_ROW}';`)
      .then(forward)
      .catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
  });
}

test("score evidence stays off the Data API and the capture route does not sign attacker paths", async () => {
  if (!fs.existsSync(POSTGREST)) {
    const archive = "/tmp/postgrest-v14.18-linux-static-x86-64.tar.xz";
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "curl",
        ["-fsSL", "-o", archive, "https://github.com/PostgREST/postgrest/releases/download/v14.18/postgrest-v14.18-linux-static-x86-64.tar.xz"],
        { stdio: "inherit" },
      );
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`curl exited ${code}`))));
    });
    fs.mkdirSync("/tmp/postgrest-bin", { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const child = spawn("tar", ["-C", "/tmp/postgrest-bin", "-xJf", archive], { stdio: "inherit" });
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))));
    });
  }
  assert.ok(fs.existsSync(POSTGREST), `postgrest binary missing at ${POSTGREST}`);
  await bootstrapDatabase();
  const postgrestPort = 54321;
  const postgrest = startPostgrest(postgrestPort);
  let postgrestLog = "";
  postgrest.stderr?.on("data", (chunk) => {
    postgrestLog += chunk.toString();
  });
  const gateway = startGateway(postgrestPort);
  try {
    await waitForPort(postgrestPort);
    gateway.listen(0, "127.0.0.1");
    await once(gateway, "listening");
    const address = gateway.address();
    if (!address || typeof address === "string") throw new Error("gateway did not bind");
    const child = spawn(process.execPath, ["--import", "tsx", path.join(root, "tests/score-evidence-access.child.ts")], {
      cwd: root,
      env: {
        ...process.env,
        SUPABASE_URL: `http://127.0.0.1:${address.port}`,
        SUPABASE_SERVICE_KEY: signJwt("service_role"),
        ANON_JWT: signJwt("anon"),
        AUTHENTICATED_JWT: signJwt("authenticated"),
        SCORE_ID,
      },
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });
    const [code] = (await once(child, "exit")) as [number | null];
    assert.equal(code, 0, output || postgrestLog);
  } finally {
    gateway.close();
    postgrest.kill();
  }
});
