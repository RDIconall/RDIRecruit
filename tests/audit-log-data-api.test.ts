import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import pg from "pg";

/**
 * Data API exposure of public.audit_log.
 *
 * Supabase Postgres 17.6.1.134 (the image pinned by supabase CLI 2.106.0)
 * grants anon, authenticated, and service_role every privilege on tables the
 * postgres role creates in public. See
 * migrations/db/init-scripts/00000000000000-initial-schema.sql lines 29-42
 * and 59-60 in that image. This repo's migrations never revoke those grants
 * and never enable row level security on audit_log. PostgREST v14.13 (the
 * Data API in that CLI) switches into the JWT role with
 * set_config('role', <role>, true) in the same transaction as the query
 * (src/PostgREST/Query/PreQuery.hs:50, src/PostgREST/Query/SqlFragment.hs:557-564,
 * src/PostgREST/MainTx.hs:104-110). The anon key's role claim is "anon"
 * (src/PostgREST/Auth/Jwt.hs:120-128).
 *
 * These tests perform that role switch and then select, insert, update, and
 * delete resume_view / resume_ingest rows. They fail while a Data API role
 * can read or rewrite those rows, and pass once it cannot. The service role
 * must still be able to append, which is how resume ingest and resume view
 * write the log.
 *
 * Same missing RLS, left untested: app_users, calibration, calibration_feedback,
 * events, job_members, job_rubrics, jobs, notifications, ro_assessments,
 * rubrics, score_inputs, scores, sync_state.
 */

const PORT = 55432;
const DATA_API_ROLES = ["anon", "authenticated"] as const;

const bootstrapSql = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create user authenticator noinherit;
grant anon to authenticator;
grant authenticated to authenticator;
grant service_role to authenticator;
grant usage on schema public to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to postgres, anon, authenticated, service_role;
alter role anon set statement_timeout = '3s';
alter role authenticated set statement_timeout = '8s';

-- Migration 002 inserts a storage bucket. The bucket is not the subject of
-- these tests; the table only lets that migration finish.
create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key,
  name text,
  public boolean
);
`;

type QueryResult = { rows: Record<string, unknown>[]; rowCount: number };

let dataDir = "";
let owner: pg.Client;

function pgBinary(name: string): string {
  const candidates = [
    `/usr/lib/postgresql/17/bin/${name}`,
    `/usr/lib/postgresql/16/bin/${name}`,
    name,
  ];
  for (const candidate of candidates) {
    if (candidate === name || fs.existsSync(candidate)) return candidate;
  }
  return name;
}

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`,
    );
  }
}

function connect(user: string): pg.Client {
  return new pg.Client({
    host: "127.0.0.1",
    port: PORT,
    user,
    database: "postgres",
  });
}

/** PostgREST's transaction: set the JWT role, then run the caller's statement. */
async function asDataApi(role: string, sql: string, params: unknown[] = []): Promise<QueryResult> {
  const client = connect("authenticator");
  await client.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('role', $1, true)", [role]);
    const who = await client.query("select current_user");
    if (who.rows[0]?.current_user !== role) {
      throw new Error(`expected current_user ${role}, got ${who.rows[0]?.current_user}`);
    }
    const result = await client.query(sql, params);
    await client.query("commit");
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("expected current_user")) throw error;
    return { rows: [], rowCount: 0 };
  } finally {
    await client.end();
  }
}

