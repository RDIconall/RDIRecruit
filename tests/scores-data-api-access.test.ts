/**
 * Spec for the scores Data API exposure.
 *
 * Supabase runs init as the postgres role and grants that role's future public
 * tables to anon, authenticated, and service_role
 * (supabase/postgres migrate.sh runs init-scripts as postgres;
 * 00000000000000-initial-schema.sql grants those default privileges).
 * PostgREST v14.13 then SET LOCAL ROLE from the JWT role claim and runs the
 * query in that same transaction. These tests speak that role and expect the
 * product migrations to leave no path that returns or rewrites scores.
 *
 * They fail while anon or authenticated can still read or change the row
 * loadOneCandidate / the board take as the newest scores row.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Client, type QueryResult } from "pg";
import type { AnswerGradePayload, CandidateRow, ScoreRow } from "../src/lib/types";
import { mapCandidate, type MapInput } from "../src/lib/triage/from-supabase";
import type { FitRead } from "../src/lib/triage/fit-read";

const ADMIN_URL = process.env.SCORES_ACL_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";
const DATABASE = "scores_acl_test";
const AUTH_URL =
  process.env.SCORES_ACL_AUTH_URL ?? `postgres://authenticator@127.0.0.1:5432/${DATABASE}`;

const KEPT = "applicant-kept";
const REPLACED = "applicant-replaced";

const ORIGINAL_GATE = {
  integrity: { status: "fail", note: "seeded material integrity fail" },
  other: [],
  capReasons: ["seeded cap"],
};

const CATEGORIES = {
  principal: 10,
  environment: 10,
  scope: 10,
  writing: 10,
  tenure: 10,
  local: 10,
};

type DataRole = "anon" | "authenticated" | "service_role";

type DbError = { code?: string; message: string };

function isDbError(error: unknown): error is DbError {
  return typeof error === "object" && error !== null && "message" in error;
}

async function adminQuery(sql: string, params: unknown[] = []): Promise<QueryResult> {
  const client = new Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

async function queryAs(
  role: DataRole,
  sql: string,
  params: unknown[] = [],
  commit = false,
): Promise<{ denied: false; result: QueryResult } | { denied: true; code: string; message: string }> {
  const client = new Client({ connectionString: AUTH_URL });
  await client.connect();
  try {
    await client.query("begin");
    const switched = await client.query("select set_config('role', $1, true) as role", [role]);
    assert.equal(switched.rows[0]?.role, role, `Data API role switch did not land on ${role}`);
    const result = await client.query(sql, params);
    await client.query(commit ? "commit" : "rollback");
    return { denied: false, result };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    if (isDbError(error) && error.code === "42501") {
      return { denied: true, code: error.code, message: error.message };
    }
    throw error;
  } finally {
    await client.end();
  }
}

/**
 * Same default privileges the Supabase init script applies while running as
 * postgres. Copied from migrations/db/init-scripts/00000000000000-initial-schema.sql
 * lines 39-42, which migrate.sh executes with `psql -U postgres`.
 */
const PLATFORM_DEFAULT_PRIVILEGES = `
grant usage on schema public to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to postgres, anon, authenticated, service_role;
`;

async function resetCluster(): Promise<void> {
  await adminQuery(`
    do $$
    begin
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
        create role authenticator noinherit login;
      end if;
    end $$;
    grant anon to authenticator;
    grant authenticated to authenticator;
    grant service_role to authenticator;
    alter role service_role bypassrls;
  `);
  await adminQuery(`
    select pg_terminate_backend(pid)
    from pg_stat_activity
    where datname = '${DATABASE}' and pid <> pg_backend_pid()
  `);
  await adminQuery(`drop database if exists ${DATABASE}`);
  await adminQuery(`create database ${DATABASE}`);

  const db = new Client({ connectionString: ADMIN_URL.replace(/\/postgres$/, `/${DATABASE}`) });
  await db.connect();
  try {
    await db.query(PLATFORM_DEFAULT_PRIVILEGES);
    await db.query(`
      create schema if not exists storage;
      create table if not exists storage.buckets (
        id text primary key,
        name text,
        public boolean
      );
    `);
    const dir = path.join(process.cwd(), "supabase", "migrations");
    const files = fs.readdirSync(dir).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) {
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      try {
        await db.query(sql);
      } catch (error) {
        const message = isDbError(error) ? error.message : String(error);
        throw new Error(`migration ${file} failed: ${message}`);
      }
    }
  } finally {
    await db.end();
  }
}

