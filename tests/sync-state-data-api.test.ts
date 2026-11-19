/**
 * Spec for the sync_state Data API finding.
 *
 * These tests describe the safe behavior. They fail while sync_state is writable
 * by the Data API roles and while the reconcile trusts a cursor or scoring epoch
 * that the application did not write.
 *
 * Run:
 *   POSTGREST_BIN=/path/to/postgrest-14.5 \
 *     npx tsx --conditions=react-server --test tests/sync-state-data-api.test.ts
 *
 * Needs local PostgreSQL (the `postgres` role, password via POSTGRES_PASSWORD,
 * default `postgres-test-password`) and PostgREST 14.5, the version pinned by
 * supabase CLI 2.106.0 (`packages/stack/src/versions.ts`).
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import pg from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD ?? "postgres-test-password";
const JWT_SECRET = "test-jwt-secret-placeholder-not-a-real-key";
const AUTHENTICATOR_PASSWORD = "authenticator-test-password";
const DB_NAME = "sync_cursor_test";
const POSTGREST_PORT = 3210;
const GATEWAY_PORT = 3211;
const FUTURE_CURSOR = "2099-01-01T00:00:00.000Z";
const JOB = "JOBGAP";
const GAP_CANDIDATE = "cand-gap";
const STALE_CANDIDATE = "cand-stale";
const GAP_UPDATED_AT = "2026-11-18T12:00:00.000Z";

process.env.SUPABASE_URL = `http://127.0.0.1:${GATEWAY_PORT}`;
process.env.WORKABLE_TOKEN = "test-workable-token";
process.env.WORKABLE_SUBDOMAIN = "rditrials";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.SUPABASE_SERVICE_KEY = signJwt("service_role");
process.env.SUPABASE_ANON_KEY = signJwt("anon");

interface WorkableJob {
  id: string;
  title: string;
  shortcode: string;
  state: string;
  department: string;
  url: string;
  application_url: string;
  shortlink: string;
  location: { location_str: string };
  created_at: string;
  updated_at: string;
  full_description?: string;
}

interface WorkableCandidate {
  id: string;
  name: string;
  firstname: string;
  lastname: string;
  headline: string;
  account: { subdomain: string; name: string };
  job: { shortcode: string; title: string };
  stage: string;
  disqualified: boolean;
  disqualification_reason: string | null;
  hired_at: string | null;
  sourced: boolean;
  profile_url: string;
  address: string;
  phone: string;
  email: string;
  created_at: string;
  updated_at: string;
  experience_entries: Array<{
    title: string;
    company: string;
    industry: string;
    start_date: string;
    end_date: string;
    summary: string;
  }>;
  education_entries: never[];
  answers: never[];
}

const board = {
  jobs: [] as WorkableJob[],
  candidates: [] as WorkableCandidate[],
  candidateQueries: [] as string[],
};

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = requestUrl(input);
  if (url.hostname.endsWith(".workable.com")) return workableResponse(url);
  if (url.hostname === "api.anthropic.com") return anthropicResponse(url, init);
  return realFetch(input, init);
};

function signJwt(role: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      role,
      iss: "supabase-test",
      exp: Math.floor(Date.now() / 1000) + 60 * 60,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", JWT_SECRET).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

function requestUrl(input: RequestInfo | URL): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Workable SPI list filter from the published job-candidates reference:
 * `updated_after` "Returns results updated after the specified timestamp."
 * A timestamp later than every candidate therefore yields an empty 200 collection.
 */
function workableResponse(url: URL): Response {
  const pathname = url.pathname;
  if (pathname.endsWith("/candidates")) {
    board.candidateQueries.push(url.search);
    const updatedAfter = url.searchParams.get("updated_after");
    const cutoff = updatedAfter ? Date.parse(updatedAfter) : null;
    const candidates = board.candidates.filter((candidate) => {
      if (cutoff == null || Number.isNaN(cutoff)) return true;
      return Date.parse(candidate.updated_at) > cutoff;
    });
    return jsonResponse({ candidates });
  }
  const jobMatch = pathname.match(/\/jobs\/([^/]+)$/);
  if (jobMatch) {
    const job = board.jobs.find((row) => row.shortcode === decodeURIComponent(jobMatch[1]));
    if (!job) return jsonResponse({ error: "Not found" }, 404);
    return jsonResponse(job);
  }
  if (pathname.endsWith("/jobs")) {
    const state = url.searchParams.get("state");
    const jobs = board.jobs.filter((job) => !state || job.state === state);
    return jsonResponse({ jobs });
  }
  return jsonResponse({ error: "Not found" }, 404);
}

