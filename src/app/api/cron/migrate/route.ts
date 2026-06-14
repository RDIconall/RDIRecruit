import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { env } from "@/lib/env";

export const runtime = "nodejs";

async function ensureMigrationTable(client: Client) {
  await client.query(`
    create table if not exists schema_migrations (
      filename text primary key,
      applied_at timestamptz default now()
    );
  `);
}

export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (env.CRON_SECRET && auth !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dbUrl = env.DATABASE_URL ?? env.SUPABASE_DB_URL;
  if (!dbUrl) {
    return NextResponse.json(
      {
        error: "DATABASE_URL not configured",
        hint: "Add Supabase Postgres connection string to Vercel env, then redeploy.",
      },
      { status: 500 },
    );
  }

  const migrationsDir = path.join(process.cwd(), "supabase", "migrations");
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();

  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

  try {
    await client.connect();
    await ensureMigrationTable(client);

    const { rows: done } = await client.query<{ filename: string }>(
      "select filename from schema_migrations",
    );
    const appliedSet = new Set(done.map((r) => r.filename));

    const { rows: overlayCheck } = await client.query(
      "select to_regclass('public.candidate_overlay') as overlay",
    );
    const bootstrapFiles = new Set([
      "001_initial_schema.sql",
      "002_overlay_evaluations.sql",
    ]);
    if (overlayCheck[0]?.overlay) {
      for (const file of files) {
        if (!bootstrapFiles.has(file)) continue;
        if (!appliedSet.has(file)) {
          await client.query(
            "insert into schema_migrations (filename) values ($1) on conflict do nothing",
            [file],
          );
          appliedSet.add(file);
        }
      }
    }

    const applied: string[] = [];
    const skipped: string[] = [];

    // Repair: older bootstrap marked migrations applied without executing SQL.
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
        await client.query("delete from schema_migrations where filename = $1", [file]);
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
      await client.query("insert into schema_migrations (filename) values ($1)", [file]);
      applied.push(file);
    }

    return NextResponse.json({ ok: true, applied, skipped });
  } catch (error) {
    console.error("Migration failed", error);
    return NextResponse.json(
      {
        error: "Migration failed",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}
