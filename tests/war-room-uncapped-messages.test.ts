/**
 * Spec for the war-room denial-of-service finding.
 *
 * These tests fail while a signed-in caller can append unbounded text that the
 * hiring home page then loads for every applicant. They pass once each writer
 * below rejects text over a few thousand characters, keeps only a bounded
 * recent history, and the pool load does not receive stored war-room threads.
 *
 * The database stand-in is tests/helpers/memory-supabase.cjs. It stores the
 * object the app passes to upsert/insert and returns it on select, matching
 * @supabase/postgrest-js 2.108.1 (JSON.stringify of the request body, no length
 * trim). It also enforces the candidate foreign keys from migrations 009 and 011.
 *
 * Left untested because they do not append free text onto the pool payload:
 * setDisqualified (one overlay reason), setDecision, setProcessStatus, and
 * clearCandidateChat.
 */
import assert from "node:assert/strict";
import Module from "node:module";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(__filename);
const { db } = require("./helpers/memory-supabase.cjs") as {
  db: {
    tables: Record<string, Array<Record<string, unknown>>>;
    delivered: {
      chatChars: number;
      correctionChars: number;
      transcriptChars: number;
      replyChars: number;
      timelineChars: number;
      activityChars: number;
    };
    resetDelivered: () => void;
  };
};

const supabaseStub = require.resolve("./helpers/memory-supabase.cjs");
const clerkStub = require.resolve("./helpers/clerk-auth.cjs");
const emptyStub = require.resolve("./helpers/empty.cjs");
const nextCacheStub = require.resolve("./helpers/next-cache.cjs");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (this: NodeModule, id: string, ...rest: unknown[]) {
  if (id === "@supabase/supabase-js") return originalRequire.call(this, supabaseStub);
  if (id === "@clerk/nextjs/server") return originalRequire.call(this, clerkStub);
  if (id === "server-only") return originalRequire.call(this, emptyStub);
  if (id === "next/cache") return originalRequire.call(this, nextCacheStub);
  return originalRequire.call(this, id, ...(rest as []));
};

const MAX_TEXT_CHARS = 4000;
const MAX_STORED_TURNS = 24;
const JOB = "JOB1";
const VICTIM = "cand_real";
const BYSTANDER = "cand_other";

type Row = Record<string, unknown>;

interface ChatMessage {
  role: string;
  content: string;
}

interface WorkspaceSlice {
  chat?: ChatMessage[];
  corrections?: Array<{ text?: string }>;
  transcript?: string;
  replies?: Record<string, string>;
  ovr?: unknown[];
}

function seedPool(): void {
  const now = new Date().toISOString();
  db.tables = {
    jobs: [
      {
        shortcode: JOB,
        title: "Clinical Data Manager",
        status: "published",
        department: null,
        location: null,
        raw: null,
      },
    ],
    candidates: [VICTIM, BYSTANDER].map((id) => ({
      workable_id: id,
      job_shortcode: JOB,
      name: id === VICTIM ? "Pat Applicant" : "Other Applicant",
      email: null,
      phone: null,
      location: null,
      stage: "Applied",
      stage_kind: null,
      disqualified: false,
      source: null,
      assignee_id: null,
      raw: {},
      photo_url: null,
      created_at: now,
      synced_at: now,
    })),
    candidate_working_files: [],
    activity: [],
  };
  db.resetDelivered();
}

function workingFile(candidateId: string): Row | null {
  return db.tables.candidate_working_files?.find((row) => row.candidate_id === candidateId) ?? null;
}

function workspaceOf(candidateId: string): WorkspaceSlice {
  return (workingFile(candidateId)?.workspace as WorkspaceSlice | undefined) ?? {};
}

function activityFor(candidateId: string): Row[] {
  return (db.tables.activity ?? []).filter((row) => row.candidate_id === candidateId);
}

delete process.env.ANTHROPIC_API_KEY;
delete process.env.WORKABLE_TOKEN;
delete process.env.WORKABLE_API_KEY;
process.env.SUPABASE_URL = "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_KEY = "placeholder-service-key";

type ChatAction = typeof import("../src/app/actions/triage.ts").sendCandidateChat;
type SaveCorrection = typeof import("../src/app/actions/triage.ts").saveCorrection;
type SaveTranscript = typeof import("../src/app/actions/triage.ts").saveTranscript;
type SaveReply = typeof import("../src/app/actions/triage.ts").saveReply;
type SaveTimeline = typeof import("../src/app/actions/triage.ts").saveTimeline;
type LogActivity = typeof import("../src/app/actions/triage.ts").logActivity;
type LoadPool = typeof import("../src/lib/triage/load.ts").loadTriagePool;

let sendCandidateChat: ChatAction;
let saveCorrection: SaveCorrection;
let saveTranscript: SaveTranscript;
let saveReply: SaveReply;
let saveTimeline: SaveTimeline;
let logActivity: LogActivity;
let loadTriagePool: LoadPool;
let CROSS_ROLE_SHORTCODE: string;

