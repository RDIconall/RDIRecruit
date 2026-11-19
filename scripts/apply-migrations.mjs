#!/usr/bin/env node
/**
 * Apply SQL migrations using Supabase Postgres connection.
 * Tracks applied files in schema_migrations.
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const root = path.resolve(import.meta.dirname, "..");
const migrationsDir = path.join(root, "supabase", "migrations");

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    console.error("Set DATABASE_URL or SUPABASE_DB_URL (Supabase → Database → connection string)");
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  // Keep in sync with LEDGER_LOCKDOWN_SQL in src/lib/db/apply-migrations.ts:
  // the ledger must never be readable or writable through the Data API roles.
  await client.query(`
    do $$
    declare
      api_role text;
    begin
      create table if not exists public.schema_migrations (
        filename text primary key,
        applied_at timestamptz default now()
      );
      alter table public.schema_migrations enable row level security;
      revoke all on table public.schema_migrations from public;
      foreach api_role in array array['anon', 'authenticated', 'service_role'] loop
        if exists (select 1 from pg_roles where rolname = api_role) then
          execute format('revoke all on table public.schema_migrations from %I', api_role);
        end if;
      end loop;
    end
    $$;
  `);

  const { rows } = await client.query<{ filename: string }>("select filename from public.schema_migrations");
  const appliedSet = new Set(rows.map((r) => r.filename));

  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`Skipping ${file} (already applied)`);
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    console.log(`Applying ${file}...`);
    await client.query(sql);
    await client.query("insert into public.schema_migrations (filename) values ($1)", [file]);
  }

  await client.end();
  console.log("Migrations applied.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
