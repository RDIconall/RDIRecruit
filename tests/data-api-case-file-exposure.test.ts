import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import { deriveDecision, type MapInput } from "../src/lib/triage/from-supabase";

const PG_BIN = "/usr/lib/postgresql/16/bin";
const PORT = 54329;
const DATA_DIR = path.join("/tmp", "rdi-data-api-exposure-pg");
const CANDIDATE = "cand-exposure";
const JOB = "JOB-EXPOSURE";
const CASE_FILE = "CASE-FILE-SECRET";
const ACTIVITY_BODY = "ACTIVITY-SECRET";
const EVAL_SECRET = "EVAL-SECRET";
const OVERLAY_REASON = "OVERLAY-SECRET";
const CALIBRATION_SECRET = "CALIBRATION-SECRET";
const FEEDBACK_SECRET = "FEEDBACK-SECRET";
const SEARCH_SECRET = "SEARCH-SECRET";
const SCORECARD_SECRET = "SCORECARD-SECRET";
const CONTACT_EMAIL = "contact-secret@example.com";
const SCORE_SECRET = "SCORE-SECRET";
const OUTREACH_SECRET = "OUTREACH-SECRET";
const BATCH_SECRET = "BATCH-SECRET";
const FORGED_TRANSCRIPT = "FORGED-INTERVIEW-TRANSCRIPT";
const FORGED_ACTIVITY = "FORGED-ACTIVITY-INTERVIEW";

const DATA_API_ROLES = ["anon", "authenticated"] as const;

let pool: pg.Pool;

function run(bin: string, args: string[]) {
  const result = spawnSync(path.join(PG_BIN, bin), args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${bin} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
}

async function query(sql: string, params: unknown[] = []) {
  return pool.query(sql, params);
}

async function asDataApi(role: string, sql: string, params: unknown[] = []) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local session authorization authenticator");
    await client.query("select set_config('role', $1, true)", [role]);
    const result = await client.query(sql, params);
    await client.query("commit");
    return { ok: true as const, rows: result.rows, rowCount: result.rowCount ?? 0, code: "", message: "" };
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // The transaction is already closed.
    }
    const pgError = error as { code?: string; message?: string };
    return {
      ok: false as const,
      rows: [] as unknown[],
      rowCount: 0,
      code: pgError.code ?? "",
      message: pgError.message ?? String(error),
    };
  } finally {
    client.release();
  }
}

function visible(result: { ok: boolean; rows: unknown[] }, secret: string) {
  return result.ok && JSON.stringify(result.rows).includes(secret);
}

async function assertNoRead(tableSql: string, params: unknown[], secret: string) {
  const leaks: string[] = [];
  for (const role of DATA_API_ROLES) {
    const result = await asDataApi(role, tableSql, params);
    if (visible(result, secret)) leaks.push(`${role} read ${secret} via ${tableSql}`);
  }
  assert.deepEqual(leaks, []);
}

async function assertNoWrite(role: string, sql: string, params: unknown[], unchanged: () => Promise<unknown>) {
  const before = await unchanged();
  const result = await asDataApi(role, sql, params);
  const after = await unchanged();
  assert.deepEqual(after, before, `${role} changed stored rows with ${sql} (${result.code} ${result.message})`);
  assert.equal(result.ok && result.rowCount > 0, false, `${role} write reported ${result.rowCount} rows`);
}