async function ownerRows(sql: string, params: unknown[] = []) {
  const result = await owner.query(sql, params);
  return result.rows as Record<string, unknown>[];
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-log-data-api-"));
  run(pgBinary("initdb"), ["-D", dataDir, "--username=postgres", "--auth=trust", "--no-sync"]);
  run(pgBinary("pg_ctl"), [
    "-D",
    dataDir,
    "-l",
    path.join(dataDir, "server.log"),
    "-w",
    "start",
    "-o",
    `-p ${PORT} -k ${dataDir} -c listen_addresses=127.0.0.1`,
  ]);

  owner = connect("postgres");
  await owner.connect();
  await owner.query(bootstrapSql);

  const migrationsDir = path.join(process.cwd(), "supabase", "migrations");
  const files = fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    await owner.query(sql);
  }

  for (const role of DATA_API_ROLES) {
    const seeded = await asDataApi(
      "service_role",
      `insert into public.audit_log (actor, action, entity, entity_id, detail)
       values
         ('system', 'resume_ingest', 'candidate', $1, $2::jsonb),
         ('recruiter', 'resume_view', 'candidate', $3, $4::jsonb)`,
      [
        `ingest-${role}`,
        JSON.stringify({ storagePath: `${role}/resume.pdf`, bytes: 1200, mime: "application/pdf" }),
        `view-${role}`,
        JSON.stringify({ path: `${role}/resume.pdf` }),
      ],
    );
    if (seeded.rowCount !== 2) {
      throw new Error(`service_role could not seed audit rows for ${role}`);
    }
  }
});

after(async () => {
  await owner?.end().catch(() => undefined);
  if (dataDir) {
    spawnSync(pgBinary("pg_ctl"), ["-D", dataDir, "-w", "-m", "immediate", "stop"], { encoding: "utf8" });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

for (const role of DATA_API_ROLES) {
  test(`${role} cannot read resume_view or resume_ingest audit rows`, async () => {
    const result = await asDataApi(
      role,
      `select actor, action, entity, entity_id, detail
       from public.audit_log
       where entity_id = any($1::text[])`,
      [[`view-${role}`, `ingest-${role}`]],
    );
    assert.deepEqual(
      result.rows,
      [],
      `${role} read resume audit rows, including actor, candidate id, and storage path`,
    );
  });

  test(`${role} cannot insert a forged resume_view audit row`, async () => {
    await asDataApi(
      role,
      `insert into public.audit_log (actor, action, entity, entity_id, detail)
       values ('forged', 'resume_view', 'candidate', $1, '{"path":"planted/resume.pdf"}'::jsonb)`,
      [`forged-${role}`],
    );
    const planted = await ownerRows("select entity_id from public.audit_log where entity_id = $1", [
      `forged-${role}`,
    ]);
    assert.deepEqual(planted, [], `${role} planted a resume_view row`);
  });

  test(`${role} cannot rewrite the actor or storage path on a resume_view row`, async () => {
    await asDataApi(
      role,
      `update public.audit_log
       set actor = 'forged', detail = '{"path":"rewritten/resume.pdf"}'::jsonb
       where entity_id = $1`,
      [`view-${role}`],
    );
    const rows = await ownerRows(
      "select actor, detail from public.audit_log where entity_id = $1",
      [`view-${role}`],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.actor, "recruiter");
    assert.equal((rows[0]?.detail as { path?: string } | null)?.path, `${role}/resume.pdf`);
  });

  test(`${role} cannot delete a resume_view audit row`, async () => {
    await asDataApi(role, "delete from public.audit_log where entity_id = $1", [`view-${role}`]);
    const rows = await ownerRows("select entity_id from public.audit_log where entity_id = $1", [
      `view-${role}`,
    ]);
    assert.deepEqual(rows, [`view-${role}`].map((entity_id) => ({ entity_id })));
  });
}

test("service_role can still append a resume_view audit row", async () => {
  const inserted = await asDataApi(
    "service_role",
    `insert into public.audit_log (actor, action, entity, entity_id, detail)
     values ('recruiter', 'resume_view', 'candidate', 'view-service', '{"path":"service/resume.pdf"}'::jsonb)`,
  );
  assert.equal(inserted.rowCount, 1);
  const rows = await ownerRows("select actor, action from public.audit_log where entity_id = 'view-service'");
  assert.deepEqual(rows, [{ actor: "recruiter", action: "resume_view" }]);
});
