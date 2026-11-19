import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import pg from "pg";

// These tests are the spec for the migration ledger. They fail while
// schema_migrations is created in public without row level security and
// without revoking the Data API roles, and they pass once that table is
// closed to anon and authenticated.
//
// GET /api/cron/reconcile is not invoked. After applyPendingMigrations it
// continues into the Workable sync. The migration call itself is the same
// function the migrate route and these tests run.

const { Client } = pg;
const ssl = { rejectUnauthorized: false };
const repoRoot = process.cwd();
const port = 55432;
const dedupeFile = "20260908185453_dedupe_applications_unique_candidate.sql";
const overlayFile = "002_overlay_evaluations.sql";
const photoFile = "014_candidate_photo.sql";
const onceFile = "900_replay_once.sql";
const afterAbortFile = "zzz_after_abort.sql";
const updateFile = "zzz_update_marker.sql";

const adminUrl = `postgres://supabase_admin@127.0.0.1:${port}/postgres`;
const dbUrl = `postgres://postgres@127.0.0.1:${port}/ledger`;
const apiUrl = `postgres://authenticator@127.0.0.1:${port}/ledger`;

type Apply = typeof import("../src/lib/db/apply-migrations").applyPendingMigrations;
let applyPendingMigrations: Apply;
let cluster: { dataDir: string } | undefined;

function pgBin(name: string): string {
  const roots = ["/usr/lib/postgresql/17/bin", "/usr/lib/postgresql/16/bin", "/usr/lib/postgresql/15/bin"];
  for (const root of roots) {
    const candidate = path.join(root, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  const found = spawnSync("which", [name], { encoding: "utf8" }).stdout.trim();
  if (found) return found;
  throw new Error(`PostgreSQL binary "${name}" is required to run this test`);
}

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const result = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, ...env } });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url, ssl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function sql(url: string, text: string, params?: unknown[]): Promise<pg.QueryResult> {
  return withClient(url, (client) => client.query(text, params));
}

function startCluster(): { dataDir: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-pg-"));
  run(pgBin("initdb"), ["-D", dataDir, "--username=supabase_admin", "--auth=trust", "--encoding=UTF8", "--locale=C"]);
  const key = path.join(dataDir, "server.key");
  const cert = path.join(dataDir, "server.crt");
  run("openssl", ["req", "-new", "-x509", "-days", "1", "-nodes", "-subj", "/CN=localhost", "-keyout", key, "-out", cert]);
  fs.chmodSync(key, 0o600);
  fs.appendFileSync(
    path.join(dataDir, "postgresql.conf"),
    [
      "listen_addresses = '127.0.0.1'",
      `port = ${port}`,
      "ssl = on",
      `ssl_cert_file = '${cert}'`,
      `ssl_key_file = '${key}'`,
      "unix_socket_directories = '/tmp'",
    ].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(dataDir, "pg_hba.conf"),
    "hostssl all all 127.0.0.1/32 trust\nhost all all 127.0.0.1/32 trust\nlocal all all trust\n",
  );
  run(pgBin("pg_ctl"), ["-D", dataDir, "-l", path.join(dataDir, "server.log"), "-w", "start"]);
  return { dataDir };
}

function stopCluster(dataDir: string): void {
  spawnSync(pgBin("pg_ctl"), ["-D", dataDir, "-w", "-m", "fast", "stop"], { encoding: "utf8" });
}

async function installPlatformPrivileges(): Promise<void> {
  // Roles and default grants from supabase/postgres 17.6.1.107
  // migrations/db/init-scripts/00000000000000-initial-schema.sql, executed as
  // the postgres role by migrations/db/migrate.sh. postgres is then demoted
  // the way migrations/db/migrations/10000000000000_demote-postgres.sql does.
  await sql(
    adminUrl,
    `
    create role postgres superuser login;
    create role anon nologin noinherit;
    create role authenticated nologin noinherit;
    create role service_role nologin noinherit bypassrls;
    create user authenticator noinherit;
    grant anon to authenticator;
    grant authenticated to authenticator;
    grant service_role to authenticator;
    `,
  );
  await sql(adminUrl, "create database ledger owner postgres");
  await sql(
    dbUrl,
    `
    grant usage on schema public to postgres, anon, authenticated, service_role;
    grant create on schema public to postgres;
    alter default privileges in schema public grant all on tables to postgres, anon, authenticated, service_role;
    `,
  );
  await sql(
    adminUrl,
    "alter role postgres nosuperuser createdb createrole login replication bypassrls",
  );
}

async function resetDatabase(): Promise<void> {
  await sql(
    dbUrl,
    `
    drop schema if exists public cascade;
    drop schema if exists storage cascade;
    create schema public;
    grant usage on schema public to postgres, anon, authenticated, service_role;
    grant create on schema public to postgres;
    alter schema public owner to postgres;
    alter default privileges in schema public grant all on tables to postgres, anon, authenticated, service_role;
    `,
  );
}

