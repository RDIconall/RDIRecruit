/**
 * Founder-identity spoofing. These tests fail while a signed-in ordinary
 * account can stamp Lara's or Conall's reviewer signal, correction, activity
 * author, or grading-prompt attribution.
 *
 * The fix they specify:
 * - Ignore caller-supplied `reviewerKind` and `author`.
 * - Persist the Clerk user id (`auth().userId` / `currentUser().id`) as the
 *   actor on every write these tests cover (`reviewerId`, `author`,
 *   `updated_by`, interview `author` / `extracted.interviewer`, chat `author`).
 * - Map Lara and Conall only from an allowlist of Clerk user ids, read at
 *   call time from:
 *     FOUNDER_CLERK_IDS_LARA    comma-separated Clerk user ids
 *     FOUNDER_CLERK_IDS_CONALL  comma-separated Clerk user ids
 *   A display name or email is not part of that decision, including when the
 *   text contains "lara" or "conall".
 * - An allowlisted id is that founder even when the Clerk profile name is
 *   unrelated and even when the request asks for the other founder. The
 *   stored correction label and the grading prompt's recruiter-note prefix
 *   for that founder are "Lara" or "Conall".
 *
 * Run:
 *   node --import tsx --test tests/founder-identity.test.ts
 *
 * The suite is expected to fail until the vulnerability is fixed.
 */
import assert from "node:assert/strict";
import { createRequire, register } from "node:module";
import { before, test } from "node:test";

const require = createRequire(import.meta.url);
process.env.FOUNDER_IDENTITY_TEST = "1";
require("./founder-identity/install.cjs");
register(new URL("./founder-identity/hook.mjs", import.meta.url), import.meta.url);
process.env.SUPABASE_URL = "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_KEY = "placeholder-not-a-real-key";
process.env.FOUNDER_CLERK_IDS_LARA = "user_lara_allowlisted";
process.env.FOUNDER_CLERK_IDS_CONALL = "user_conall_allowlisted";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.WORKABLE_TOKEN;
delete process.env.WORKABLE_API_KEY;

type Harness = {
  user: ClerkUser | null;
  tables: Record<string, any[]>;
  writes: { table: string; op: string; row: any }[];
  grading: { candidateId: string; input: any; trigger: string }[];
  idSeq: number;
};

let harness: () => Harness;
let resetHarness: () => void;
let triage: typeof import("../src/app/actions/triage.ts");
let interviews: typeof import("../src/app/actions/interviews.ts");
let candidates: typeof import("../src/app/actions/candidates.ts");
let mapCandidate: typeof import("../src/lib/triage/from-supabase.ts").mapCandidate;
let scoreCandidate: typeof import("../src/lib/scoring/run-score.ts").scoreCandidate;
let buildEvaluatorRequest: typeof import("../src/lib/scoring/evaluator.ts").buildEvaluatorRequest;

before(async () => {
  ({ harness, resetHarness } = await import("./founder-identity/state.cjs"));
  triage = await import("../src/app/actions/triage.ts");
  interviews = await import("../src/app/actions/interviews.ts");
  candidates = await import("../src/app/actions/candidates.ts");
  ({ mapCandidate } = await import("../src/lib/triage/from-supabase.ts"));
  ({ scoreCandidate } = await import("../src/lib/scoring/run-score.ts"));
  ({ buildEvaluatorRequest } = await import("../src/lib/scoring/evaluator.ts"));
});

type ReviewerKind = "conall" | "lara" | "other";

interface ClerkUser {
  id: string;
  firstName: string | null;
  lastName: string | null;
  emailAddresses: { emailAddress: string }[];
}

const ORDINARY_ID = "user_ordinary";
const LARA_ID = "user_lara_allowlisted";
const CANDIDATE_ID = "cand_ordinary_target";
const NOTE = "Do not interview this candidate.";

const FOUNDER_LABELS = new Set(["lara", "conall"]);
const FOUNDER_KINDS = new Set(["lara", "conall"]);
const FOUNDER_SIGNALS = new Set([
  "laraNo",
  "laraPos",
  "laraConcern",
  "conallPos",
  "conallConcern",
]);

function user(partial: Partial<ClerkUser> & { id: string }): ClerkUser {
  return {
    id: partial.id,
    firstName: partial.firstName ?? null,
    lastName: partial.lastName ?? null,
    emailAddresses: partial.emailAddresses ?? [],
  };
}

