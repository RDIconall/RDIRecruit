import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { ilike, resetTables, rows, seed, startPostgrestStandIn } from "./postgrest-stand-in.ts";

const ONLY_ID = "cand_only";
const OTHER_ID = "cand_other";
const UNDERSCORE_ID = "cand_jane_x";
const TRANSCRIPT = "We discussed the role and the candidate's last project.";

let closeServer: () => Promise<void>;
let postRoute: (typeof import("../src/app/api/ingest/fireflies/route.ts"))["POST"];

test.before(async () => {
  const server = await startPostgrestStandIn();
  closeServer = server.close;
  process.env.SUPABASE_URL = server.url;
  process.env.SUPABASE_SERVICE_KEY = "test-service-role-placeholder";
  delete process.env.ANTHROPIC_API_KEY;
  postRoute = (await import("../src/app/api/ingest/fireflies/route.ts")).POST;
});

test.after(async () => {
  await closeServer();
});

function seedApplicants(): void {
  resetTables();
  seed("candidates", {
    workable_id: ONLY_ID,
    email: "Only.One@Secret.Example",
    name: "Only One",
    job_shortcode: "JOB1",
  });
  seed("candidates", {
    workable_id: OTHER_ID,
    email: "other.person@secret.example",
    name: "Other Person",
    job_shortcode: "JOB1",
  });
  seed("candidates", {
    workable_id: UNDERSCORE_ID,
    email: "janeXdoe@secret.example",
    name: "Jane X Doe",
    job_shortcode: "JOB1",
  });
}

async function post(payload: Record<string, unknown>) {
  const request = new NextRequest("http://localhost/api/ingest/fireflies", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const response = await postRoute(request);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function evidenceFor(candidateId: string) {
  return rows("evidence").filter((row) => row.candidate_id === candidateId);
}

test("ilike stand-in keeps percent, underscore, and star as wildcards", () => {
  assert.equal(ilike("Only.One@Secret.Example", "only%@secret.example"), true);
  assert.equal(ilike("other.person@secret.example", "only%@secret.example"), false);
  assert.equal(ilike("janeXdoe@secret.example", "jane_doe@secret.example"), true);
  assert.equal(ilike("Only.One@Secret.Example", "only*@secret.example"), true);
  assert.equal(ilike("Only.One@Secret.Example", "only.one@secret.example"), true);
  assert.equal(ilike("other.person@secret.example", "only.one@secret.example"), false);
});

test("a unique percent wildcard must not disclose the applicant or store the transcript", async () => {
  seedApplicants();
  const { body } = await post({
    title: "Screen",
    transcript: TRANSCRIPT,
    participants: ["only%@secret.example"],
  });

  assert.deepEqual(
    {
      candidateId: body.candidateId ?? null,
      leakedStoredAddress: JSON.stringify(body).includes("Only.One@Secret.Example"),
      evidence: evidenceFor(ONLY_ID).length,
      otherEvidence: evidenceFor(OTHER_ID).length,
      analyses: rows("candidate_analyses").length,
    },
    {
      candidateId: null,
      leakedStoredAddress: false,
      evidence: 0,
      otherEvidence: 0,
      analyses: 0,
    },
  );
});

test("an underscore wildcard must not resolve a different address", async () => {
  seedApplicants();
  const { body } = await post({
    title: "Screen",
    transcript: TRANSCRIPT,
    participants: ["jane_doe@secret.example"],
  });

  assert.equal(body.candidateId, undefined);
  assert.equal(JSON.stringify(body).includes(UNDERSCORE_ID), false);
  assert.equal(evidenceFor(UNDERSCORE_ID).length, 0);
});

test("a PostgREST star wildcard must not resolve an applicant", async () => {
  seedApplicants();
  const { body } = await post({
    title: "Screen",
    transcript: TRANSCRIPT,
    participants: ["only*@secret.example"],
  });

  assert.equal(body.candidateId, undefined);
  assert.equal(evidenceFor(ONLY_ID).length, 0);
});

test("object attendee and bare-string participant patterns must not resolve an applicant", async () => {
  seedApplicants();
  const asObject = await post({
    title: "Screen",
    transcript: TRANSCRIPT,
    meeting_attendees: [{ email: "only%@secret.example" }],
  });
  assert.equal(asObject.body.candidateId, undefined);
  assert.equal(evidenceFor(ONLY_ID).length, 0);

  const asString = await post({
    title: "Screen",
    transcript: TRANSCRIPT,
    participants: "only%@secret.example",
  });
  assert.equal(asString.body.candidateId, undefined);
  assert.equal(evidenceFor(ONLY_ID).length, 0);
});

test("an ambiguous wildcard must not attach the transcript to either applicant", async () => {
  seedApplicants();
  const { body } = await post({
    title: "Screen",
    transcript: TRANSCRIPT,
    participants: ["%@secret.example"],
  });

  assert.equal(body.candidateId, undefined);
  assert.equal(JSON.stringify(body).includes(ONLY_ID), false);
  assert.equal(JSON.stringify(body).includes(OTHER_ID), false);
  assert.equal(rows("evidence").length, 0);
});

test("an exact address still resolves case-insensitively and stores evidence only for that applicant", async () => {
  seedApplicants();
  const { status, body } = await post({
    title: "Screen",
    transcript: TRANSCRIPT,
    participants: ["only.one@secret.example"],
  });

  assert.equal(status, 200);
  assert.equal(body.candidateId, ONLY_ID);
  assert.equal(evidenceFor(ONLY_ID).length, 1);
  assert.equal(evidenceFor(ONLY_ID)[0]?.transcript, TRANSCRIPT);
  assert.equal(evidenceFor(ONLY_ID)[0]?.source_type, "fireflies");
  assert.equal(evidenceFor(OTHER_ID).length, 0);
  assert.equal(evidenceFor(UNDERSCORE_ID).length, 0);
});

test("a gradeable applicant is not scored from a wildcard participant", () => {
  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "tests/fireflies-wildcard-queue-probe.ts"],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: "anthropic-test-placeholder",
      },
    },
  );
  assert.equal(
    result.status,
    0,
    `queue probe failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  const report = JSON.parse(result.stdout) as {
    candidateId?: string | null;
    evidence: number;
    analyses: number;
  };
  assert.deepEqual(
    {
      candidateId: report.candidateId ?? null,
      evidence: report.evidence,
      analyses: report.analyses,
    },
    { candidateId: null, evidence: 0, analyses: 0 },
  );
});