async function seed(): Promise<void> {
  const cleared = await queryAs(
    "service_role",
    `delete from public.scores where candidate_id = any($1::text[])`,
    [[KEPT, REPLACED]],
    true,
  );
  if (cleared.denied) throw new Error(`service_role could not reset scores: ${cleared.message}`);

  const jobs = await queryAs(
    "service_role",
    `insert into public.jobs (shortcode, title) values ('JOB1', 'Clinical seat') on conflict (shortcode) do nothing`,
    [],
    true,
  );
  if (jobs.denied) throw new Error(`service_role could not seed jobs: ${jobs.message}`);

  const people = await queryAs(
    "service_role",
    `insert into public.candidates (workable_id, job_shortcode, name)
     values ($1, 'JOB1', 'Rowan Hale'), ($2, 'JOB1', 'Casey Quinn')
     on conflict (workable_id) do nothing`,
    [KEPT, REPLACED],
    true,
  );
  if (people.denied) throw new Error(`service_role could not seed candidates: ${people.message}`);

  const notes = await queryAs(
    "service_role",
    `insert into public.notifications (type, candidate_id, payload)
     select 'strong_fit', c.workable_id, jsonb_build_object('text', c.name || ' crossed Strong threshold')
     from public.candidates c
     where c.workable_id = any($1::text[])
       and not exists (
         select 1 from public.notifications n
         where n.candidate_id = c.workable_id and n.type = 'strong_fit'
       )`,
    [[KEPT, REPLACED]],
    true,
  );
  if (notes.denied) throw new Error(`service_role could not seed notifications: ${notes.message}`);

  const scores = await queryAs(
    "service_role",
    `insert into public.scores (
       candidate_id, rubric_version, category_scores, total, salary_value,
       seat_dimension_scores, gate_results, created_at
     ) values
       ($1, 1, $3::jsonb, 60, 'poor value', '{"ownership":4}'::jsonb, $4::jsonb, '2026-01-01T00:00:00Z'),
       ($2, 1, $3::jsonb, 72, 'justified', '{"ownership":6}'::jsonb, '{"integrity":{"status":"clear","note":"seeded clear"}}'::jsonb, '2026-01-01T00:00:00Z')`,
    [KEPT, REPLACED, JSON.stringify(CATEGORIES), JSON.stringify(ORIGINAL_GATE)],
    true,
  );
  if (scores.denied) throw new Error(`service_role could not seed scores: ${scores.message}`);
}

type LoadedScore = {
  total: number | null;
  salary_value: string | null;
  gate_results: unknown;
  seat_dimension_scores: unknown;
  created_at: string | null;
};

