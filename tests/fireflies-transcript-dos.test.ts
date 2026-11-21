import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import { before, describe, test } from "node:test";
import { NextRequest } from "next/server";
import { memory, loadIngestApp } from "./helpers/ingest-app";

/**
 * Spec for the public Fireflies ingest DoS.
 *
 * Signature: header `x-fireflies-signature` is the hex HMAC-SHA256 of the raw
 * request body, keyed with FIREFLIES_WEBHOOK_SECRET. If that secret is unset,
 * or the header is missing or wrong, respond 401 and write nothing.
 *
 * Length: after the transcript text is extracted (including sentence arrays
 * joined into one string), a body of ACCEPTED_TRANSCRIPT_CHARS must be stored
 * when the signature is valid. Anything longer than MAX_TRANSCRIPT_CHARS must
 * be refused with 413 before `events` or `evidence` are written.
 *
 * The hiring pool list (loadTriagePool) must not contain transcript text.
 * loadOneCandidate may.
 */
const ACCEPTED_TRANSCRIPT_CHARS = 2_000;
const MAX_TRANSCRIPT_CHARS = 100_000;

/** Obvious placeholder. Not a credential from the environment or the repo. */
const WEBHOOK_SECRET = "test-fireflies-webhook-secret";

Object.assign(process.env, { NODE_ENV: "development" });
process.env.SUPABASE_URL = "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_KEY = "test-service-role-placeholder";
process.env.FIREFLIES_WEBHOOK_SECRET = WEBHOOK_SECRET;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.VIDEOASK_WEBHOOK_SECRET;
delete process.env.WORKABLE_TOKEN;
delete process.env.WORKABLE_API_KEY;

const require = createRequire(import.meta.url);
const { getCloneableBody } = require("next/dist/server/body-streams.js") as {
  getCloneableBody: (readable: Readable, sizeLimit?: number) => {
    cloneBodyStream: () => Readable;
    finalize: () => Promise<void>;
  };
};

let app: Awaited<ReturnType<typeof loadIngestApp>>;

