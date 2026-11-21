/**
 * Spec for the hiring-board text limits.
 *
 * These tests call the server actions a signed-in account can call, then load
 * the same pool the home page renders. They fail while notes, transcripts, and
 * the other free-text writes are stored without a cap and copied into the pool
 * payload. They pass once those writes are rejected before anything is stored
 * and the board load no longer receives the full text.
 *
 * Caps below are the contract:
 * - activity note / comment body: 8_000 characters; author: 200
 * - activity interview body and pasted transcript: 100_000 characters
 * - correction, reply value, and chat message: 8_000 characters
 * - timeline row: 40 rows, each free-text field 2_000 characters
 * - job rubric / spec: 100_000 characters each
 *
 * Accepted note, transcript, correction, reply, and chat bodies stay out of the
 * rows the pool loader reads and out of the pool object sent to the board.
 * The rubric is part of the board, so only its size is capped.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  CANDIDATE_ID,
  JOB,
  activityBodies,
  capturedMiddleware,
  db,
  session,
  workingSlice,
} from "./helpers/hiring-text-harness.ts";
import {
  logActivity,
  saveCorrection,
  saveJobRubric,
  saveReply,
  saveTimeline,
  saveTranscript,
  sendCandidateChat,
} from "../src/app/actions/triage.ts";
import { loadTriagePool } from "../src/lib/triage/load.ts";
import type { TimelineRow } from "../src/lib/triage/types.ts";
import "../src/middleware.ts";

const NOTE_MAX = 8_000;
const COMMENT_MAX = 8_000;
const AUTHOR_MAX = 200;
const TRANSCRIPT_MAX = 100_000;
const CORRECTION_MAX = 8_000;
const REPLY_MAX = 8_000;
const CHAT_MAX = 8_000;
const TIMELINE_FIELD_MAX = 2_000;
const TIMELINE_MAX_ROWS = 40;
const RUBRIC_MAX = 100_000;

function chars(prefix: string, count: number): string {
  if (count < prefix.length) return prefix.slice(0, count);
  return prefix + "x".repeat(count - prefix.length);
}

/** True when a write was attempted, even if a later statement removed the row. */
function wasWritten(marker: string): boolean {
  return db.writes.some((entry) => entry.includes(marker));
}

function timelineRow(scope: string): TimelineRow {
  return {
    type: "role",
    period: "2020–2024",
    org: "Example Clinic",
    role: "Coordinator",
    tenure: "4 yr",
    scope,
    lang: "—",
    signal: "neutral",
  };
}

async function boardPayload(): Promise<{ single: string; home: string; reads: string }> {
  const chunks: string[] = [];
  db.onRead = (_table, row) => {
    chunks.push(JSON.stringify(row));
  };
  try {
    const single = await loadTriagePool(JOB);
    const home = await loadTriagePool("all");
    return {
      single: JSON.stringify(single),
      home: JSON.stringify(home),
      reads: chunks.join("\n"),
    };
  } finally {
    db.onRead = null;
  }
}

beforeEach(() => {
  session.userId = "user_public_signup";
  db.resetWrites();
  db.onRead = null;
});

test("sign-up is public and the hiring board only requires a signed-in user", async () => {
  assert.ok(capturedMiddleware, "middleware did not register its auth handler");
  const protectedPaths: string[] = [];
  const auth = {
    protect: async () => {
      protectedPaths.push("called");
    },
  };
  await capturedMiddleware(auth, { nextUrl: { pathname: "/sign-up" } });
  await capturedMiddleware(auth, { nextUrl: { pathname: "/sign-up/verify" } });
  assert.deepEqual(protectedPaths, []);
  await capturedMiddleware(auth, { nextUrl: { pathname: "/" } });
  assert.deepEqual(protectedPaths, ["called"]);
});

test("a signed-out caller cannot append an activity note", async () => {
  session.userId = null;
  await assert.rejects(
    () => logActivity({ candidateId: CANDIDATE_ID, type: "note", body: "signed out" }),
    /Unauthorized/,
  );
  assert.deepEqual(activityBodies(), []);
});