function mapInput(status: "active" | "disqualified" | "withdrawn"): MapInput {
  return {
    candidate: {
      workable_id: CANDIDATE,
      job_shortcode: JOB,
      name: "Casey Example",
      email: "casey@example.com",
      phone: "555-0100",
      location: null,
      stage: null,
      stage_kind: null,
      disqualified: false,
      source: null,
      assignee_id: null,
      raw: null,
      photo_url: null,
      created_at: null,
      synced_at: "2026-01-01T00:00:00.000Z",
    },
    score: null,
    ro: null,
    overlay: {
      candidate_id: CANDIDATE,
      status,
      status_reason: OVERLAY_REASON,
      complement: null,
      complement_removes: null,
      salary_vector: null,
      updated_by: null,
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    application: null,
    narrative: [],
    evals: {
      invest: null,
      dig: null,
      verification: null,
      roleReads: [],
      answerGrades: [],
      fitRead: null,
    },
    interviewEvidence: [],
    read: {
      decision: "interview",
      why: "Prior model read",
      risk: "",
      next: "",
    },
    rank: 1,
    jobLocation: "Van Nuys, CA",
    jobShortcode: JOB,
  };
}

describe("Data API policies for case files and interview notes", { concurrency: 1 }, () => {
  before(async () => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    run("initdb", ["-D", DATA_DIR, "--username=ubuntu", "--auth=trust", "--no-instructions"]);
    fs.appendFileSync(
      path.join(DATA_DIR, "postgresql.conf"),
      `\nport = ${PORT}\nlisten_addresses = ''\nunix_socket_directories = '${DATA_DIR}'\n`,
    );
    run("pg_ctl", ["-D", DATA_DIR, "-l", path.join(DATA_DIR, "server.log"), "-w", "start"]);
    pool = new pg.Pool({ host: DATA_DIR, port: PORT, user: "ubuntu", database: "postgres", max: 4 });
    const setup = await pool.connect();
    try {
      await setup.query(`
        create role supabase_admin nologin superuser bypassrls;
        create role postgres superuser login;
        create role anon nologin noinherit;
        create role authenticated nologin noinherit;
        create role service_role nologin noinherit bypassrls;
        create user authenticator noinherit;
        grant anon to authenticator;
        grant authenticated to authenticator;
        grant service_role to authenticator;
        grant supabase_admin to authenticator;
      `);
      await setup.query("set role postgres");
      await setup.query(`
        grant usage on schema public to postgres, anon, authenticated, service_role;
        alter default privileges in schema public grant all on tables to postgres, anon, authenticated, service_role;
        alter default privileges in schema public grant all on functions to postgres, anon, authenticated, service_role;
        alter default privileges in schema public grant all on sequences to postgres, anon, authenticated, service_role;
        alter role anon set statement_timeout = '3s';
        alter role authenticated set statement_timeout = '8s';
        create schema if not exists storage;
        create table if not exists storage.buckets (
          id text primary key,
          name text,
          public boolean
        );
      `);
      const migrationsDir = path.join(process.cwd(), "supabase/migrations");
      const files = fs.readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();
      for (const file of files) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
        await setup.query(sql);
      }
      await setup.query(
        `insert into jobs (shortcode, title, status, raw)
         values ($1, 'Clinical Operations Lead', 'published', $2::jsonb)`,
        [JOB, JSON.stringify({ full_description: "<p>Own clinical operations, monitoring plans, and vendor oversight for the Van Nuys site.</p>" })],
      );
      await setup.query(
        `insert into candidates (workable_id, job_shortcode, name, email, phone, disqualified)
         values ($1, $2, 'Casey Example', 'casey@example.com', '555-0100', false)`,
        [CANDIDATE, JOB],
      );
      await setup.query(
        `insert into applications (candidate_id, resume_text, answers)
         values ($1, $2, '{}'::jsonb)`,
        [CANDIDATE, "Owned the monitoring plan and vendor oversight for a multi-site study. ".repeat(3)],
      );
      await setup.query(
        `insert into candidate_working_files (candidate_id, content, workspace)
         values ($1, $2, '{"transcript":""}'::jsonb)`,
        [CANDIDATE, CASE_FILE],
      );
      await setup.query(
        `insert into activity (candidate_id, type, author, body)
         values ($1, 'note', 'recruiter', $2)`,
        [CANDIDATE, ACTIVITY_BODY],
      );
      await setup.query(
        `insert into candidate_overlay (candidate_id, status, status_reason)
         values ($1, 'active', $2)`,
        [CANDIDATE, OVERLAY_REASON],
      );
      await setup.query(
        `insert into evaluations (candidate_id, kind, payload)
         values ($1, 'invest_head', $2::jsonb)`,
        [CANDIDATE, JSON.stringify({ summary: EVAL_SECRET })],
      );
      await setup.query(
        `insert into calibration (scope, version, markdown, active)
         values ('global', 1, $1, true)`,
        [CALIBRATION_SECRET],
      );
      await setup.query(
        `insert into calibration_feedback (candidate_id, note)
         values ($1, $2)`,
        [CANDIDATE, FEEDBACK_SECRET],
      );
      await setup.query(`insert into radar_searches (title) values ($1)`, [SEARCH_SECRET]);
      await setup.query(
        `insert into radar_scorecards (name, content) values ('recruiting', $1)`,
        [SCORECARD_SECRET],
      );
      const contact = await setup.query(
        `insert into radar_contacts (full_name, email) values ('Pat Example', $1) returning id`,
        [CONTACT_EMAIL],
      );
      const contactId = contact.rows[0].id as string;
      await setup.query(
        `insert into radar_scores (contact_id, summary) values ($1, $2)`,
        [contactId, SCORE_SECRET],
      );
      await setup.query(
        `insert into radar_outreach (contact_id, body) values ($1, $2)`,
        [contactId, OUTREACH_SECRET],
      );
      await setup.query(`insert into radar_import_batches (filename) values ($1)`, [BATCH_SECRET]);
      await setup.query(
        `insert into candidate_analyses (candidate_id, input_hash, model, input_snapshot)
         values ($1, 'hash', 'test-model', '{"note":"analysis"}'::jsonb)`,
        [CANDIDATE],
      );
    } finally {
      setup.release();
    }
    (globalThis as { __rdiPgPool?: pg.Pool }).__rdiPgPool = pool;
  });

  after(async () => {
    await pool?.end();
    spawnSync(path.join(PG_BIN, "pg_ctl"), ["-D", DATA_DIR, "-m", "immediate", "-w", "stop"]);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });

  test("rows without a permissive policy stay hidden from the Data API roles", async () => {
    await assertNoRead(
      "select email from candidates where workable_id = $1",
      [CANDIDATE],
      "casey@example.com",
    );
    await assertNoRead(
      "select input_snapshot::text from candidate_analyses where candidate_id = $1",
      [CANDIDATE],
      "analysis",
    );
  });

  test("the service role used by the app can still read the case file", async () => {
    const result = await asDataApi(
      "service_role",
      "select content from candidate_working_files where candidate_id = $1",
      [CANDIDATE],
    );
    assert.equal(result.ok, true, result.message);
    assert.equal(result.rows[0]?.content, CASE_FILE);
  });

  test("anon and authenticated cannot read or modify candidate working files", async () => {
    for (const role of DATA_API_ROLES) {
      await assertNoWrite(
        role,
        `update candidate_working_files
           set workspace = jsonb_build_object('transcript', $2::text)
         where candidate_id = $1`,
        [CANDIDATE, `update-by-${role}`],
        async () => (await query("select workspace from candidate_working_files where candidate_id = $1", [CANDIDATE])).rows,
      );
      await assertNoWrite(
        role,
        "delete from candidate_working_files where candidate_id = $1",
        [CANDIDATE],
        async () => (await query("select content from candidate_working_files where candidate_id = $1", [CANDIDATE])).rows,
      );
    }
    await assertNoRead(
      "select content, workspace::text from candidate_working_files where candidate_id = $1",
      [CANDIDATE],
      CASE_FILE,
    );
  });

  test("anon and authenticated cannot read or insert activity, including interview rows", async () => {
    for (const role of DATA_API_ROLES) {
      await assertNoWrite(
        role,
        "insert into activity (candidate_id, type, author, body) values ($1, 'interview', $2, $3)",
        [CANDIDATE, role, FORGED_ACTIVITY],
        async () => (await query("select type, author, body from activity where candidate_id = $1 order by body", [CANDIDATE])).rows,
      );
    }
    await assertNoRead(
      "select body from activity where candidate_id = $1",
      [CANDIDATE],
      ACTIVITY_BODY,
    );
  });

  test("anon and authenticated cannot read or write candidate overlay", async () => {
    await asDataApi(
      "anon",
      "update candidate_overlay set status = 'disqualified', status_reason = 'cut-by-anon' where candidate_id = $1",
      [CANDIDATE],
    );
    const overlay = await query("select status from candidate_overlay where candidate_id = $1", [CANDIDATE]);
    const decision = deriveDecision(mapInput(overlay.rows[0].status));
    assert.notEqual(
      decision,
      "reject",
      `anon left overlay status ${overlay.rows[0].status}, which deriveDecision reports as ${decision}`,
    );
    for (const role of DATA_API_ROLES) {
      await assertNoWrite(
        role,
        "update candidate_overlay set status = 'disqualified', status_reason = $2 where candidate_id = $1",
        [CANDIDATE, `cut-by-${role}`],
        async () => (await query("select status, status_reason from candidate_overlay where candidate_id = $1", [CANDIDATE])).rows,
      );
    }
    await assertNoRead(
      "select status, status_reason from candidate_overlay where candidate_id = $1",
      [CANDIDATE],
      OVERLAY_REASON,
    );
  });

  test("anon and authenticated cannot read or insert evaluations", async () => {
    for (const role of DATA_API_ROLES) {
      await assertNoWrite(
        role,
        "insert into evaluations (candidate_id, kind, payload) values ($1, 'fit_read', $2::jsonb)",
        [CANDIDATE, JSON.stringify({ summary: `eval-by-${role}` })],
        async () => (await query("select kind, payload from evaluations where candidate_id = $1 order by kind", [CANDIDATE])).rows,
      );
    }
    await assertNoRead(
      "select payload::text from evaluations where candidate_id = $1",
      [CANDIDATE],
      EVAL_SECRET,
    );
  });

  test("anon and authenticated cannot read or write calibration notes", async () => {
    await assertNoRead("select markdown from calibration", [], CALIBRATION_SECRET);
    await assertNoRead("select note from calibration_feedback", [], FEEDBACK_SECRET);
    for (const role of DATA_API_ROLES) {
      await assertNoWrite(
        role,
        "insert into calibration (scope, version, markdown, active) values ($1, 2, $2, true)",
        [`scope-${role}`, `cal-by-${role}`],
        async () => (await query("select scope, markdown from calibration order by scope")).rows,
      );
      await assertNoWrite(
        role,
        "insert into calibration_feedback (candidate_id, note) values ($1, $2)",
        [CANDIDATE, `feedback-by-${role}`],
        async () => (await query("select note from calibration_feedback order by note")).rows,
      );
    }
  });

  test("anon and authenticated cannot read or write Talent Radar tables", async () => {
    const reads: Array<[string, string]> = [
      ["select title from radar_searches", SEARCH_SECRET],
      ["select content from radar_scorecards", SCORECARD_SECRET],
      ["select email from radar_contacts", CONTACT_EMAIL],
      ["select summary from radar_scores", SCORE_SECRET],
      ["select body from radar_outreach", OUTREACH_SECRET],
      ["select filename from radar_import_batches", BATCH_SECRET],
    ];
    for (const [sql, secret] of reads) await assertNoRead(sql, [], secret);

    const contact = await query("select id from radar_contacts limit 1");
    const contactId = contact.rows[0].id as string;
    for (const role of DATA_API_ROLES) {
      await assertNoWrite(
        role,
        "insert into radar_searches (title) values ($1)",
        [`search-by-${role}`],
        async () => (await query("select title from radar_searches order by title")).rows,
      );
      await assertNoWrite(
        role,
        "insert into radar_scorecards (name, content) values ($1, $2)",
        [`card-${role}`, `card-by-${role}`],
        async () => (await query("select name, content from radar_scorecards order by name")).rows,
      );
      await assertNoWrite(
        role,
        "insert into radar_contacts (full_name, email) values ($1, $2)",
        [`Name ${role}`, `${role}@example.com`],
        async () => (await query("select email from radar_contacts order by email")).rows,
      );
      await assertNoWrite(
        role,
        "insert into radar_scores (contact_id, summary) values ($1, $2)",
        [contactId, `score-by-${role}`],
        async () => (await query("select summary from radar_scores order by summary")).rows,
      );
      await assertNoWrite(
        role,
        "insert into radar_outreach (contact_id, body) values ($1, $2)",
        [contactId, `outreach-by-${role}`],
        async () => (await query("select body from radar_outreach order by body")).rows,
      );
      await assertNoWrite(
        role,
        "insert into radar_import_batches (filename) values ($1)",
        [`batch-by-${role}.csv`],
        async () => (await query("select filename from radar_import_batches order by filename")).rows,
      );
    }
  });

  test("a Data API role cannot plant a transcript that scoreCandidate sends as interview evidence", async () => {
    const planted: string[] = [];
    for (const role of DATA_API_ROLES) {
      const marker = `${FORGED_TRANSCRIPT}-${role}`;
      const write = await asDataApi(
        role,
        `update candidate_working_files
           set workspace = jsonb_build_object('transcript', $2::text)
         where candidate_id = $1`,
        [CANDIDATE, marker],
      );
      let evidence = "";
      let scoreError = "";
      if (write.ok && write.rowCount > 0) {
        process.env.SUPABASE_URL = "http://127.0.0.1";
        process.env.SUPABASE_SERVICE_KEY = "test-service-key-placeholder";
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.WORKABLE_TOKEN;
        delete process.env.WORKABLE_API_KEY;
        (globalThis as { __rdiScoreInputs?: unknown[] }).__rdiScoreInputs = [];
        try {
          const { scoreCandidate } = await import("../src/lib/scoring/run-score.ts");
          await scoreCandidate(CANDIDATE, { force: true, trigger: "reproduction" });
          const captured = (globalThis as { __rdiScoreInputs?: Array<{ input?: { interviewEvidence?: string } }> }).__rdiScoreInputs ?? [];
          evidence = captured.at(-1)?.input?.interviewEvidence ?? "";
        } catch (error) {
          scoreError = error instanceof Error ? error.message : String(error);
        }
        planted.push(
          `${role} wrote the transcript and scoreCandidate interviewEvidence=${JSON.stringify(evidence)} ${scoreError}`,
        );
      }
    }
    assert.deepEqual(planted, []);
  });
});