describe("fireflies transcript ingest", { concurrency: false }, () => {
before(async () => {
  app = await loadIngestApp();
});

async function assertStatus(response: Response, status: number): Promise<void> {
  const text = await response.clone().text();
  assert.equal(response.status, status, text);
}

// The runner starts cases together. The in-memory database is one object, so
// each case waits for the previous one to finish.
let caseChain: Promise<void> = Promise.resolve();
function serialTest(name: string, fn: () => Promise<void> | void): void {
  test(name, async () => {
    const run = caseChain.then(() => fn());
    caseChain = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  });
}

function sign(raw: string, secret = WEBHOOK_SECRET): string {
  return createHmac("sha256", secret).update(raw).digest("hex");
}

function seedApplicant(): void {
  memory.reset({
    jobs: [
      {
        shortcode: "JOB1",
        title: "Clinical Role",
        status: "published",
        department: null,
        location: null,
      },
    ],
    candidates: [
      {
        workable_id: "cand_known",
        job_shortcode: "JOB1",
        name: "Known Applicant",
        email: "applicant@example.com",
        phone: null,
        location: "Los Angeles, CA",
        stage: "Applied",
        stage_kind: null,
        disqualified: false,
        source: null,
        assignee_id: null,
        raw: null,
        photo_url: null,
        created_at: new Date().toISOString(),
        synced_at: new Date().toISOString(),
      },
    ],
  });
}

function bodyOf(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

/**
 * Next clones the request body for middleware and, at or under the default
 * 10MB proxyClientMaxBodySize, forwards every byte to the route. Return the
 * bytes the route handler would see.
 */
async function bytesAfterMiddlewareClone(raw: string): Promise<string> {
  const readable = Readable.from([Buffer.from(raw)]);
  const clonable = getCloneableBody(readable);
  const middlewareBody = clonable.cloneBodyStream();
  await new Promise<void>((resolve, reject) => {
    middlewareBody.on("end", () => resolve());
    middlewareBody.on("error", reject);
    middlewareBody.resume();
  });
  await clonable.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of readable) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function firefliesRequest(raw: string, signature: string | null): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature != null) headers["x-fireflies-signature"] = signature;
  return new NextRequest("http://localhost/api/ingest/fireflies", {
    method: "POST",
    headers,
    body: raw,
  });
}

async function postFireflies(raw: string, signature: string | null) {
  const delivered = await bytesAfterMiddlewareClone(raw);
  assert.equal(delivered, raw);
  return app.postFireflies(firefliesRequest(delivered, signature));
}

function storedTranscripts(): string[] {
  return memory.rows("evidence").map((row) => String(row.transcript ?? ""));
}

serialTest("middleware lets an anonymous caller reach Fireflies ingest", async () => {
  const response = await app.middleware(
    new NextRequest("http://localhost/api/ingest/fireflies", { method: "POST" }),
    {} as never,
  );
  assert.ok(response);
  const location = response.headers.get("location") ?? "";
  const rewrite = response.headers.get("x-middleware-rewrite") ?? "";
  assert.equal(response.status < 400, true, `public ingest was blocked with ${response.status} ${location}`);
  assert.equal(/sign-in|sign-up/i.test(location), false);
  assert.equal(rewrite.includes("clerk_"), false, `public ingest was rewritten away: ${rewrite}`);

  // A document request for the app shell calls auth.protect(). In this process
  // there is no Clerk publishable key, so that call throws while building the
  // sign-in redirect. The ingest route above did not.
  await assert.rejects(
    async () => {
      await app.middleware(
        new NextRequest("http://localhost/", {
          method: "GET",
          headers: { accept: "text/html" },
        }),
        {} as never,
      );
    },
    /publishableKey|sign-in|Unauthorized/i,
  );
});

serialTest("rejects an unsigned transcript and writes nothing", async () => {
  seedApplicant();
  const raw = bodyOf({
    transcriptId: "meeting-unsigned",
    title: "Interview",
    transcript: "x".repeat(ACCEPTED_TRANSCRIPT_CHARS),
    workable_id: "cand_known",
  });
  const response = await postFireflies(raw, null);
  await assertStatus(response, 401);
  assert.equal(memory.rows("events").length, 0);
  assert.equal(memory.rows("evidence").length, 0);
});

serialTest("rejects a bad signature and writes nothing", async () => {
  seedApplicant();
  const raw = bodyOf({
    transcriptId: "meeting-bad-sig",
    title: "Interview",
    transcript: "x".repeat(ACCEPTED_TRANSCRIPT_CHARS),
    workable_id: "cand_known",
  });
  const response = await postFireflies(raw, sign(raw, "test-wrong-secret"));
  await assertStatus(response, 401);
  assert.equal(memory.rows("events").length, 0);
  assert.equal(memory.rows("evidence").length, 0);
});

serialTest("rejects an over-limit transcript string before any write", async () => {
  seedApplicant();
  const transcript = `OVERSIZE ${"A".repeat(MAX_TRANSCRIPT_CHARS)}`;
  assert.ok(transcript.length > MAX_TRANSCRIPT_CHARS);
  const raw = bodyOf({
    transcriptId: "meeting-oversize",
    title: "Interview",
    transcript,
    workable_id: "cand_known",
  });
  const response = await postFireflies(raw, sign(raw));
  await assertStatus(response, 413);
  assert.equal(memory.rows("events").length, 0);
  assert.equal(memory.rows("evidence").length, 0);
  assert.equal(storedTranscripts().some((text) => text.includes("OVERSIZE")), false);
});

serialTest("rejects an over-limit transcript split across sentences before any write", async () => {
  seedApplicant();
  const sentence = `SENTENCES ${"B".repeat(MAX_TRANSCRIPT_CHARS)}`;
  const raw = bodyOf({
    transcriptId: "meeting-sentences",
    title: "Interview",
    sentences: [sentence.slice(0, 40_000), sentence.slice(40_000)],
    workable_id: "cand_known",
  });
  const response = await postFireflies(raw, sign(raw));
  await assertStatus(response, 413);
  assert.equal(memory.rows("events").length, 0);
  assert.equal(memory.rows("evidence").length, 0);
});

serialTest("rejects a second over-limit transcript id before any write", async () => {
  seedApplicant();
  for (const id of ["meeting-a", "meeting-b"]) {
    const raw = bodyOf({
      transcriptId: id,
      title: "Interview",
      transcript: `${id} ${"C".repeat(MAX_TRANSCRIPT_CHARS)}`,
      workable_id: "cand_known",
    });
    const response = await postFireflies(raw, sign(raw));
    await assertStatus(response, 413);
  }
  assert.equal(memory.rows("events").length, 0);
  assert.equal(memory.rows("evidence").length, 0);
});

serialTest("rejects an over-limit transcript matched by participant email before any write", async () => {
  seedApplicant();
  const raw = bodyOf({
    transcriptId: "meeting-email",
    title: "Interview",
    transcript: `EMAIL ${"D".repeat(MAX_TRANSCRIPT_CHARS)}`,
    organizer_email: "host@example.com",
    participants: ["applicant@example.com"],
  });
  const response = await postFireflies(raw, sign(raw));
  await assertStatus(response, 413);
  assert.equal(memory.rows("events").length, 0);
  assert.equal(memory.rows("evidence").length, 0);
});

serialTest("rejects an over-limit transcript for an unknown applicant before any write", async () => {
  seedApplicant();
  const raw = bodyOf({
    transcriptId: "meeting-unknown",
    title: "Interview",
    transcript: `UNKNOWN ${"E".repeat(MAX_TRANSCRIPT_CHARS)}`,
    workable_id: "cand_missing",
  });
  const response = await postFireflies(raw, sign(raw));
  await assertStatus(response, 413);
  assert.equal(memory.rows("events").length, 0);
  assert.equal(memory.rows("evidence").length, 0);
});

serialTest("a signed normal transcript is kept off the hiring pool list", async () => {
  seedApplicant();
  const sentinel = "POOL_SENTINEL_transcript_body";
  const transcript = `${sentinel} ${"n".repeat(ACCEPTED_TRANSCRIPT_CHARS)}`;
  const raw = bodyOf({
    transcriptId: "meeting-ok",
    title: "Onsite",
    transcript,
    workable_id: "cand_known",
  });
  const response = await postFireflies(raw, sign(raw));
  await assertStatus(response, 200);
  assert.equal(storedTranscripts().some((text) => text.includes(sentinel)), true);

  const crossRole = await app.loadTriagePool("all");
  const oneJob = await app.loadTriagePool("JOB1");
  assert.equal(JSON.stringify(crossRole).includes(sentinel), false);
  assert.equal(JSON.stringify(oneJob).includes(sentinel), false);

  const opened = await app.loadOneCandidate("cand_known");
  assert.ok(opened);
  assert.equal(JSON.stringify(opened).includes(sentinel), true);
});

serialTest("a signed normal transcript matched by email is kept off the pool list", async () => {
  seedApplicant();
  const sentinel = "EMAIL_SENTINEL_transcript_body";
  const transcript = `${sentinel} ${"m".repeat(ACCEPTED_TRANSCRIPT_CHARS)}`;
  const raw = bodyOf({
    transcriptId: "meeting-email-ok",
    title: "Screen",
    transcript,
    organizer_email: "host@example.com",
    participants: ["applicant@example.com"],
  });
  const response = await postFireflies(raw, sign(raw));
  await assertStatus(response, 200);
  const pool = await app.loadTriagePool("all");
  assert.equal(JSON.stringify(pool).includes(sentinel), false);
  const opened = await app.loadOneCandidate("cand_known");
  assert.equal(JSON.stringify(opened).includes(sentinel), true);
});

serialTest("VideoAsk ingest rejects an over-limit transcript before any write", async () => {
  seedApplicant();
  const transcript = `VIDEOASK ${"V".repeat(MAX_TRANSCRIPT_CHARS)}`;
  const raw = JSON.stringify({
    id: "videoask-1",
    contact: { email: "applicant@example.com" },
    transcript,
  });
  const response = await app.postVideoask(
    new NextRequest("http://localhost/api/hooks/videoask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    }),
  );
  await assertStatus(response, 413);
  assert.equal(memory.rows("events").length, 0);
  assert.equal(memory.rows("evidence").length, 0);
});

serialTest("Fireflies ingest rejects a transcript when the webhook secret is unset", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-test-module-mocks", "--import", "tsx", "tests/fireflies-secret-unset-runner.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "development",
        FIREFLIES_WEBHOOK_SECRET: "",
      },
      encoding: "utf8",
    },
  );
  assert.equal(
    result.status,
    0,
    `unset-secret runner failed\nstdout=${result.stdout}\nstderr=${result.stderr}`,
  );
});
});