const ordinaryPat = user({
  id: ORDINARY_ID,
  firstName: "Pat",
  lastName: "Recruiter",
  emailAddresses: [{ emailAddress: "pat.recruiter@example.com" }],
});

const ordinaryNamedLara = user({
  id: ORDINARY_ID,
  firstName: "Lara",
  lastName: null,
  emailAddresses: [{ emailAddress: "someone@example.com" }],
});

const ordinarySubstringLara = user({
  id: ORDINARY_ID,
  firstName: "Notlara",
  lastName: "Smith",
  emailAddresses: [{ emailAddress: "notlara.smith@example.com" }],
});

const ordinaryEmailConall = user({
  id: ORDINARY_ID,
  firstName: null,
  lastName: null,
  emailAddresses: [{ emailAddress: "alex.conall@example.com" }],
});

const ordinaryNamedConall = user({
  id: ORDINARY_ID,
  firstName: "Conall",
  lastName: null,
  emailAddresses: [{ emailAddress: "someone-else@example.com" }],
});

const allowlistedLara = user({
  id: LARA_ID,
  firstName: "Pat",
  lastName: "Recruiter",
  emailAddresses: [{ emailAddress: "pat.recruiter@example.com" }],
});

function seedCandidate() {
  const state = harness();
  state.tables.candidates = [
    {
      workable_id: CANDIDATE_ID,
      job_shortcode: "JOB1",
      name: "Casey Example",
      email: "casey@example.com",
      phone: null,
      location: "Los Angeles, CA",
      stage: "applied",
      stage_kind: null,
      disqualified: false,
      source: null,
      assignee_id: null,
      raw: {},
      photo_url: null,
      created_at: "2026-01-01T00:00:00.000Z",
      synced_at: "2026-01-01T00:00:00.000Z",
    },
  ];
}

function acting(next: ClerkUser | null) {
  resetHarness();
  seedCandidate();
  harness().user = next;
}

function identityFields(value: unknown, out: { key: string; value: unknown }[] = []) {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) identityFields(item, out);
    return out;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      key === "reviewerKind" ||
      key === "reviewerLabel" ||
      key === "author" ||
      key === "updated_by" ||
      key === "rev" ||
      key === "interviewer" ||
      key === "reviewerId"
    ) {
      out.push({ key, value: child });
    }
    identityFields(child, out);
  }
  return out;
}

function assertOrdinaryWrites(actorId: string) {
  const fields = harness().writes.flatMap((write: { row: unknown }) => identityFields(write.row));
  for (const field of fields) {
    if (field.value == null || field.value === "") continue;
    if (field.key === "reviewerId") {
      assert.equal(field.value, actorId, `reviewerId ${String(field.value)} is not the signed-in user`);
    } else if (field.key === "reviewerKind") {
      assert.equal(
        FOUNDER_KINDS.has(String(field.value)),
        false,
        `stored reviewerKind ${String(field.value)} for ${actorId}`,
      );
    } else if (field.key === "rev") {
      assert.equal(
        FOUNDER_SIGNALS.has(String(field.value)),
        false,
        `stored reviewer signal ${String(field.value)} for ${actorId}`,
      );
    } else if (field.key === "reviewerLabel" || field.key === "author" || field.key === "updated_by" || field.key === "interviewer") {
      const text = String(field.value).trim().toLowerCase();
      assert.equal(FOUNDER_LABELS.has(text), false, `${field.key} stored founder name ${String(field.value)}`);
      assert.equal(field.value, actorId, `${field.key} must be the Clerk user id, got ${String(field.value)}`);
    }
  }
  for (const write of harness().writes as { row: { content?: string } }[]) {
    const content = write.row?.content;
    if (typeof content === "string") {
      assert.equal(content.includes("(Lara)"), false, content);
      assert.equal(content.includes("(Conall)"), false, content);
    }
  }
}

function latestCorrection(): {
  reviewerId?: string;
  reviewerKind?: string;
  reviewerLabel?: string;
  text?: string;
} {
  const files = (harness().tables.candidate_working_files ?? []) as {
    workspace?: { corrections?: { reviewerId?: string; reviewerKind?: string; reviewerLabel?: string; text?: string }[] };
  }[];
  const corrections = files[0]?.workspace?.corrections ?? [];
  const last = corrections[corrections.length - 1];
  assert.ok(last, "correction was not stored");
  return last;
}

function storedRead(): { rev?: string; revNote?: string; decision?: string } | null {
  const files = (harness().tables.candidate_working_files ?? []) as { read?: { rev?: string; revNote?: string; decision?: string } | null }[];
  return files[0]?.read ?? null;
}