test.before(async () => {
  const actions = await import("../src/app/actions/triage.ts");
  const load = await import("../src/lib/triage/load.ts");
  sendCandidateChat = actions.sendCandidateChat;
  saveCorrection = actions.saveCorrection;
  saveTranscript = actions.saveTranscript;
  saveReply = actions.saveReply;
  saveTimeline = actions.saveTimeline;
  logActivity = actions.logActivity;
  loadTriagePool = load.loadTriagePool;
  CROSS_ROLE_SHORTCODE = load.CROSS_ROLE_SHORTCODE;
});

async function call<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

test("a signed-in stranger cannot store a war-room message over a few thousand characters", async () => {
  seedPool();
  const accepted = `${"m".repeat(100)} SHORT-CHAT-OK`;
  const acceptedResult = await sendCandidateChat({ candidateId: VICTIM, message: accepted });
  assert.ok((workspaceOf(VICTIM).chat ?? []).some((message) => message.content === accepted));
  assert.ok(acceptedResult.messages.some((message) => message.content === accepted));

  const beforeCount = (workspaceOf(VICTIM).chat ?? []).length;
  const huge = `H${"x".repeat(MAX_TEXT_CHARS)}`;
  const result = await call(() => sendCandidateChat({ candidateId: VICTIM, message: huge }));

  const stored = workspaceOf(VICTIM).chat ?? [];
  assert.equal(stored.length, beforeCount);
  assert.equal(stored.some((message) => message.content.length > MAX_TEXT_CHARS), false);
  assert.equal(workingFile(BYSTANDER), null);
  const returned = result?.messages ?? stored;
  assert.equal(returned.some((message) => message.content.length > MAX_TEXT_CHARS), false);
});

test("repeated war-room messages stay within the recent-turn window that is stored and returned", async () => {
  seedPool();
  const turns = MAX_STORED_TURNS + 16;
  for (let index = 0; index < turns; index += 1) {
    const message = `${"m".repeat(2000)} TURN-${index}-END`;
    await call(() => sendCandidateChat({ candidateId: VICTIM, message }));
  }

  const stored = workspaceOf(VICTIM).chat ?? [];
  assert.ok(stored.length > 0, "a message within the cap must still be stored");
  assert.ok(stored.length <= MAX_STORED_TURNS, `stored ${stored.length} turns`);
  assert.ok(stored.every((message) => message.content.length <= MAX_TEXT_CHARS));
  assert.ok(stored.some((message) => message.content.includes(`TURN-${turns - 1}-END`)));
  assert.ok(!stored.some((message) => message.content.includes("TURN-0-END")));
  assert.equal(workingFile(BYSTANDER), null);

  const again = await sendCandidateChat({
    candidateId: VICTIM,
    message: `${"m".repeat(100)} TURN-LAST-END`,
  });
  assert.ok(again.messages.length <= MAX_STORED_TURNS);
  assert.ok(again.messages.some((message) => message.content.includes("TURN-LAST-END")));
  assert.ok(!again.messages.some((message) => message.content.includes("TURN-0-END")));
});

test("the hiring pool load does not receive stored war-room threads", async () => {
  seedPool();
  const marker = `${"m".repeat(1500)} POOL-CHAT-MARKER`;
  await sendCandidateChat({ candidateId: VICTIM, message: marker });
  assert.ok((workspaceOf(VICTIM).chat ?? []).some((message) => message.content === marker));

  for (const job of [CROSS_ROLE_SHORTCODE, JOB]) {
    db.resetDelivered();
    const pool = await loadTriagePool(job);
    const payload = JSON.stringify(pool);
    assert.ok(pool.candidates.some((candidate) => candidate.id === VICTIM));
    assert.equal(payload.includes("POOL-CHAT-MARKER"), false);
    assert.equal(db.delivered.chatChars, 0);
  }
});