async function allowOverlayMigration(): Promise<void> {
  await sql(
    dbUrl,
    `
    create schema if not exists storage;
    create table if not exists storage.buckets (
      id text primary key,
      name text,
      public boolean
    );
    `,
  );
}

function copyMigrations(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-migrations-"));
  fs.cpSync(path.join(repoRoot, "supabase", "migrations"), path.join(root, "supabase", "migrations"), {
    recursive: true,
  });
  return root;
}

async function inMigrationRoot<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(root);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

async function ledgerTable(): Promise<string> {
  const found = await sql(
    dbUrl,
    `select n.nspname as schema
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where c.relname = 'schema_migrations' and c.relkind = 'r'
     order by n.nspname
     limit 1`,
  );
  const schema = found.rows[0]?.schema as string | undefined;
  assert.ok(schema, "schema_migrations was not created");
  return `"${schema.replaceAll('"', '""')}"."schema_migrations"`;
}

async function filenames(): Promise<string[]> {
  const table = await ledgerTable();
  const result = await sql(dbUrl, `select filename from ${table} order by filename`);
  return result.rows.map((row) => row.filename as string);
}

async function dataApi(role: "anon" | "authenticated", statement: string): Promise<"accepted" | "rejected"> {
  // PostgREST 14.5 runs set_config('role', <jwt role>, true) and the write in
  // one transaction. authenticator is the login role and does not inherit.
  return withClient(apiUrl, async (client) => {
    try {
      await client.query("begin");
    // PostgREST sets search_path to the exposed schema, then the JWT role.
    await client.query("select set_config('search_path', 'public', true)");
    await client.query("select set_config('role', $1, true)", [role]);
    await client.query(statement);
      await client.query("commit");
      return "accepted";
    } catch {
      await client.query("rollback").catch(() => undefined);
      return "rejected";
    }
  });
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const result = await sql(
    dbUrl,
    `select 1 from information_schema.columns
     where table_schema = 'public' and table_name = $1 and column_name = $2`,
    [table, column],
  );
  return result.rowCount !== 0;
}

async function regclass(name: string): Promise<string | null> {
  const result = await sql(dbUrl, "select to_regclass($1) as name", [`public.${name}`]);
  return (result.rows[0]?.name as string | null) ?? null;
}

function runScript(): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "apply-migrations.mjs")], {
    encoding: "utf8",
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: dbUrl },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function assertLedgerUnchanged(before: string[], role: string, statement: string): Promise<void> {
  await dataApi(role as "anon" | "authenticated", statement);
  const after = await filenames();
  assert.deepEqual(after, before, `${role} changed schema_migrations with: ${statement}`);
}