test("an activity note over the cap is refused and nothing is stored", async () => {
  const note = chars("NOTE_TOO_BIG_", NOTE_MAX + 1);
  const result = await logActivity({ candidateId: CANDIDATE_ID, type: "note", body: note });
  assert.equal(result.ok, false);
  assert.equal(wasWritten("NOTE_TOO_BIG_"), false);
  assert.deepEqual(activityBodies(), []);
});

test("an activity comment over the cap is refused and nothing is stored", async () => {
  const comment = chars("COMMENT_TOO_BIG_", COMMENT_MAX + 1);
  const result = await logActivity({ candidateId: CANDIDATE_ID, type: "comment", body: comment });
  assert.equal(result.ok, false);
  assert.equal(wasWritten("COMMENT_TOO_BIG_"), false);
  assert.deepEqual(activityBodies(), []);
});

test("an activity author over the cap is refused and nothing is stored", async () => {
  const author = chars("AUTHOR_TOO_BIG_", AUTHOR_MAX + 1);
  const result = await logActivity({
    candidateId: CANDIDATE_ID,
    type: "note",
    author,
    body: "short note",
  });
  assert.equal(result.ok, false);
  assert.equal(wasWritten("AUTHOR_TOO_BIG_"), false);
  assert.deepEqual(activityBodies(), []);
});

test("an interview entry over the cap is refused and nothing is stored", async () => {
  const interview = chars("INTERVIEW_TOO_BIG_", TRANSCRIPT_MAX + 1);
  const result = await logActivity({
    candidateId: CANDIDATE_ID,
    type: "interview",
    body: interview,
  });
  assert.equal(result.ok, false);
  assert.equal(wasWritten("INTERVIEW_TOO_BIG_"), false);
  assert.deepEqual(activityBodies(), []);
});

test("a pasted transcript over the cap is refused and nothing is stored", async () => {
  const pasted = chars("TRANSCRIPT_TOO_BIG_", TRANSCRIPT_MAX + 1);
  const result = await saveTranscript({ candidateId: CANDIDATE_ID, transcript: pasted });
  assert.equal(result.ok, false);
  assert.equal(wasWritten("TRANSCRIPT_TOO_BIG_"), false);
  const slice = workingSlice();
  assert.ok(!slice || slice.transcript == null || slice.transcript === "");
});

test("a correction over the cap is refused and nothing is stored", async () => {
  const correction = chars("CORRECTION_TOO_BIG_", CORRECTION_MAX + 1);
  const result = await saveCorrection({ candidateId: CANDIDATE_ID, text: correction });
  assert.equal(result.ok, false);
  assert.equal(wasWritten("CORRECTION_TOO_BIG_"), false);
});

test("a reply over the cap is refused and nothing is stored", async () => {
  const reply = chars("REPLY_TOO_BIG_", REPLY_MAX + 1);
  const result = await saveReply({ candidateId: CANDIDATE_ID, key: "fit", value: reply });
  assert.equal(result.ok, false);
  assert.equal(wasWritten("REPLY_TOO_BIG_"), false);
});

test("a chat message over the cap is refused and nothing is stored", async () => {
  const chat = chars("CHAT_TOO_BIG_", CHAT_MAX + 1);
  await sendCandidateChat({ candidateId: CANDIDATE_ID, message: chat });
  assert.equal(wasWritten("CHAT_TOO_BIG_"), false);
});

test("a timeline over the cap is refused and nothing is stored", async () => {
  const scope = chars("TIMELINE_TOO_BIG_", TIMELINE_FIELD_MAX + 1);
  const tooMany = Array.from({ length: TIMELINE_MAX_ROWS + 1 }, () => timelineRow("wide"));
  const fieldResult = await saveTimeline({ candidateId: CANDIDATE_ID, ovr: [timelineRow(scope)] });
  assert.equal(fieldResult.ok, false);
  assert.equal(wasWritten("TIMELINE_TOO_BIG_"), false);

  db.resetWrites();
  const countResult = await saveTimeline({ candidateId: CANDIDATE_ID, ovr: tooMany });
  assert.equal(countResult.ok, false);
  assert.equal(wasWritten("wide"), false);
});