function emptyEvals() {
  return {
    invest: null,
    dig: null,
    verification: null,
    roleReads: [],
    answerGrades: [],
    fitRead: null,
  };
}

test("a signed-out caller cannot write a founder-stamped correction or activity entry", async () => {
  acting(null);
  await assert.rejects(() => triage.saveCorrection({ candidateId: CANDIDATE_ID, text: NOTE, reviewerKind: "lara" }), /Unauthorized/);
  await assert.rejects(
    () => triage.logActivity({ candidateId: CANDIDATE_ID, type: "interview", author: "Lara", body: NOTE }),
    /Unauthorized/,
  );
  await assert.rejects(
    () =>
      interviews.addInterviewEvidence({
        candidateId: CANDIDATE_ID,
        jobShortcode: "JOB1",
        kind: "interview",
        label: "Onsite",
        author: "Conall",
        transcript: NOTE,
      }),
    /Unauthorized/,
  );
  assert.equal(harness().writes.length, 0);
});

for (const kind of ["lara", "conall"] as ReviewerKind[]) {
  test(`saveCorrection ignores a caller-supplied ${kind} kind for an ordinary account`, async () => {
    acting(ordinaryPat);
    const result = await triage.saveCorrection({
      candidateId: CANDIDATE_ID,
      text: NOTE,
      reviewerKind: kind,
    });
    assert.equal(result.ok, true, result.message);
    const correction = latestCorrection();
    assert.equal(correction.text, NOTE);
    assert.equal(correction.reviewerId, ORDINARY_ID);
    assert.equal(FOUNDER_KINDS.has(correction.reviewerKind ?? ""), false);
    assert.notEqual(correction.reviewerLabel?.toLowerCase(), kind === "lara" ? "lara" : "conall");
    const read = storedRead();
    assert.equal(FOUNDER_SIGNALS.has(read?.rev ?? ""), false, read?.revNote);
    assertOrdinaryWrites(ORDINARY_ID);

    const pooled = mapCandidate({
      candidate: harness().tables.candidates[0],
      score: null,
      ro: null,
      overlay: null,
      application: null,
      narrative: [],
      evals: emptyEvals(),
      interviewEvidence: [],
      read: null,
      corrections: [correction],
      rank: 0,
      jobLocation: "Van Nuys, CA",
      jobShortcode: "JOB1",
    });
    assert.equal(FOUNDER_SIGNALS.has(pooled.rev), false, pooled.revNote);
  });
}

for (const [label, persona] of [
  ["display name Lara", ordinaryNamedLara],
  ["display name containing lara", ordinarySubstringLara],
  ["email containing conall", ordinaryEmailConall],
  ["display name Conall", ordinaryNamedConall],
] as const) {
  test(`saveCorrection does not treat ${label} as that founder`, async () => {
    acting(persona);
    const result = await triage.saveCorrection({ candidateId: CANDIDATE_ID, text: NOTE });
    assert.equal(result.ok, true, result.message);
    const correction = latestCorrection();
    assert.equal(correction.reviewerId, ORDINARY_ID);
    assert.equal(FOUNDER_KINDS.has(correction.reviewerKind ?? ""), false, correction.reviewerLabel);
    assert.equal(FOUNDER_LABELS.has((correction.reviewerLabel ?? "").toLowerCase()), false);
    const read = storedRead();
    assert.equal(FOUNDER_SIGNALS.has(read?.rev ?? ""), false, read?.revNote);
    assertOrdinaryWrites(ORDINARY_ID);
  });
}

test("only an allowlisted Clerk user id is stored as Lara, and a requested Conall kind is ignored", async () => {
  acting(allowlistedLara);
  const result = await triage.saveCorrection({
    candidateId: CANDIDATE_ID,
    text: NOTE,
    reviewerKind: "conall",
  });
  assert.equal(result.ok, true, result.message);
  const correction = latestCorrection();
  assert.equal(correction.text, NOTE);
  assert.equal(correction.reviewerId, LARA_ID);
  assert.equal(correction.reviewerKind, "lara");
  assert.equal(correction.reviewerLabel, "Lara");
  const read = storedRead();
  assert.equal(read?.rev, "laraConcern");
  assert.match(read?.revNote ?? "", /^Lara\b/);

  const pooled = mapCandidate({
    candidate: harness().tables.candidates[0],
    score: null,
    ro: null,
    overlay: null,
    application: null,
    narrative: [],
    evals: emptyEvals(),
    interviewEvidence: [],
    read: null,
    corrections: [correction],
    rank: 0,
    jobLocation: "Van Nuys, CA",
    jobShortcode: "JOB1",
  });
  assert.equal(pooled.rev, "laraConcern");
});

