/**
 * Authorization spec for applicant data and hiring writes.
 *
 * Clerk's auth() reports a userId for every signed-in session (JWT `sub`) and
 * auth.protect() with no role, permission, or organization argument accepts
 * that session. These tests require a second check, on each server action and
 * candidate API, that the same user is on HIRING_ADMIN_EMAILS.
 *
 * Allowlist contract (read on every call, not only at middleware):
 * - process.env.HIRING_ADMIN_EMAILS is a comma-separated list. The zod env
 *   object strips unknown keys, so read process.env or add the key to the schema.
 * - Compare case-insensitively, after trimming, to the session user's
 *   emailAddresses[0].emailAddress (the field the app already treats as the
 *   user's email). currentUser() is null when there is no userId and otherwise
 *   loads that same user; if it throws, or the user has no email, refuse.
 * - Refuse before any Workable or Supabase request and before revalidatePath.
 * - A granted call may touch only the candidate id and job shortcode from that
 *   call's argument. The Workable member id stays the env placeholder.
 *
 * The stand-in under tests/support replaces @clerk/nextjs/server only inside
 * this file. It follows the installed @clerk/nextjs 7.5.2 and @clerk/backend
 * 3.7.0 shapes: signed-in userId, null orgRole, currentUser tied to that userId.
 *
 * Not covered here:
 * - Radar actions. requireAuth throws while RADAR_ENABLED is false, before any
 *   read or write (src/app/actions/radar.ts).
 * - extractRubricFromFile. It parses an upload the caller already holds.
 * - Cron and webhook routes. They use their own shared secrets, not a Clerk session.
 */
import "./support/install-cjs-mocks.cjs";
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { revalidatedPaths, resetCacheStandin } from "./support/next-cache-standin.cjs";
import { resetSession } from "./support/clerk-session-standin.cjs";

const CANDIDATE_ID = "cand_victim";
const OTHER_ID = "cand_other";
const JOB = "JOB1";
const OTHER_JOB = "JOB_OTHER";
const REASON = "not a fit";
const SPEC = "POISON SPEC marker-spec-9f3a";
const RUBRIC = "RUBRIC SECRET marker-rubric-9f3a";
const PII = {
  name: "Casey Applicant",
  email: "casey.applicant@applicant.example",
  phone: "+1-555-0100",
  address: "1 Example Street, Van Nuys, CA",
  salary: "ask-180000-usd",
  resume: "RESUME TEXT marker-resume-9f3a",
  note: "INTERVIEW NOTE marker-note-9f3a",
  file: "WORKING FILE marker-file-9f3a",
};

const ADMIN = {
  userId: "user_admin",
  email: "Hiring-Admin@RDITrials.example",
  firstName: "Hiring",
  lastName: "Admin",
};
const OUTSIDER = {
  userId: "user_outsider",
  email: "outsider@attacker.example",
  firstName: "Out",
  lastName: "Sider",
};

interface Call {
  url: string;
  method: string;
  body: string;
}

const calls: Call[] = [];

function installFetch() {
  calls.length = 0;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method || (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    const body = init?.body == null ? "" : typeof init.body === "string" ? init.body : String(init.body);
    calls.push({ url, method, body });
    return answer(url, method, headerValue(init?.headers, "accept"));
  };
}

function headerValue(headers: HeadersInit | undefined, name: string): string {
  if (!headers) return "";
  if (headers instanceof Headers) return headers.get(name) ?? "";
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name);
    return found ? String(found[1]) : "";
  }
  const record = headers as Record<string, string>;
  const key = Object.keys(record).find((item) => item.toLowerCase() === name);
  return key ? String(record[key]) : "";
}