test("a rubric or spec over the cap is refused and is not what the board loads", async () => {
  const spec = chars("SPEC_TOO_BIG_", RUBRIC_MAX + 1);
  const rubric = chars("RUBRIC_TOO_BIG_", RUBRIC_MAX + 1);
  const result = await saveJobRubric({ jobShortcode: JOB, specMd: spec, rubricMd: rubric });
  assert.equal(result.ok, false);
  assert.equal(wasWritten("SPEC_TOO_BIG_"), false);
  assert.equal(wasWritten("RUBRIC_TOO_BIG_"), false);
  const { single, home } = await boardPayload();
  assert.equal(single.includes("SPEC_TOO_BIG_"), false);
  assert.equal(single.includes("RUBRIC_TOO_BIG_"), false);
  assert.equal(home.includes("SPEC_TOO_BIG_"), false);
});

test("accepted notes, transcripts, and the other free-text writes stay out of the board payload", async () => {
  const note = chars("NOTE_KEPT_", 400);
  const comment = chars("COMMENT_KEPT_", 400);
  const interview = chars("INTERVIEW_KEPT_", 2_000);
  const transcript = chars("TRANSCRIPT_KEPT_", 2_000);
  const correction = chars("CORRECTION_KEPT_", 400);
  const reply = chars("REPLY_KEPT_", 400);
  const chat = chars("CHAT_KEPT_", 400);
  const scope = chars("TIMELINE_KEPT_", 400);

  const noteResult = await logActivity({ candidateId: CANDIDATE_ID, type: "note", body: note });
  const commentResult = await logActivity({ candidateId: CANDIDATE_ID, type: "comment", body: comment });
  const interviewResult = await logActivity({ candidateId: CANDIDATE_ID, type: "interview", body: interview });
  assert.equal(noteResult.ok, true);
  assert.equal(commentResult.ok, true);
  assert.equal(interviewResult.ok, true);
  assert.equal(activityBodies().includes(note), true);

  const transcriptResult = await saveTranscript({ candidateId: CANDIDATE_ID, transcript });
  assert.equal(transcriptResult.ok, true);
  const correctionResult = await saveCorrection({ candidateId: CANDIDATE_ID, text: correction });
  assert.equal(correctionResult.ok, true);
  const replyResult = await saveReply({ candidateId: CANDIDATE_ID, key: "fit", value: reply });
  assert.equal(replyResult.ok, true);
  await sendCandidateChat({ candidateId: CANDIDATE_ID, message: chat });
  assert.equal(wasWritten("CHAT_KEPT_"), true);
  const timelineResult = await saveTimeline({ candidateId: CANDIDATE_ID, ovr: [timelineRow(scope)] });
  assert.equal(timelineResult.ok, true);

  const markers = [note, comment, interview, transcript, correction, reply, chat, scope];
  const { single, home, reads } = await boardPayload();
  const leaked = markers.filter(
    (marker) => reads.includes(marker) || single.includes(marker) || home.includes(marker),
  );
  assert.deepEqual(
    leaked.map((marker) => marker.slice(0, 16)),
    [],
  );
});

test("repeated notes under the per-note cap still do not grow the board payload", async () => {
  const bodies: string[] = [];
  for (let i = 0; i < 20; i += 1) {
    const body = chars(`REPEAT_${i}_`, 1_000);
    bodies.push(body);
    const result = await logActivity({ candidateId: CANDIDATE_ID, type: "note", body });
    assert.equal(result.ok, true);
  }
  assert.equal(activityBodies().length, 20);

  const { single, home, reads } = await boardPayload();
  for (const body of bodies) {
    assert.equal(reads.includes(body), false);
    assert.equal(single.includes(body), false);
    assert.equal(home.includes(body), false);
  }
  assert.ok(single.length < 500_000);
  assert.ok(home.length < 500_000);
});