function anthropicResponse(url: URL, init?: RequestInit): Response {
  if (url.pathname === "/v1/messages/batches" && (init?.method ?? "GET") === "POST") {
    const now = new Date();
    return jsonResponse({
      id: "msgbatch_test_placeholder",
      type: "message_batch",
      processing_status: "in_progress",
      request_counts: { processing: 1, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
      ended_at: null,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 86_400_000).toISOString(),
      archived_at: null,
      cancel_initiated_at: null,
      results_url: null,
    });
  }
  if (url.pathname === "/v1/messages/batches") {
    return jsonResponse({ data: [], has_more: false, first_id: null, last_id: null });
  }
  return jsonResponse({ error: { type: "not_found", message: "unhandled test request" } }, 404);
}

function gapJob(): WorkableJob {
  return {
    id: "job-gap",
    title: "Operator",
    shortcode: JOB,
    state: "published",
    department: "Operations",
    url: "https://example.test/jobs/JOBGAP",
    application_url: "https://example.test/apply/JOBGAP",
    shortlink: "https://example.test/j/JOBGAP",
    location: { location_str: "Van Nuys, CA" },
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-11-01T00:00:00.000Z",
    full_description: "<p>Own study delivery and keep the operation moving without the founder in the loop.</p>",
  };
}

function gapCandidate(): WorkableCandidate {
  return {
    id: GAP_CANDIDATE,
    name: "Gap Applicant",
    firstname: "Gap",
    lastname: "Applicant",
    headline: "Operator",
    account: { subdomain: "rditrials", name: "RDI" },
    job: { shortcode: JOB, title: "Operator" },
    stage: "applied",
    disqualified: false,
    disqualification_reason: null,
    hired_at: null,
    sourced: false,
    profile_url: "https://example.test/candidates/cand-gap",
    address: "",
    phone: "",
    email: "gap@example.test",
    created_at: GAP_UPDATED_AT,
    updated_at: GAP_UPDATED_AT,
    experience_entries: [
      {
        title: "Operator",
        company: "Example Clinic",
        industry: "Clinical",
        start_date: "2020-01-01",
        end_date: "2026-01-01",
        summary: "Owned delivery of a multi-site study from startup through closeout.",
      },
    ],
    education_entries: [],
    answers: [],
  };
}

let admin: pg.Client;
let postgrest: ChildProcess | null = null;
let gateway: ReturnType<typeof createServer> | null = null;
let service: SupabaseClient;
let app: {
  incrementalSync: (mode?: "incremental" | "daily" | "full") => Promise<{ candidatesSynced: number }>;
  scoreUnscoredAcrossJobs: (options?: { budgetMs?: number }) => Promise<unknown>;
  bumpScoringEpoch: (scope: string) => Promise<void>;
  getAnonSupabase: () => SupabaseClient;
};

async function adminQuery(sql: string, params?: unknown[]) {
  return admin.query(sql, params);
}

async function syncValue(key: string): Promise<unknown> {
  const { rows } = await adminQuery("select value from public.sync_state where key = $1", [key]);
  return rows[0]?.value ?? null;
}