function answer(url: string, method: string, accept: string): Response {
  const json = (value: unknown, status = 200) =>
    new Response(value == null ? "null" : JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });

  if (url.includes("workable.com")) {
    if (url.includes("/stages")) {
      return json({
        stages: [
          { slug: "applied", name: "Applied", kind: "applied", position: 0 },
          { slug: "phone-screen", name: "Phone Screen", kind: "interview", position: 1 },
        ],
      });
    }
    if (method === "GET") {
      const id = url.includes(OTHER_ID) ? OTHER_ID : CANDIDATE_ID;
      return json({
        candidate: { id, name: PII.name, email: PII.email, tags: [] },
        candidates: [],
        jobs: [],
        activities: [],
      });
    }
    return new Response("", { status: 200 });
  }

  if (url.includes("/storage/v1/object/sign/")) {
    const path = url.split("/object/sign/")[1] ?? "";
    return json({ signedURL: `/object/sign/${path}?token=placeholder` });
  }

  if (url.includes("supabase.co")) {
    const parsed = new URL(url);
    const table = parsed.pathname.split("/").filter(Boolean).pop() ?? "";
    const filter = parsed.search;
    const addressed = filter.includes(CANDIDATE_ID) || filter.includes(JOB);
    const wantsObject = accept.includes("pgrst.object");
    if (!addressed && method === "GET") return json(wantsObject ? null : []);
    const row = supabaseRow(table);
    if (method === "GET") return json(wantsObject ? row : row ? [row] : []);
    return json(wantsObject ? row ?? {} : [], 201);
  }

  return new Response("", { status: 404 });
}

function supabaseRow(table: string): Record<string, unknown> | null {
  if (table === "candidates") {
    return {
      workable_id: CANDIDATE_ID,
      job_shortcode: JOB,
      name: PII.name,
      email: PII.email,
      phone: PII.phone,
      location: PII.address,
      stage: "Applied",
      stage_kind: null,
      disqualified: false,
      source: "applied",
      assignee_id: null,
      raw: { address: PII.address },
      photo_url: null,
      created_at: "2026-01-01T00:00:00.000Z",
      synced_at: "2026-01-01T00:00:00.000Z",
    };
  }
  if (table === "applications") {
    return {
      candidate_id: CANDIDATE_ID,
      resume_text: PII.resume,
      resume_url: "https://files.example/resume.pdf",
      resume_storage_path: `resumes/${CANDIDATE_ID}.pdf`,
      resume_mime: "application/pdf",
      cover_letter: PII.name,
      answers: { salary: PII.salary },
      parsed_experience: [],
    };
  }
  if (table === "candidate_working_files") {
    return {
      candidate_id: CANDIDATE_ID,
      content: `${PII.file} ${PII.name} ${PII.email} ${PII.salary} ${PII.note}`,
      read: null,
      workspace: {},
      updated_at: "2026-01-01T00:00:00.000Z",
      updated_by: null,
    };
  }
  if (table === "job_rubrics") {
    return { job_shortcode: JOB, rubric_md: RUBRIC, spec_md: SPEC };
  }
  if (table === "evidence") {
    return {
      candidate_id: CANDIDATE_ID,
      source_type: "interview",
      transcript: PII.note,
      label: "Phone screen",
      captured_at: "2026-01-01T00:00:00.000Z",
    };
  }
  if (table === "jobs") {
    return { shortcode: JOB, title: "Clinical Lead", status: "published", raw: {} };
  }
  return null;
}

function forbiddenCalls(): Call[] {
  return calls.filter((call) => /workable\.com|supabase\.co/i.test(call.url));
}