async function skipPendingOverlay(role: "anon" | "authenticated"): Promise<void> {
  const root = copyMigrations();
  try {
    await inMigrationRoot(root, async () => {
      await assert.rejects(() => applyPendingMigrations(), /storage\.buckets/);
      const before = await filenames();
      assert.equal(before.includes(overlayFile), false);
      await assertLedgerUnchanged(before, role, `insert into schema_migrations (filename) values ('${overlayFile}')`);
      let skipped = false;
      try {
        const result = await applyPendingMigrations();
        skipped = result.skipped.includes(overlayFile);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /storage\.buckets/);
      }
      assert.equal(skipped, false, `${role} insert caused ${overlayFile} to be skipped`);
      assert.equal(await columnExists("applications", "resume_storage_path"), false);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function replayDedupe(role: "anon" | "authenticated"): Promise<void> {
  await allowOverlayMigration();
  await applyPendingMigrations();
  await sql(dbUrl, "drop index if exists applications_candidate_id_uidx");
  await sql(dbUrl, "insert into candidates (workable_id) values ('cand-dup') on conflict do nothing");
  await sql(
    dbUrl,
    "insert into applications (candidate_id, resume_text) values ('cand-dup', 'kept resume'), ('cand-dup', null)",
  );
  const before = await filenames();
  assert.equal(before.includes(dedupeFile), true);
  await assertLedgerUnchanged(before, role, `delete from schema_migrations where filename = '${dedupeFile}'`);
  const result = await applyPendingMigrations();
  assert.equal(result.applied.includes(dedupeFile), false, `${role} delete replayed ${dedupeFile}`);
  const count = await sql(dbUrl, "select count(*)::int as n from applications where candidate_id = 'cand-dup'");
  assert.equal(count.rows[0].n, 2, `${role} delete caused the dedupe migration to remove an application row`);
}

async function renameSkipsLaterFile(role: "anon" | "authenticated"): Promise<void> {
  const root = copyMigrations();
  try {
    await allowOverlayMigration();
    await inMigrationRoot(root, () => applyPendingMigrations());
    fs.writeFileSync(
      path.join(root, "supabase", "migrations", updateFile),
      "create table ledger_update_marker (id int);\n",
    );
    const before = await filenames();
    await assertLedgerUnchanged(
      before,
      role,
      `update schema_migrations set filename = '${updateFile}' where filename = '${photoFile}'`,
    );
    const result = await inMigrationRoot(root, () => applyPendingMigrations());
    assert.equal(result.skipped.includes(updateFile), false);
    assert.equal(await regclass("ledger_update_marker"), "ledger_update_marker");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function replayStopsLaterFile(role: "anon" | "authenticated"): Promise<void> {
  const root = copyMigrations();
  try {
    fs.writeFileSync(
      path.join(root, "supabase", "migrations", onceFile),
      "create table ledger_replay_once (id int primary key);\ninsert into ledger_replay_once (id) values (1);\n",
    );
    await allowOverlayMigration();
    await inMigrationRoot(root, () => applyPendingMigrations());
    fs.writeFileSync(
      path.join(root, "supabase", "migrations", afterAbortFile),
      "create table ledger_after_abort (id int);\n",
    );
    const before = await filenames();
    await assertLedgerUnchanged(before, role, `delete from schema_migrations where filename = '${onceFile}'`);
    const result = await inMigrationRoot(root, () => applyPendingMigrations());
    assert.equal(result.applied.includes(afterAbortFile), true, `${role} delete aborted the migration pass`);
    assert.equal(await regclass("ledger_after_abort"), "ledger_after_abort");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function routeSkipsPlantedOverlay(): Promise<void> {
  const { NextRequest } = await import("next/server");
  const { GET } = await import("../src/app/api/cron/migrate/route");
  const headers = new Headers();
  if (process.env.CRON_SECRET) headers.set("authorization", `Bearer ${process.env.CRON_SECRET}`);
  const call = () => GET(new NextRequest("http://localhost/api/cron/migrate", { headers }));
  const first = await call();
  assert.equal(first.status, 500);
  const before = await filenames();
  await assertLedgerUnchanged(before, "anon", `insert into schema_migrations (filename) values ('${overlayFile}')`);
  const second = await call();
  assert.equal(second.status, 500, "migrate cron skipped the planted overlay migration");
  assert.equal(await columnExists("applications", "resume_storage_path"), false);
}

async function scriptCreatesClosedLedger(role: "anon" | "authenticated"): Promise<void> {
  // The script creates the ledger, then throws on the TypeScript generic at
  // scripts/apply-migrations.mjs:30, so its apply loop never runs under node.
  const result = runScript();
  assert.notEqual(result.status, 0);
  const table = await ledgerTable();
  await sql(dbUrl, `insert into ${table} (filename) values ('001_initial_schema.sql')`);
  const before = await filenames();
  await assertLedgerUnchanged(before, role, "delete from schema_migrations");
  await assertLedgerUnchanged(before, role, "update schema_migrations set filename = 'planted.sql'");
  await assertLedgerUnchanged(before, role, "insert into schema_migrations (filename) values ('002_overlay_evaluations.sql')");
}

test("Data API roles cannot insert, update, or delete the migration ledger", { timeout: 180_000 }, async () => {
  cluster = startCluster();
  const failures: string[] = [];
  const cases: Array<[string, () => Promise<void>]> = [
    ["migrate route skips a filename anon inserted", routeSkipsPlantedOverlay],
    ["anon insert skips a pending migration", () => skipPendingOverlay("anon")],
    ["authenticated insert skips a pending migration", () => skipPendingOverlay("authenticated")],
    ["anon delete replays the dedupe migration", () => replayDedupe("anon")],
    ["authenticated delete replays the dedupe migration", () => replayDedupe("authenticated")],
    ["anon update hides a later migration", () => renameSkipsLaterFile("anon")],
    ["authenticated update hides a later migration", () => renameSkipsLaterFile("authenticated")],
    ["anon delete of a non-idempotent file stops later migrations", () => replayStopsLaterFile("anon")],
    ["authenticated delete of a non-idempotent file stops later migrations", () => replayStopsLaterFile("authenticated")],
    ["script ledger rejects an anon insert, update, and delete", () => scriptCreatesClosedLedger("anon")],
    ["script ledger rejects an authenticated insert, update, and delete", () => scriptCreatesClosedLedger("authenticated")],
  ];
  try {
    await installPlatformPrivileges();
    process.env.DATABASE_URL = dbUrl;
    ({ applyPendingMigrations } = await import("../src/lib/db/apply-migrations"));
    for (const [name, runCase] of cases) {
      try {
        await resetDatabase();
        await runCase();
      } catch (error) {
        failures.push(`${name}\n${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      }
    }
    assert.deepEqual(failures, [], failures.join("\n\n"));
  } finally {
    if (cluster) stopCluster(cluster.dataDir);
  }
});
