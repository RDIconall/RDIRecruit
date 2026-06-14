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

  await client.query(`
    create table if not exists schema_migrations (
      filename text primary key,
      applied_at timestamptz default now()
    );
  `);

  const { rows } = await client.query<{ filename: string }>("select filename from schema_migrations");
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
    await client.query("insert into schema_migrations (filename) values ($1)", [file]);
  }

  await client.end();
  console.log("Migrations applied.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