test("corrections, transcripts, replies, and timeline rows share the same cap and do not grow the pool load", async () => {
  seedPool();
  const accepted = await saveCorrection({ candidateId: VICTIM, text: "CORR-SHORT-OK" });
  assert.equal(accepted.ok, true);
  assert.ok((workspaceOf(VICTIM).corrections ?? []).some((entry) => entry.text === "CORR-SHORT-OK"));

  const beforeCorrections = (workspaceOf(VICTIM).corrections ?? []).length;
  const beforeContent = String(workingFile(VICTIM)?.content ?? "").length;
  const huge = `H${"y".repeat(MAX_TEXT_CHARS)}`;
  await call(() => saveCorrection({ candidateId: VICTIM, text: huge }));
  await call(() => saveTranscript({ candidateId: VICTIM, transcript: huge }));
  await call(() => saveReply({ candidateId: VICTIM, key: "note", value: huge }));
  await call(() =>
    saveTimeline({
      candidateId: VICTIM,
      ovr: [
        {
          type: "role",
          period: "2020",
          org: "Org",
          role: "Role",
          tenure: "1y",
          scope: huge,
          lang: "en",
          signal: "Verify",
        },
      ],
    }),
  );

  const afterHuge = workspaceOf(VICTIM);
  assert.equal((afterHuge.corrections ?? []).length, beforeCorrections);
  assert.equal((afterHuge.corrections ?? []).some((entry) => (entry.text ?? "").length > MAX_TEXT_CHARS), false);
  assert.equal((afterHuge.transcript ?? "").length > MAX_TEXT_CHARS, false);
  assert.equal(Object.values(afterHuge.replies ?? {}).some((value) => value.length > MAX_TEXT_CHARS), false);
  assert.equal(String(workingFile(VICTIM)?.content ?? "").length, beforeContent);
  assert.equal(workingFile(BYSTANDER), null);

  const correctionCount = MAX_STORED_TURNS + 10;
  for (let index = 0; index < correctionCount; index += 1) {
    await call(() => saveCorrection({ candidateId: VICTIM, text: `${"c".repeat(500)} CORR-${index}-END` }));
  }
  const corrections = workspaceOf(VICTIM).corrections ?? [];
  assert.ok(corrections.length > 0, "a correction within the cap must still be stored");
  assert.ok(corrections.length <= MAX_STORED_TURNS, `stored ${corrections.length} corrections`);
  assert.ok(corrections.some((entry) => (entry.text ?? "").includes(`CORR-${correctionCount - 1}-END`)));
  assert.ok(!corrections.some((entry) => (entry.text ?? "").includes("CORR-0-END")));

  const transcript = await saveTranscript({ candidateId: VICTIM, transcript: `${"t".repeat(500)} TRANSCRIPT-OK` });
  assert.equal(transcript.ok, true);
  assert.equal(workspaceOf(VICTIM).transcript?.includes("TRANSCRIPT-OK"), true);
  const reply = await saveReply({ candidateId: VICTIM, key: "note", value: `${"r".repeat(500)} REPLY-OK` });
  assert.equal(reply.ok, true);
  const keptRows = Array.from({ length: MAX_STORED_TURNS + 8 }, (_, index) => ({
    type: "role" as const,
    period: "2020",
    org: "Org",
    role: "Role",
    tenure: "1y",
    scope: `SCOPE-${index}-END`,
    lang: "en",
    signal: "Verify" as const,
  }));
  await saveTimeline({ candidateId: VICTIM, ovr: keptRows });
  const timeline = workspaceOf(VICTIM).ovr ?? [];
  assert.ok(timeline.length > 0, "a timeline within the cap must still be stored");
  assert.ok(timeline.length <= MAX_STORED_TURNS, `stored ${timeline.length} timeline rows`);

  db.resetDelivered();
  const pool = await loadTriagePool(CROSS_ROLE_SHORTCODE);
  const payload = JSON.stringify(pool);
  assert.ok(pool.candidates.some((candidate) => candidate.id === VICTIM));
  assert.ok(db.delivered.correctionChars <= MAX_STORED_TURNS * MAX_TEXT_CHARS);
  assert.ok(db.delivered.transcriptChars <= MAX_TEXT_CHARS);
  assert.ok(db.delivered.replyChars <= MAX_TEXT_CHARS);
  assert.ok(db.delivered.timelineChars <= MAX_STORED_TURNS * MAX_TEXT_CHARS);
  assert.equal(payload.includes("CORR-0-END"), false);
  assert.equal(payload.includes(huge), false);
});

test("activity log entries share the cap and are not all loaded onto the hiring board", async () => {
  seedPool();
  const accepted = await logActivity({ candidateId: VICTIM, type: "note", body: "ACT-SHORT-OK" });
  assert.equal(accepted.ok, true);
  assert.ok(activityFor(VICTIM).some((row) => row.body === "ACT-SHORT-OK"));

  const before = activityFor(VICTIM).length;
  const huge = `H${"z".repeat(MAX_TEXT_CHARS)}`;
  await call(() => logActivity({ candidateId: VICTIM, type: "note", body: huge }));
  assert.equal(activityFor(VICTIM).length, before);
  assert.equal(activityFor(BYSTANDER).length, 0);

  const count = MAX_STORED_TURNS + 10;
  for (let index = 0; index < count; index += 1) {
    await call(() => logActivity({ candidateId: VICTIM, type: "note", body: `${"a".repeat(500)} ACT-${index}-END` }));
  }
  const rows = activityFor(VICTIM);
  assert.ok(rows.length > 0, "an activity note within the cap must still be stored");
  assert.ok(rows.length <= MAX_STORED_TURNS, `stored ${rows.length} activity rows`);
  assert.ok(rows.some((row) => String(row.body).includes(`ACT-${count - 1}-END`)));
  assert.ok(!rows.some((row) => String(row.body).includes("ACT-0-END")));

  db.resetDelivered();
  const pool = await loadTriagePool(JOB);
  assert.ok(pool.candidates.some((candidate) => candidate.id === VICTIM));
  assert.ok(db.delivered.activityChars <= MAX_STORED_TURNS * MAX_TEXT_CHARS);
  assert.equal(JSON.stringify(pool).includes("ACT-0-END"), false);
});