function dataClient(role: "anon" | "authenticated"): SupabaseClient {
  return createClient(process.env.SUPABASE_URL!, signJwt(role), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function assertWriteRejected(
  role: "anon" | "authenticated",
  action: "insert" | "update" | "delete",
  key: string,
  before: unknown,
) {
  const client = dataClient(role);
  let result;
  if (action === "insert") {
    result = await client.from("sync_state").insert({ key, value: { at: FUTURE_CURSOR } });
  } else if (action === "update") {
    result = await client.from("sync_state").update({ value: { at: FUTURE_CURSOR } }).eq("key", key);
  } else {
    result = await client.from("sync_state").delete().eq("key", key);
  }
  assert.deepEqual(await syncValue(key), before, `${role} ${action} must not change ${key}`);
  assert.ok(result.error, `${role} ${action} on sync_state should be rejected`);
}

async function setupDatabase() {
  const bootstrap = new pg.Client({
    host: "127.0.0.1",
    user: "postgres",
    password: POSTGRES_PASSWORD,
    database: "postgres",
  });
  await bootstrap.connect();
  await bootstrap.query(
    `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
    [DB_NAME],
  );
  await bootstrap.query(`drop database if exists ${DB_NAME}`);
  await bootstrap.query(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then
        create role anon nologin noinherit;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then
        create role authenticated nologin noinherit;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then
        create role service_role nologin noinherit bypassrls;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticator') then
        create role authenticator noinherit login password '${AUTHENTICATOR_PASSWORD}';
      end if;
    end $$;
  `);
  await bootstrap.query(`grant anon to authenticator`);
  await bootstrap.query(`grant authenticated to authenticator`);
  await bootstrap.query(`grant service_role to authenticator`);
  await bootstrap.query(`create database ${DB_NAME} owner postgres`);
  await bootstrap.query(`grant connect on database ${DB_NAME} to authenticator`);
  await bootstrap.end();

  admin = new pg.Client({
    host: "127.0.0.1",
    user: "postgres",
    password: POSTGRES_PASSWORD,
    database: DB_NAME,
  });
  await admin.connect();

  // Supabase Postgres 17.6.1.107 init script, run as the same role that applies
  // migrations. On the image that role is `postgres`, and nix/tests/expected/roles.out
  // records the resulting default INSERT/UPDATE for anon.
  await admin.query(`
    create schema if not exists storage;
    create table if not exists storage.buckets (
      id text primary key,
      name text,
      public boolean
    );
    grant usage on schema public to postgres, anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to postgres, anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to postgres, anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to postgres, anon, authenticated, service_role;
    grant usage on schema storage to postgres, anon, authenticated, service_role;
  `);

  const migrationsDir = path.join(process.cwd(), "supabase", "migrations");
  const files = fs.readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    await admin.query(sql);
  }
}

async function startPostgrest() {
  const bin = process.env.POSTGREST_BIN ?? "postgrest";
  const configPath = path.join("/tmp", "sync-state-postgrest.conf");
  fs.writeFileSync(
    configPath,
    [
      `db-uri = "postgresql://authenticator:${AUTHENTICATOR_PASSWORD}@127.0.0.1:5432/${DB_NAME}"`,
      `db-schemas = "public"`,
      `db-anon-role = "anon"`,
      `jwt-secret = "${JWT_SECRET}"`,
      `jwt-role-claim-key = ".role"`,
      `server-port = ${POSTGREST_PORT}`,
      `server-host = "127.0.0.1"`,
    ].join("\n"),
  );
  postgrest = spawn(bin, [configPath], { stdio: "ignore" });
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await realFetch(`http://127.0.0.1:${POSTGREST_PORT}/`);
      if (response.ok || response.status === 404) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`PostgREST did not start: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function startGateway() {
  gateway = createServer((req: IncomingMessage, res: ServerResponse) => {
    const incoming = new URL(req.url ?? "/", "http://127.0.0.1");
    let pathname = incoming.pathname;
    if (pathname.startsWith("/rest/v1")) pathname = pathname.slice("/rest/v1".length) || "/";
    const headers = { ...req.headers, host: `127.0.0.1:${POSTGREST_PORT}` };
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: POSTGREST_PORT,
        path: `${pathname}${incoming.search}`,
        method: req.method,
        headers,
      },
      (upstreamResponse) => {
        res.writeHead(upstreamResponse.statusCode ?? 500, upstreamResponse.headers);
        upstreamResponse.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.statusCode = 502;
      res.end();
    });
    req.pipe(upstream);
  });
  gateway.listen(GATEWAY_PORT, "127.0.0.1");
  await once(gateway, "listening");
}

async function resetBoard() {
  board.jobs = [gapJob()];
  board.candidates = [gapCandidate()];
  board.candidateQueries = [];
  await adminQuery(`delete from public.candidate_analyses`);
  await adminQuery(`delete from public.claude_batches`);
  await adminQuery(`delete from public.evaluations`);
  await adminQuery(`delete from public.applications`);
  await adminQuery(`delete from public.candidates`);
  await adminQuery(`delete from public.jobs`);
  await adminQuery(`delete from public.sync_state where key like 'scoring_epoch:%' or key = 'last_delta_scan' or key = 'scoring_lock'`);
  await adminQuery(`
    insert into public.jobs (shortcode, title, status, raw, synced_at)
    values ($1, 'Operator', 'published', $2::jsonb, now())
  `, [JOB, JSON.stringify({ full_description: gapJob().full_description })]);
}

test.before(async () => {
  await setupDatabase();
  await startPostgrest();
  await startGateway();
  const sync = await import("../src/lib/sync/incremental-sync.ts");
  const workable = await import("../src/lib/sync/workable-sync.ts");
  const calibration = await import("../src/lib/calibration/service.ts");
  const supabase = await import("../src/lib/supabase/server.ts");
  app = {
    incrementalSync: sync.incrementalSync,
    scoreUnscoredAcrossJobs: workable.scoreUnscoredAcrossJobs,
    bumpScoringEpoch: calibration.bumpScoringEpoch,
    getAnonSupabase: supabase.getAnonSupabase,
  };
  service = supabase.getServiceSupabase();
});

test.after(async () => {
  gateway?.close();
  postgrest?.kill();
  await admin?.end().catch(() => undefined);
});

test("anon and authenticated Data API clients cannot insert, update, or delete sync_state", async () => {
  await adminQuery(
    `insert into public.sync_state (key, value) values ('last_delta_scan', '{"at":"2026-11-01T00:00:00.000Z"}'::jsonb)
     on conflict (key) do update set value = excluded.value`,
  );
  const before = await syncValue("last_delta_scan");
  for (const role of ["anon", "authenticated"] as const) {
    await assertWriteRejected(role, "update", "last_delta_scan", before);
    await assertWriteRejected(role, "delete", "last_delta_scan", before);
    await assertWriteRejected(role, "insert", `attacker-${role}`, null);
    const upsert = await dataClient(role)
      .from("sync_state")
      .upsert({ key: "last_delta_scan", value: { at: FUTURE_CURSOR } });
    assert.deepEqual(await syncValue("last_delta_scan"), before, `${role} upsert must not move last_delta_scan`);
    assert.ok(upsert.error, `${role} upsert should be rejected`);
    const epoch = await dataClient(role)
      .from("sync_state")
      .upsert({ key: "scoring_epoch:global", value: { at: new Date().toISOString() } });
    assert.equal(await syncValue("scoring_epoch:global"), null);
    assert.ok(epoch.error, `${role} scoring epoch upsert should be rejected`);
  }

  // The product anon helper uses the same client constructor.
  const productAnon = app.getAnonSupabase();
  const viaHelper = await productAnon
    .from("sync_state")
    .upsert({ key: "last_delta_scan", value: { at: FUTURE_CURSOR } });
  assert.deepEqual(await syncValue("last_delta_scan"), before);
  assert.ok(viaHelper.error);
});

test("the service role sync path can still write sync_state", async () => {
  const written = await service
    .from("sync_state")
    .upsert({ key: "last_delta_scan", value: { at: "2026-11-01T00:00:00.000Z" } })
    .select("key");
  assert.equal(written.error, null);
  assert.equal((await syncValue("last_delta_scan") as { at: string }).at, "2026-11-01T00:00:00.000Z");
});

test("a future last_delta_scan does not skip applicants updated before now", async () => {
  await resetBoard();
  await adminQuery(
    `insert into public.sync_state (key, value) values ('last_delta_scan', $1::jsonb)`,
    [JSON.stringify({ at: FUTURE_CURSOR })],
  );

  const result = await app.incrementalSync("daily");
  const { rows } = await adminQuery(
    `select workable_id from public.candidates where workable_id = $1`,
    [GAP_CANDIDATE],
  );
  assert.equal(
    rows.length,
    1,
    `reconcile synced ${result.candidatesSynced} candidates; Workable queries were ${board.candidateQueries.join(" | ") || "(none)"}`,
  );

  const saved = (await syncValue("last_delta_scan")) as { at?: string } | null;
  assert.ok(saved?.at, "cursor should remain a timestamp");
  assert.ok(
    Date.parse(saved.at) >= Date.parse(GAP_UPDATED_AT),
    "a scan that mirrored the gap may record a cursor at or after that applicant",
  );
  assert.ok(Date.parse(saved.at) < Date.parse(FUTURE_CURSOR), "the poisoned future cursor must not be kept");
});

test("anon cannot move the cursor and then make the next reconcile skip the gap", async () => {
  await resetBoard();
  const honest = "2026-11-01T00:00:00.000Z";
  await adminQuery(
    `insert into public.sync_state (key, value) values ('last_delta_scan', $1::jsonb)`,
    [JSON.stringify({ at: honest })],
  );
  const attack = await app.getAnonSupabase()
    .from("sync_state")
    .upsert({ key: "last_delta_scan", value: { at: FUTURE_CURSOR } });
  assert.equal((await syncValue("last_delta_scan") as { at: string }).at, honest);
  assert.ok(attack.error, "the Data API write is part of the attack and must fail");

  await app.incrementalSync("daily");
  const { rows } = await adminQuery(
    `select workable_id from public.candidates where workable_id = $1`,
    [GAP_CANDIDATE],
  );
  assert.equal(rows.length, 1);
});

async function seedStaleCandidate() {
  await resetBoard();
  const resume = "Owned study startup, site management, and closeout for a multi-site clinical program.";
  await adminQuery(
    `insert into public.candidates (workable_id, job_shortcode, name, email, stage, disqualified, created_at)
     values ($1, $2, 'Stale Applicant', 'stale@example.test', 'applied', false, '2020-01-01T00:00:00.000Z')`,
    [STALE_CANDIDATE, JOB],
  );
  await adminQuery(
    `insert into public.applications (candidate_id, answers, resume_text, parsed_experience)
     values ($1, '{}'::jsonb, $2, $3::jsonb)`,
    [
      STALE_CANDIDATE,
      resume,
      JSON.stringify([
        { title: "Operator", company: "Example Clinic", start: "2020-01-01", end: "2024-01-01", summary: resume },
      ]),
    ],
  );
  await adminQuery(
    `insert into public.evaluations (candidate_id, kind, payload, model_version, created_at)
     values ($1, 'fit_read', '{"summary":"prior read"}'::jsonb, 'test-model', '2020-01-02T00:00:00.000Z')`,
    [STALE_CANDIDATE],
  );
}

async function scoringEpochTriggers(): Promise<string[]> {
  const { rows } = await adminQuery(
    `select trigger from public.candidate_analyses where candidate_id = $1 order by requested_at`,
    [STALE_CANDIDATE],
  );
  return rows.map((row) => row.trigger as string);
}

test("a scoring epoch the application did not write does not enqueue replacement scores", async () => {
  await seedStaleCandidate();
  const at = new Date().toISOString();
  await adminQuery(
    `insert into public.sync_state (key, value) values ('scoring_epoch:global', $1::jsonb)`,
    [JSON.stringify({ at })],
  );

  let thrown: unknown;
  try {
    await app.scoreUnscoredAcrossJobs({ budgetMs: 20_000 });
  } catch (error) {
    thrown = error;
  }
  const triggers = await scoringEpochTriggers();
  assert.deepEqual(triggers.filter((trigger) => trigger === "scoring_epoch"), []);
  if (thrown && triggers.length === 0) throw thrown;
});

test("bumpScoringEpoch still enqueues a replacement score", async () => {
  await seedStaleCandidate();
  await app.bumpScoringEpoch("global");
  let thrown: unknown;
  try {
    await app.scoreUnscoredAcrossJobs({ budgetMs: 20_000 });
  } catch (error) {
    thrown = error;
  }
  const triggers = await scoringEpochTriggers();
  assert.ok(
    triggers.includes("scoring_epoch"),
    `expected an application epoch to enqueue a replacement; triggers=${triggers.join(",") || "(none)"}`,
  );
  if (thrown && !triggers.includes("scoring_epoch")) throw thrown;
});

test("Data API roles cannot claim or release the scoring lock", async () => {
  await resetBoard();
  for (const role of ["anon", "authenticated"] as const) {
    const client = dataClient(role);
    const beforeLock = await syncValue("scoring_lock");
    const claim = await client.rpc("try_acquire_scoring_lock", { ttl_minutes: 6 });
    assert.deepEqual(
      await syncValue("scoring_lock"),
      beforeLock,
      `${role} try_acquire_scoring_lock must not write scoring_lock`,
    );
    assert.ok(claim.error, `${role} try_acquire_scoring_lock should be rejected`);

    const release = await client.rpc("release_scoring_lock");
    assert.deepEqual(await syncValue("scoring_lock"), beforeLock);
    assert.ok(release.error, `${role} release_scoring_lock should be rejected`);
  }
});