async function loadNewest(candidateId: string): Promise<LoadedScore | null> {
  // load.ts selects * ordered by created_at desc limit 1. PostgREST emits
  // ORDER BY <col> DESC and LIMIT for that request, in the role transaction
  // opened above.
  const loaded = await queryAs(
    "service_role",
    `select total, salary_value, gate_results, seat_dimension_scores, created_at
     from public.scores
     where candidate_id = $1
     order by created_at desc
     limit 1`,
    [candidateId],
  );
  if (loaded.denied) throw new Error(`service_role could not load newest score: ${loaded.message}`);
  const row = loaded.result.rows[0];
  if (!row) return null;
  return {
    total: row.total,
    salary_value: row.salary_value,
    gate_results: row.gate_results,
    seat_dimension_scores: row.seat_dimension_scores,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

const candidateRow: CandidateRow = {
  workable_id: KEPT,
  job_shortcode: "JOB1",
  name: "Rowan Hale",
  email: null,
  phone: null,
  location: "Los Angeles, CA",
  stage: "Applied",
  stage_kind: null,
  disqualified: false,
  source: null,
  assignee_id: null,
  raw: null,
  photo_url: null,
  created_at: "2026-06-01T00:00:00.000Z",
  synced_at: "2026-06-01T00:00:00.000Z",
};

function grade(): AnswerGradePayload {
  return {
    question: "How would you handle a missing source document?",
    answer: "I would escalate it to the study lead and log the deviation before the next monitoring visit.",
    verdict: "OWNED",
    present: ["deviation logging"],
    note: "",
    kind: "screen",
  };
}

const fit: FitRead = {
  reply: "Owned the monitoring stand-up; answers name real work.",
  sentiment: "good",
  appliedFit: "Fits this posting.",
  rdiFit: "We would want them in the building.",
  suggestedSeat: "",
};

function viewInput(score: ScoreRow | null, id = KEPT): MapInput {
  return {
    candidate: { ...candidateRow, workable_id: id, name: id === KEPT ? "Rowan Hale" : "Casey Quinn" },
    score,
    ro: null,
    overlay: null,
    application: { answers: null, cover_letter: "A real cover letter.", parsed_experience: [] },
    narrative: [],
    evals: {
      invest: {
        complement: "technician",
        head: "Work off the desk",
        removes: "monitoring load",
        vector: "priced about right",
        summary: "Runs monitoring end to end.",
        ask: "$120k",
      },
      dig: null,
      verification: null,
      roleReads: [],
      answerGrades: [grade(), grade(), grade()],
      fitRead: fit,
    },
    interviewEvidence: [],
    read: null,
    rank: 1,
    jobLocation: "Van Nuys, CA",
    jobShortcode: "JOB1",
  };
}

function scoreRow(id: string, total: number, salary: ScoreRow["salary_value"], gate = ORIGINAL_GATE): ScoreRow {
  return {
    id: `score-${id}-${total}`,
    candidate_id: id,
    rubric_version: 1,
    category_scores: CATEGORIES,
    seat_dimension_scores: { ownership: 4 },
    gate_results: gate,
    total,
    salary_value: salary,
    confidence: "high",
    model_version: "test",
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

function gateFingerprint(gate: unknown): string {
  const integrity = (gate as { integrity?: { status?: string; note?: string } } | null)?.integrity;
  return `${integrity?.status ?? ""}|${integrity?.note ?? ""}`;
}

function rowUntouched(row: LoadedScore | null, total: number, salary: string, gate: unknown): boolean {
  return (
    row?.total === total &&
    row.salary_value === salary &&
    gateFingerprint(row.gate_results) === gateFingerprint(gate) &&
    JSON.stringify(row.seat_dimension_scores) === JSON.stringify(total === 60 ? { ownership: 4 } : { ownership: 6 })
  );
}

function boardOf(row: LoadedScore | null, id: string) {
  const score = row
    ? scoreRow(
        id,
        Number(row.total),
        row.salary_value as ScoreRow["salary_value"],
        row.gate_results as ScoreRow["gate_results"],
      )
    : null;
  return mapCandidate(viewInput(score, id));
}

test("anon and authenticated cannot read or replace the scores row triage loads", { timeout: 120_000 }, async () => {
  const keptBaseline = mapCandidate(viewInput(scoreRow(KEPT, 60, "poor value")));
  const keptPoison = mapCandidate(
    viewInput(
      scoreRow(KEPT, 96, "great value", {
        integrity: { status: "clear", note: "attacker cleared the gate" },
      }),
    ),
  );
  assert.notEqual(keptPoison.specRead.label, keptBaseline.specRead.label);
  assert.notEqual(keptPoison.value.headline, keptBaseline.value.headline);
  assert.notEqual(keptPoison.askTier, keptBaseline.askTier);
  assert.equal(keptBaseline.specRead.label, "Below bar");
  assert.equal(keptPoison.specRead.label, "Clears the bar");

  await resetCluster();
  await seed();

  const failures: string[] = [];

  for (const role of ["anon", "authenticated"] as const) {
    await seed();

    const listed = await queryAs(
      role,
      `select candidate_id, total, salary_value, seat_dimension_scores, gate_results
       from public.scores`,
    );
    if (!listed.denied && listed.result.rows.length > 0) {
      failures.push(
        `${role} select scores returned ${listed.result.rows.length} row(s): ${JSON.stringify(listed.result.rows)}`,
      );
    }

    const notes = await queryAs(role, `select candidate_id, payload from public.notifications`);
    if (!notes.denied && notes.result.rows.length > 0) {
      const ids = notes.result.rows.map((row) => row.candidate_id);
      const joined = await queryAs(
        role,
        `select s.candidate_id, s.total, s.salary_value, s.seat_dimension_scores, s.gate_results, n.payload
         from public.scores s
         join public.notifications n on n.candidate_id = s.candidate_id
         where s.candidate_id = any($1::text[])`,
        [ids],
      );
      if (!joined.denied && joined.result.rows.length > 0) {
        failures.push(
          `${role} joined scores to notification names: ${JSON.stringify(joined.result.rows)}`,
        );
      }
    }

    await queryAs(
      role,
      `update public.scores
       set total = 96,
           salary_value = 'great value',
           gate_results = '{"integrity":{"status":"clear","note":"attacker cleared the gate"}}'::jsonb,
           seat_dimension_scores = '{"ownership":9}'::jsonb
       where candidate_id = $1`,
      [KEPT],
      true,
    );
    const afterUpdate = await loadNewest(KEPT);
    if (!rowUntouched(afterUpdate, 60, "poor value", ORIGINAL_GATE)) {
      const view = boardOf(afterUpdate, KEPT);
      failures.push(
        `${role} update replaced the scores row triage loads: ${JSON.stringify(afterUpdate)} (spec ${view.specRead.label}, value ${view.value.headline}, ask ${view.askTier})`,
      );
    }
    await queryAs(
      role,
      `insert into public.scores (
         candidate_id, rubric_version, category_scores, total, salary_value,
         seat_dimension_scores, gate_results
       ) values (
         $1, 1, $2::jsonb, 96, 'great value',
         '{"ownership":9}'::jsonb,
         '{"integrity":{"status":"clear","note":"attacker cleared the gate"}}'::jsonb
       )`,
      [REPLACED, JSON.stringify(CATEGORIES)],
      true,
    );
    await queryAs(role, `delete from public.scores where candidate_id = $1`, [KEPT], true);

    const kept = await loadNewest(KEPT);
    const replaced = await loadNewest(REPLACED);
    const keptView = boardOf(kept, KEPT);
    const replacedView = boardOf(replaced, REPLACED);
    const replacedBaseline = mapCandidate(viewInput(scoreRow(REPLACED, 72, "justified", {
      integrity: { status: "clear", note: "seeded clear" },
    }), REPLACED));

    if (!rowUntouched(kept, 60, "poor value", ORIGINAL_GATE)) {
      failures.push(
        `${role} changed the newest scores row for ${KEPT}: ${JSON.stringify(kept)} (spec ${keptView.specRead.label}, value ${keptView.value.headline}, ask ${keptView.askTier})`,
      );
    } else if (
      keptView.specRead.label !== keptBaseline.specRead.label ||
      keptView.value.headline !== keptBaseline.value.headline ||
      keptView.askTier !== keptBaseline.askTier
    ) {
      failures.push(
        `${role} kept the numeric row but the board labels moved: spec ${keptView.specRead.label}, value ${keptView.value.headline}, ask ${keptView.askTier}`,
      );
    }
    if (!rowUntouched(replaced, 72, "justified", { integrity: { status: "clear", note: "seeded clear" } })) {
      failures.push(
        `${role} replaced the newest scores row for ${REPLACED}: ${JSON.stringify(replaced)} (spec ${replacedView.specRead.label}, value ${replacedView.value.headline})`,
      );
    } else if (replacedView.specRead.label !== replacedBaseline.specRead.label || replacedView.value.headline !== replacedBaseline.value.headline) {
      failures.push(
        `${role} kept ${REPLACED}'s numbers but the board labels moved: spec ${replacedView.specRead.label}, value ${replacedView.value.headline}`,
      );
    }
  }

  assert.deepEqual(failures, [], failures.join("\n"));
});