test("logActivity ignores a caller-supplied founder author", async () => {
  acting(ordinaryPat);
  const supplied = await triage.logActivity({
    candidateId: CANDIDATE_ID,
    type: "interview",
    author: "Lara",
    body: "Interview notes that must not be attributed to Lara.",
  });
  assert.equal(supplied.ok, true, supplied.message);
  assert.equal(supplied.entry?.author, ORDINARY_ID);
  assert.equal(supplied.entry?.type, "interview");
});

test("logActivity does not store a founder display name as the author", async () => {
  acting(ordinaryNamedConall);
  const named = await triage.logActivity({
    candidateId: CANDIDATE_ID,
    type: "note",
    body: "A note from someone who named their account Conall.",
  });
  assert.equal(named.ok, true, named.message);
  assert.equal(named.entry?.author, ORDINARY_ID);
});

test("saveTranscript does not stamp a founder signal from a display name of Lara", async () => {
  acting(ordinaryNamedLara);
  const transcript = await triage.saveTranscript({
    candidateId: CANDIDATE_ID,
    transcript: "Interviewer: tell me about the audit.\nCandidate: I owned it.",
  });
  assert.equal(transcript.ok, true, transcript.message);
  assert.equal(FOUNDER_SIGNALS.has(storedRead()?.rev ?? ""), false, storedRead()?.revNote);
  assertOrdinaryWrites(ORDINARY_ID);
});

test("compareToRubric does not stamp a founder signal from an email containing conall", async () => {
  acting(ordinaryEmailConall);
  const compared = await triage.compareToRubric({ candidateId: CANDIDATE_ID });
  assert.equal(compared.ok, true, compared.message);
  assert.equal(FOUNDER_SIGNALS.has(storedRead()?.rev ?? ""), false, storedRead()?.revNote);
  assertOrdinaryWrites(ORDINARY_ID);
});

const actorWrites: [string, ClerkUser, () => Promise<unknown>][] = [
  ["runDeepAnalysis", ordinaryNamedLara, () => triage.runDeepAnalysis({ candidateId: CANDIDATE_ID })],
  ["saveReply", ordinaryNamedConall, () => triage.saveReply({ candidateId: CANDIDATE_ID, key: "risk", value: "Ask about the gap." })],
  ["saveTimeline", ordinaryNamedLara, () => triage.saveTimeline({ candidateId: CANDIDATE_ID, ovr: [] })],
  ["setDecision", ordinaryNamedLara, () => triage.setDecision({ candidateId: CANDIDATE_ID, decision: "reject" })],
  ["setProcessStatus", ordinaryNamedConall, () => triage.setProcessStatus({ candidateId: CANDIDATE_ID, status: "interviewing" })],
  ["reanalyze", ordinaryNamedLara, () => triage.reanalyze({ candidateId: CANDIDATE_ID })],
  ["updateAssessment", ordinaryNamedConall, () => triage.updateAssessment({ candidateId: CANDIDATE_ID })],
  ["setDisqualified", ordinaryNamedConall, () => triage.setDisqualified({ candidateId: CANDIDATE_ID, disqualified: true, reason: "Cut" })],
  ["bulkDisqualify", ordinaryNamedLara, () => triage.bulkDisqualify({ candidateIds: [CANDIDATE_ID], disqualified: true })],
  ["saveJobRubric", ordinaryNamedConall, () => triage.saveJobRubric({ jobShortcode: "JOB1", rubricMd: "Judgment first.", specMd: "Own the seat." })],
  ["clearCandidateChat", ordinaryNamedConall, () => triage.clearCandidateChat({ candidateId: CANDIDATE_ID })],
  ["withdrawCandidate", ordinaryNamedLara, () => candidates.withdrawCandidate({ jobShortcode: "JOB1", candidateId: CANDIDATE_ID, reason: "Withdrew" })],
  ["restoreCandidate", ordinaryNamedConall, () => candidates.restoreCandidate({ jobShortcode: "JOB1", candidateId: CANDIDATE_ID })],
];

for (const [name, persona, run] of actorWrites) {
  test(`${name} records the Clerk user id, not a founder display name`, async () => {
    acting(persona);
    const result = await run();
    assert.equal((result as { ok?: boolean }).ok, true);
    assertOrdinaryWrites(ORDINARY_ID);
  });
}

