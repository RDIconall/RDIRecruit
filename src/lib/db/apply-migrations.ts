import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { env } from "@/lib/env";

export type MigrationApplyResult = {
  ok: true;
  applied: string[];
  skipped: string[];
};

/**
 * The ledger decides which SQL runs as the database owner, so only the owner
 * connection may touch it. It sits in the Data API schema, so creation and
 * lockdown run as one statement (no session sees the default grants) and are
 * re-applied every pass. Enabling RLS fails closed if the migration role does
 * not own the table.
 */
const LEDGER_LOCKDOWN_SQL = `
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
`;

async function ensureMigrationTable(client: Client) {
  await client.query(LEDGER_LOCKDOWN_SQL);
}

/** Apply any SQL files in supabase/migrations that are not yet recorded. */
export async function applyPendingMigrations(): Promise<MigrationApplyResult> {
  const dbUrl = env.DATABASE_URL ?? env.SUPABASE_DB_URL;
  if (!dbUrl) {
    throw new Error("DATABASE_URL not configured");
  }

  const migrationsDir = path.join(process.cwd(), "supabase", "migrations");
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();

  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

  try {
    await client.connect();
    await ensureMigrationTable(client);

    const { rows: done } = await client.query<{ filename: string }>(
      "select filename from public.schema_migrations",
    );
    const appliedSet = new Set(done.map((r) => r.filename));

    const { rows: overlayCheck } = await client.query(
      "select to_regclass('public.candidate_overlay') as overlay",
    );
    const bootstrapFiles = new Set(["001_initial_schema.sql", "002_overlay_evaluations.sql"]);
    if (overlayCheck[0]?.overlay) {
      for (const file of files) {
        if (!bootstrapFiles.has(file)) continue;
        if (!appliedSet.has(file)) {
          await client.query(
            "insert into public.schema_migrations (filename) values ($1) on conflict do nothing",
            [file],
          );
          appliedSet.add(file);
        }
      }
    }

    const applied: string[] = [];
    const skipped: string[] = [];

    const repairChecks: Array<{ file: string; table: string }> = [
      { file: "004_incremental_sync.sql", table: "sync_state" },
      { file: "005_evidence_rescore.sql", table: "candidates" },
    ];
    for (const { file, table } of repairChecks) {
      if (!appliedSet.has(file)) continue;
      let missing = false;
      if (file === "005_evidence_rescore.sql") {
        const { rows } = await client.query(
          `select 1 from information_schema.columns
           where table_schema = 'public' and table_name = 'candidates' and column_name = 'comments_synced_at'`,
        );
        missing = rows.length === 0;
      } else {
        const { rows } = await client.query(`select to_regclass($1) as reg`, [`public.${table}`]);
        missing = !rows[0]?.reg;
      }
      if (missing) {
        await client.query("delete from public.schema_migrations where filename = $1", [file]);
        appliedSet.delete(file);
      }
    }

    for (const file of files) {
      if (appliedSet.has(file)) {
        skipped.push(file);
        continue;
      }
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      await client.query(sql);
      await client.query("insert into public.schema_migrations (filename) values ($1)", [file]);
      applied.push(file);
    }

    return { ok: true, applied, skipped };
  } finally {
    await client.end().catch(() => undefined);
  }
}