function blob(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function run(fn: () => Promise<unknown>) {
  resetCacheStandin();
  installFetch();
  try {
    const value = await fn();
    if (value instanceof Response) {
      const body = await value.text();
      return { thrown: null as Error | null, value: { status: value.status, body } };
    }
    return { thrown: null as Error | null, value };
  } catch (error) {
    return { thrown: error as Error, value: null };
  }
}

function assertRefused(outcome: { thrown: Error | null; value: unknown }) {
  const leaked = forbiddenCalls().map((call) => `${call.method} ${call.url}`);
  assert.deepEqual(leaked, [], `refused session still called:\n${leaked.join("\n")}`);
  assert.deepEqual([...revalidatedPaths], []);
  const serialized = blob(outcome.value);
  for (const secret of Object.values(PII)) {
    assert.equal(serialized.includes(secret), false, `refused result contained ${secret}`);
  }
  assert.equal(serialized.includes(RUBRIC), false);
  assert.equal(serialized.includes(SPEC), false);
  if (outcome.thrown) {
    assert.match(outcome.thrown.message, /unauthorized|forbidden|not allowed|allowlist/i);
    return;
  }
  const value = outcome.value as { ok?: boolean; status?: number; content?: string } | null;
  if (value && typeof value.status === "number") {
    assert.ok(value.status === 401 || value.status === 403, `expected 401 or 403, got ${value.status}`);
    return;
  }
  if (value && "ok" in value) {
    assert.equal(value.ok, false);
    return;
  }
  if (value && "content" in value) {
    assert.equal(value.content ?? "", "");
  }
}

function assertOnlyCandidate(id: string) {
  for (const call of forbiddenCalls()) {
    assert.equal(call.url.includes(OTHER_ID), false, call.url);
    assert.equal(call.url.includes(OTHER_JOB), false, call.url);
    assert.equal(call.body.includes(OTHER_ID), false, call.body);
    assert.equal(call.body.includes(OTHER_JOB), false, call.body);
    if (call.url.includes("workable.com") && /\/candidates\/[^/]+/.test(call.url)) {
      assert.match(call.url, new RegExp(`/candidates/${id}(?:/|$)`));
    }
  }
}

type Action = (...args: unknown[]) => Promise<unknown>;
type Actions = Record<string, Action>;

let candidates: Actions;
let triage: Actions;
let rubrics: Actions;
let recompute: Actions;
let interviews: Actions;
let calibration: Actions;
let candidateRoute: { GET: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response> };
let resumeRoute: { GET: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response> };
let jobsRoute: { GET: () => Promise<Response> };
let homePage: (props: { searchParams: Promise<{ job?: string }> }) => Promise<{ props?: { pool?: unknown } }>;

before(async () => {
  candidates = (await import("../src/app/actions/candidates.ts")) as unknown as Actions;
  triage = (await import("../src/app/actions/triage.ts")) as unknown as Actions;
  rubrics = (await import("../src/app/actions/rubrics.ts")) as unknown as Actions;
  recompute = (await import("../src/app/actions/recompute.ts")) as unknown as Actions;
  interviews = (await import("../src/app/actions/interviews.ts")) as unknown as Actions;
  calibration = (await import("../src/app/actions/calibration.ts")) as unknown as Actions;
  candidateRoute = await import("../src/app/api/candidates/[id]/route.ts");
  resumeRoute = await import("../src/app/api/candidates/[id]/resume/route.ts");
  jobsRoute = await import("../src/app/api/jobs/route.ts");
  const page = await import("../src/app/page.tsx");
  homePage = page.default;
});

function outsider() {
  resetSession(OUTSIDER);
}
function admin() {
  resetSession(ADMIN);
}

const writes: Array<{ name: string; run: () => Promise<unknown> }> = [
  {
    name: "denyCandidate disqualifies the supplied Workable id",
    run: () => candidates.denyCandidate({ jobShortcode: JOB, candidateId: CANDIDATE_ID, reason: REASON }),
  },
  {
    name: "advanceCandidate moves the supplied Workable id",
    run: () => candidates.advanceCandidate({ jobShortcode: JOB, candidateId: CANDIDATE_ID, currentStage: "applied" }),
  },
  {
    name: "holdCandidate tags and comments on the supplied Workable id",
    run: () => candidates.holdCandidate({ jobShortcode: JOB, candidateId: CANDIDATE_ID }),
  },
  {
    name: "withdrawCandidate writes a withdrawn overlay",
    run: () => candidates.withdrawCandidate({ jobShortcode: JOB, candidateId: CANDIDATE_ID }),
  },
  {
    name: "restoreCandidate writes an active overlay",
    run: () => candidates.restoreCandidate({ jobShortcode: JOB, candidateId: CANDIDATE_ID }),
  },
  {
    name: "bulkCandidateAction deny walks each supplied id",
    run: () => candidates.bulkCandidateAction({ jobShortcode: JOB, candidateIds: [CANDIDATE_ID], action: "deny" }),
  },
  {
    name: "syncPipeline mirrors the Workable account",
    run: () => candidates.syncPipeline(),
  },
  {
    name: "setDisqualified pushes a Workable disqualify",
    run: () => triage.setDisqualified({ candidateId: CANDIDATE_ID, disqualified: true, reason: REASON }),
  },
  {
    name: "setDisqualified revert pushes a Workable revert",
    run: () => triage.setDisqualified({ candidateId: CANDIDATE_ID, disqualified: false }),
  },
  {
    name: "bulkDisqualify pushes each supplied id",
    run: () => triage.bulkDisqualify({ candidateIds: [CANDIDATE_ID], disqualified: true }),
  },
  {
    name: "moveCandidateToStage moves the supplied id",
    run: () => triage.moveCandidateToStage({ jobShortcode: JOB, candidateId: CANDIDATE_ID, targetStage: "phone-screen" }),
  },
  {
    name: "sendCandidateToScreen moves the supplied id",
    run: () => triage.sendCandidateToScreen({ jobShortcode: JOB, candidateId: CANDIDATE_ID }),
  },
  {
    name: "saveJobRubric writes the supplied spec",
    run: () => triage.saveJobRubric({ jobShortcode: JOB, specMd: SPEC, rubricMd: RUBRIC }),
  },
  {
    name: "getJobRubricContent reads the grader rubric",
    run: () => triage.getJobRubricContent({ jobShortcode: JOB }),
  },
  {
    name: "getWorkingFileContent reads the candidate file",
    run: () => triage.getWorkingFileContent({ candidateId: CANDIDATE_ID }),
  },
  {
    name: "saveCorrection writes the candidate file",
    run: () => triage.saveCorrection({ candidateId: CANDIDATE_ID, text: "correction" }),
  },
  {
    name: "saveTranscript stores an interview transcript",
    run: () => triage.saveTranscript({ candidateId: CANDIDATE_ID, transcript: PII.note }),
  },
  {
    name: "runDeepAnalysis regrades the candidate",
    run: () => triage.runDeepAnalysis({ candidateId: CANDIDATE_ID }),
  },
  {
    name: "saveReply writes the candidate file",
    run: () => triage.saveReply({ candidateId: CANDIDATE_ID, key: "note", value: "reply" }),
  },
  {
    name: "saveTimeline writes the candidate file",
    run: () => triage.saveTimeline({ candidateId: CANDIDATE_ID, ovr: [] }),
  },
  {
    name: "setDecision overrides the hiring decision",
    run: () => triage.setDecision({ candidateId: CANDIDATE_ID, decision: "reject" }),
  },
  {
    name: "setProcessStatus writes the candidate file",
    run: () => triage.setProcessStatus({ candidateId: CANDIDATE_ID, status: "interviewing" }),
  },
  {
    name: "reanalyze regrades the candidate",
    run: () => triage.reanalyze({ candidateId: CANDIDATE_ID }),
  },
  {
    name: "compareToRubric regrades the candidate",
    run: () => triage.compareToRubric({ candidateId: CANDIDATE_ID }),
  },
  {
    name: "logActivity writes a candidate note",
    run: () => triage.logActivity({ candidateId: CANDIDATE_ID, type: "note", body: PII.note }),
  },
  {
    name: "updateAssessment regrades the candidate",
    run: () => triage.updateAssessment({ candidateId: CANDIDATE_ID }),
  },
  {
    name: "sendCandidateChat reads and writes the candidate file",
    run: () => triage.sendCandidateChat({ candidateId: CANDIDATE_ID, message: "hello" }),
  },
  {
    name: "clearCandidateChat wipes the candidate thread",
    run: () => triage.clearCandidateChat({ candidateId: CANDIDATE_ID }),
  },
  {
    name: "resyncCandidate pulls the Workable record",
    run: () => triage.resyncCandidate({ candidateId: CANDIDATE_ID }),
  },
  {
    name: "saveRubric replaces the active rubric",
    run: () => rubrics.saveRubric({ jobShortcode: JOB, markdown: RUBRIC }),
  },
  {
    name: "saveMethod replaces the grader method",
    run: () => rubrics.saveMethod("# method"),
  },
  {
    name: "getActiveRubricMarkdown reads the active rubric",
    run: () => rubrics.getActiveRubricMarkdown(JOB),
  },
  {
    name: "saveRubricAndRecompute writes the rubric and rescores",
    run: () => recompute.saveRubricAndRecompute({ jobShortcode: JOB, markdown: RUBRIC }),
  },
  {
    name: "rescoreJobWithActiveRubric rescores the seat with no session check of its own",
    run: () => recompute.rescoreJobWithActiveRubric(JOB, 0),
  },
  {
    name: "addInterviewEvidence stores a transcript",
    run: () =>
      interviews.addInterviewEvidence({
        candidateId: CANDIDATE_ID,
        jobShortcode: JOB,
        kind: "interview",
        label: "Onsite",
        transcript: PII.note,
      }),
  },
  {
    name: "addVideoAskAnswers stores applicant answers",
    run: () =>
      interviews.addVideoAskAnswers({
        candidateId: CANDIDATE_ID,
        jobShortcode: JOB,
        answers: PII.note,
      }),
  },
  {
    name: "submitReadAdjustment writes calibration against the candidate",
    run: () =>
      calibration.submitReadAdjustment({
        candidateId: CANDIDATE_ID,
        jobShortcode: JOB,
        candidateName: PII.name,
        direction: "lower",
        note: "too junior",
      }),
  },
];

for (const operation of writes) {
  test(`outsider is refused before ${operation.name}`, async () => {
    outsider();
    assertRefused(await run(operation.run));
  });
}

test("outsider is refused before GET /api/candidates/[id] returns the applicant file", async () => {
  outsider();
  assertRefused(
    await run(() =>
      candidateRoute.GET(new Request(`http://localhost/api/candidates/${CANDIDATE_ID}`), {
        params: Promise.resolve({ id: CANDIDATE_ID }),
      }),
    ),
  );
});

test("outsider is refused before GET /api/candidates/[id]/resume signs the résumé", async () => {
  outsider();
  assertRefused(
    await run(() =>
      resumeRoute.GET(new Request(`http://localhost/api/candidates/${CANDIDATE_ID}/resume`), {
        params: Promise.resolve({ id: CANDIDATE_ID }),
      }),
    ),
  );
});

test("outsider is refused before GET /api/jobs", async () => {
  outsider();
  assertRefused(await run(() => jobsRoute.GET()));
});

test("outsider is refused before the home page loads the applicant pool", async () => {
  outsider();
  assertRefused(await run(() => homePage({ searchParams: Promise.resolve({ job: JOB }) })));
});

test("signed-out denyCandidate does not call Workable", async () => {
  resetSession({});
  assertRefused(await run(() => candidates.denyCandidate({ jobShortcode: JOB, candidateId: CANDIDATE_ID, reason: REASON })));
});

test("a signed-in user whose Clerk profile cannot be loaded is refused before Workable", async () => {
  resetSession({ ...OUTSIDER, throwOnCurrentUser: true });
  assertRefused(await run(() => candidates.denyCandidate({ jobShortcode: JOB, candidateId: CANDIDATE_ID, reason: REASON })));
});

test("a signed-in user with no email address is refused before Workable", async () => {
  resetSession({ userId: "user_no_email", email: null, firstName: "No", lastName: "Email" });
  assertRefused(await run(() => candidates.denyCandidate({ jobShortcode: JOB, candidateId: CANDIDATE_ID, reason: REASON })));
});

test("allowlisted admin denyCandidate disqualifies only the requested id", async () => {
  admin();
  const outcome = await run(() =>
    candidates.denyCandidate({ jobShortcode: JOB, candidateId: CANDIDATE_ID, reason: REASON }),
  );
  assert.equal(outcome.thrown, null);
  assert.equal((outcome.value as { ok?: boolean }).ok, true);
  const disqualify = calls.filter(
    (call) => call.method === "POST" && call.url === `https://rditrials.workable.com/spi/v3/candidates/${CANDIDATE_ID}/disqualify`,
  );
  assert.equal(disqualify.length, 1);
  const body = JSON.parse(disqualify[0].body) as { member_id?: string; disqualify_note?: string };
  assert.equal(body.member_id, process.env.WORKABLE_MEMBER_ID);
  assert.equal(body.disqualify_note, REASON);
  const overlay = calls.find((call) => call.method === "POST" && call.url.endsWith("/candidate_overlay"));
  assert.ok(overlay, "local disqualified overlay was not written");
  const overlayBody = JSON.parse(overlay.body) as { candidate_id?: string; status?: string };
  assert.equal(overlayBody.candidate_id, CANDIDATE_ID);
  assert.equal(overlayBody.status, "disqualified");
  assertOnlyCandidate(CANDIDATE_ID);
});

test("allowlisted admin advanceCandidate moves only the requested id", async () => {
  admin();
  const outcome = await run(() =>
    candidates.advanceCandidate({ jobShortcode: JOB, candidateId: CANDIDATE_ID, currentStage: "applied" }),
  );
  assert.equal(outcome.thrown, null);
  const move = calls.filter(
    (call) => call.method === "POST" && call.url === `https://rditrials.workable.com/spi/v3/candidates/${CANDIDATE_ID}/move`,
  );
  assert.equal(move.length, 1);
  const body = JSON.parse(move[0].body) as { member_id?: string; target_stage?: string };
  assert.equal(body.member_id, process.env.WORKABLE_MEMBER_ID);
  assert.equal(body.target_stage, "phone-screen");
  assertOnlyCandidate(CANDIDATE_ID);
});

test("allowlisted admin holdCandidate writes tags for only the requested id", async () => {
  admin();
  await run(() => candidates.holdCandidate({ jobShortcode: JOB, candidateId: CANDIDATE_ID }));
  const tags = calls.filter(
    (call) => call.method === "PUT" && call.url === `https://rditrials.workable.com/spi/v3/candidates/${CANDIDATE_ID}/tags`,
  );
  assert.equal(tags.length, 1);
  assert.equal(JSON.parse(tags[0].body).tags.includes("hold-rdi"), true);
  assertOnlyCandidate(CANDIDATE_ID);
});

test("allowlisted admin bulkCandidateAction disqualifies each requested id and no other", async () => {
  admin();
  await run(() =>
    candidates.bulkCandidateAction({
      jobShortcode: JOB,
      candidateIds: [CANDIDATE_ID, "cand_second"],
      action: "deny",
    }),
  );
  const ids = calls
    .filter((call) => call.method === "POST" && call.url.endsWith("/disqualify"))
    .map((call) => call.url);
  assert.deepEqual(ids.sort(), [
    `https://rditrials.workable.com/spi/v3/candidates/${CANDIDATE_ID}/disqualify`,
    "https://rditrials.workable.com/spi/v3/candidates/cand_second/disqualify",
  ].sort());
  assert.equal(calls.some((call) => call.url.includes(OTHER_ID)), false);
});

test("allowlisted admin saveJobRubric persists the submitted spec for that job only", async () => {
  admin();
  const outcome = await run(() => triage.saveJobRubric({ jobShortcode: JOB, specMd: SPEC, rubricMd: RUBRIC }));
  assert.equal(outcome.thrown, null);
  assert.equal((outcome.value as { ok?: boolean }).ok, true);
  const write = calls.find((call) => call.method === "POST" && call.url.includes("/job_rubrics"));
  assert.ok(write);
  const body = JSON.parse(write.body) as { job_shortcode?: string; spec_md?: string; rubric_md?: string };
  assert.equal(body.job_shortcode, JOB);
  assert.equal(body.spec_md, SPEC);
  assert.equal(body.rubric_md, RUBRIC);
  assert.equal(write.body.includes(OTHER_JOB), false);
});

test("allowlisted admin GET /api/candidates/[id] returns that applicant and not another", async () => {
  admin();
  const outcome = await run(() =>
    candidateRoute.GET(new Request(`http://localhost/api/candidates/${CANDIDATE_ID}`), {
      params: Promise.resolve({ id: CANDIDATE_ID }),
    }),
  );
  assert.equal(outcome.thrown, null);
  const value = outcome.value as { status: number; body: string };
  assert.equal(value.status, 200);
  const detail = JSON.parse(value.body) as { candidate?: { workable_id?: string; email?: string; phone?: string; location?: string } };
  assert.equal(detail.candidate?.workable_id, CANDIDATE_ID);
  assert.equal(detail.candidate?.email, PII.email);
  assert.equal(detail.candidate?.phone, PII.phone);
  assert.equal(detail.candidate?.location, PII.address);
  assert.equal(value.body.includes(OTHER_ID), false);
  const reads = calls.filter((call) => call.url.includes("/candidates") && call.method === "GET");
  assert.ok(reads.some((call) => call.url.includes(CANDIDATE_ID)));
  assert.equal(reads.some((call) => call.url.includes(OTHER_ID)), false);
});

test("allowlisted admin résumé route signs only the requested candidate file", async () => {
  admin();
  const outcome = await run(() =>
    resumeRoute.GET(new Request(`http://localhost/api/candidates/${CANDIDATE_ID}/resume`), {
      params: Promise.resolve({ id: CANDIDATE_ID }),
    }),
  );
  assert.equal(outcome.thrown, null);
  const value = outcome.value as { status: number; body: string };
  assert.equal(value.status, 200);
  assert.match(value.body, new RegExp(CANDIDATE_ID));
  assert.equal(value.body.includes(OTHER_ID), false);
  const signed = calls.filter((call) => call.method === "POST" && call.url.includes("/object/sign/"));
  assert.equal(signed.length, 1);
  assert.match(signed[0].url, new RegExp(CANDIDATE_ID));
});

test("allowlisted admin getWorkingFileContent returns only that candidate file", async () => {
  admin();
  const outcome = await run(() => triage.getWorkingFileContent({ candidateId: CANDIDATE_ID }));
  assert.equal(outcome.thrown, null);
  const content = (outcome.value as { content?: string }).content ?? "";
  assert.match(content, new RegExp(PII.email));
  const reads = calls.filter((call) => call.url.includes("candidate_working_files"));
  assert.ok(reads.every((call) => call.url.includes(CANDIDATE_ID)));
  assert.equal(reads.some((call) => call.url.includes(OTHER_ID)), false);
});

test("allowlisted admin home page loads the requested job pool", async () => {
  admin();
  const outcome = await run(() => homePage({ searchParams: Promise.resolve({ job: JOB }) }));
  assert.equal(outcome.thrown, null);
  const serialized = blob(outcome.value);
  assert.match(serialized, new RegExp(PII.name));
  assert.equal(serialized.includes(OTHER_JOB), false);
  assert.ok(calls.some((call) => call.url.includes("supabase.co")));
});