test("sendCandidateChat records the Clerk user id as the message author", async () => {
  acting(ordinaryNamedLara);
  const chat = await triage.sendCandidateChat({ candidateId: CANDIDATE_ID, message: "What should we ask next?" });
  assert.equal(chat.messages.at(-1)?.author, ORDINARY_ID);
  assertOrdinaryWrites(ORDINARY_ID);
});

test("a pasted interview transcript cannot name Lara or Conall as the interviewer", async () => {
  acting(ordinaryPat);
  const result = await interviews.addInterviewEvidence({
    candidateId: CANDIDATE_ID,
    jobShortcode: "JOB1",
    kind: "interview",
    label: "Onsite",
    author: "Lara",
    transcript: "Candidate described owning the audit.",
  });
  assert.equal(result.ok, true);
  const evidence = (harness().tables.evidence ?? []) as {
    author?: string;
    extracted?: { interviewer?: string };
  }[];
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].author, ORDINARY_ID);
  assert.equal(evidence[0].extracted?.interviewer, ORDINARY_ID);
  assertOrdinaryWrites(ORDINARY_ID);
});

test("the next grade includes an ordinary user's correction as their own note, not a founder's", async () => {
  acting(ordinaryPat);
  const saved = await triage.saveCorrection({
    candidateId: CANDIDATE_ID,
    text: NOTE,
    reviewerKind: "lara",
  });
  assert.equal(saved.ok, true, saved.message);

  harness().tables.applications = [
    {
      candidate_id: CANDIDATE_ID,
      resume_text: "Operated the clinical data review, owned the audit, and wrote the investigation memo for the lab.",
      answers: { "Why this seat": "I owned the audit and the investigation memo." },
      cover_letter: null,
      parsed_experience: [],
      resume_url: null,
      resume_storage_path: null,
    },
  ];
  harness().tables.job_rubrics = [
    {
      job_shortcode: "JOB1",
      rubric_md: "Weight owned judgment over title matching.",
      spec_md: "Own clinical data review and the investigation memo for this seat.",
    },
  ];
  harness().tables.jobs = [
    {
      shortcode: "JOB1",
      title: "Clinical data reviewer",
      department: "Operations",
      location: "Van Nuys, CA",
      raw: { full_description: "<p>Own clinical data review and the investigation memo.</p>" },
    },
  ];

  harness().grading = [];
  await scoreCandidate(CANDIDATE_ID, { force: true, replace: true, transport: "enqueue", trigger: "human_reanalysis" });
  assert.equal(harness().grading.length, 1);
  const input = harness().grading[0].input;
  const request = buildEvaluatorRequest(input);
  const prompt = request.messages[0]?.content;
  assert.equal(typeof prompt, "string");
  assert.equal(prompt.includes(NOTE), true, prompt);
  assert.equal(prompt.includes("Lara:"), false, prompt);
  assert.equal(prompt.includes("Conall:"), false, prompt);
  assert.equal(String(input.recruiterComments).includes(NOTE), true);
  assert.equal(String(input.recruiterComments).includes("Lara:"), false, input.recruiterComments);
});

test("the next grade attributes an allowlisted Lara correction to Lara", async () => {
  acting(allowlistedLara);
  const saved = await triage.saveCorrection({ candidateId: CANDIDATE_ID, text: NOTE, reviewerKind: "conall" });
  assert.equal(saved.ok, true, saved.message);
  assert.equal(latestCorrection().reviewerLabel, "Lara");

  harness().tables.applications = [
    {
      candidate_id: CANDIDATE_ID,
      resume_text: "Operated the clinical data review, owned the audit, and wrote the investigation memo for the lab.",
      answers: {},
      cover_letter: null,
      parsed_experience: [],
      resume_url: null,
      resume_storage_path: null,
    },
  ];
  harness().tables.job_rubrics = [
    {
      job_shortcode: "JOB1",
      rubric_md: "Weight owned judgment.",
      spec_md: "Own clinical data review for this seat.",
    },
  ];

  harness().grading = [];
  await scoreCandidate(CANDIDATE_ID, { force: true, replace: true, transport: "enqueue" });
  const input = harness().grading[0].input;
  const request = buildEvaluatorRequest(input);
  const prompt = String(request.messages[0]?.content ?? "");
  assert.equal(prompt.includes(`Lara: ${NOTE}`), true, prompt);
  assert.equal(prompt.includes("Conall:"), false, prompt);
});
