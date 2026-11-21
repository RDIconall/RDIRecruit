import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { after, before, beforeEach, describe, test } from "node:test";
import path from "node:path";
import { NextRequest } from "next/server";
import { startPostgrestCapture, type CapturedRow } from "./support/postgrest-capture.ts";

/**
 * Spec for the public Calendly booking webhook.
 *
 * Raw bodies larger than MAX_CALENDLY_BODY_BYTES must be refused before the
 * handler parses or stores them. Refusal must not depend on Content-Length:
 * a short or missing length with a longer stream is still over the limit.
 * The handler may read at most one 1024-byte chunk past the limit to notice
 * the overflow, then stop.
 *
 * Writes require a Calendly signature. The signing key is the
 * CALENDLY_WEBHOOK_SIGNING_KEY environment variable (placeholder in tests).
 * Header: `Calendly-Webhook-Signature: t=<unix seconds>,v1=<hex>`.
 * v1 is HMAC-SHA256 of `${t}.${rawBody}` using that key (Calendly signs the
 * raw body; tolerance is 180 seconds). When the key is unset, refuse.
 *
 * A booking that is accepted may persist only the fields the hiring record
 * needs. The stored event payload and the applicant communications body must
 * contain the invitee email and must not contain other request JSON.
 *
 * processPendingWorkableEvents is the events drain the reconcile cron runs.
 * It must delete calendly rows whose received_at is older than
 * CALENDLY_EVENT_MAX_AGE_MS.
 *
 * Not covered here, same unbounded recordEvent pattern:
 * src/app/api/hooks/videoask/route.ts, src/app/api/hooks/workable/route.ts,
 * src/app/api/ingest/fireflies/route.ts, src/app/api/ingest/gmail/route.ts.
 */

const MAX_CALENDLY_BODY_BYTES = 16 * 1024;
const CHUNK_BYTES = 1024;
const SIGNATURE_TOLERANCE_SECONDS = 180;
const CALENDLY_EVENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SIGNING_KEY = "placeholder-calendly-signing-key";
const MARKER = "should-not-be-stored";
const EMAIL = "ada@example.com";

type Capture = Awaited<ReturnType<typeof startPostgrestCapture>>;
type Post = (request: NextRequest) => Promise<Response>;
type Drain = (options?: { limit?: number; budgetMs?: number }) => Promise<unknown>;

let capture: Capture;
let postCalendly: Post;
let drainEvents: Drain;

function sign(raw: string, timestampSeconds = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac("sha256", SIGNING_KEY).update(`${timestampSeconds}.${raw}`).digest("hex");
  return `t=${timestampSeconds},v1=${mac}`;
}

function bookingOfSize(bytes: number): string {
  const empty = bookingJson("");
  const extra = bytes - Buffer.byteLength(empty);
  if (extra < 0) throw new Error(`booking envelope is already ${Buffer.byteLength(empty)} bytes`);
  return bookingJson("N".repeat(extra));
}

function bookingJson(notes?: string, emailPath: "payload" | "invitee" = "payload"): string {
  const invitee = {
    email: EMAIL,
    name: "Ada Lovelace",
    uri: "https://api.calendly.com/scheduled_events/invitees/placeholder",
    timezone: "America/Los_Angeles",
    status: "active",
    scheduled_event: {
      uri: "https://api.calendly.com/scheduled_events/placeholder",
      start_time: "2026-12-01T18:00:00Z",
      end_time: "2026-12-01T18:30:00Z",
    },
    tracking: { utm_source: MARKER },
    ...(notes !== undefined ? { notes } : {}),
  };
  if (emailPath === "invitee") {
    return JSON.stringify({ event: "invitee.created", invitee, extra: MARKER });
  }
  return JSON.stringify({ event: "invitee.created", payload: invitee, extra: MARKER });
}

function openRequest(
  raw: string,
  options: { contentLength?: string | null; signature?: string } = {},
): { request: NextRequest; bytesPulled: () => number } {
  const bytes = Buffer.from(raw);
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= bytes.length) {
        controller.close();
        return;
      }
      const next = Math.min(pulled + CHUNK_BYTES, bytes.length);
      controller.enqueue(bytes.subarray(pulled, next));
      pulled = next;
    },
  });
  const headers = new Headers({ "content-type": "application/json" });
  if (options.contentLength === undefined) headers.set("content-length", String(bytes.length));
  else if (options.contentLength !== null) headers.set("content-length", options.contentLength);
  if (options.signature) headers.set("calendly-webhook-signature", options.signature);
  const request = new NextRequest("http://127.0.0.1/api/hooks/calendly", {
    method: "POST",
    headers,
    body: stream,
    duplex: "half",
  } as NonNullable<ConstructorParameters<typeof NextRequest>[1]>);
  assert.equal(pulled, 0);
  return { request, bytesPulled: () => pulled };
}

function assertDidNotReadPastLimit(bytesPulled: () => number): void {
  const pulled = bytesPulled();
  assert.ok(
    pulled <= MAX_CALENDLY_BODY_BYTES + CHUNK_BYTES,
    `handler read ${pulled} bytes; limit is ${MAX_CALENDLY_BODY_BYTES}`,
  );
}

async function refuse(request: NextRequest): Promise<Response> {
  let response: Response;
  try {
    response = await postCalendly(request);
  } catch (error) {
    assert.fail(`handler threw instead of refusing the body: ${error instanceof Error ? error.message : String(error)}`);
  }
  assert.ok(response.status >= 400, `expected a refusal, got ${response.status}`);
  return response;
}

function persistedText(row: CapturedRow): string {
  return JSON.stringify(row);
}

describe("calendly webhook body limit", { concurrency: false }, () => {
  before(async () => {
    capture = await startPostgrestCapture();
    process.env.SUPABASE_URL = capture.url;
    process.env.SUPABASE_SERVICE_KEY = "placeholder-supabase-service-key";
    process.env.CALENDLY_WEBHOOK_SIGNING_KEY = SIGNING_KEY;
    process.env.WORKABLE_TOKEN = "placeholder-workable-token";
    const route = await import("../src/app/api/hooks/calendly/route.ts");
    const sync = await import("../src/lib/sync/incremental-sync.ts");
    postCalendly = route.POST;
    drainEvents = sync.processPendingWorkableEvents;
  });

  after(async () => {
    await capture.close();
  });

  beforeEach(() => {
    capture.reset();
    capture.seed("candidates", {
      workable_id: "cand_placeholder",
      email: EMAIL,
      job_shortcode: "seat",
      stage: "applied",
    });
  });

  test("a body over the limit is refused before it is parsed or stored", async () => {
    const raw = bookingJson("N".repeat(64 * 1024));
    assert.ok(Buffer.byteLength(raw) > MAX_CALENDLY_BODY_BYTES);
    const opened = openRequest(raw, { signature: sign(raw) });
    const response = await refuse(opened.request);
    assert.equal(response.status, 413);
    assertDidNotReadPastLimit(opened.bytesPulled);
    assert.equal(capture.rows("events").length, 0);
    assert.equal(capture.rows("comms_log").length, 0);
  });

  test("a short Content-Length does not allow a longer body to be stored", async () => {
    const raw = bookingJson("N".repeat(64 * 1024));
    const opened = openRequest(raw, { contentLength: "128", signature: sign(raw) });
    await refuse(opened.request);
    assertDidNotReadPastLimit(opened.bytesPulled);
    assert.equal(capture.rows("events").length, 0);
    assert.equal(capture.rows("comms_log").length, 0);
  });

  test("a body with no Content-Length over the limit is refused before it is stored", async () => {
    const raw = bookingJson("N".repeat(64 * 1024));
    const opened = openRequest(raw, { contentLength: null, signature: sign(raw) });
    await refuse(opened.request);
    assertDidNotReadPastLimit(opened.bytesPulled);
    assert.equal(capture.rows("events").length, 0);
    assert.equal(capture.rows("comms_log").length, 0);
  });

  test("one byte over the limit is refused before it is parsed or stored", async () => {
    const raw = bookingOfSize(MAX_CALENDLY_BODY_BYTES + 1);
    assert.equal(Buffer.byteLength(raw), MAX_CALENDLY_BODY_BYTES + 1);
    const opened = openRequest(raw, { signature: sign(raw) });
    const response = await refuse(opened.request);
    assert.equal(response.status, 413);
    assertDidNotReadPastLimit(opened.bytesPulled);
    assert.equal(capture.rows("events").length, 0);
    assert.equal(capture.rows("comms_log").length, 0);
  });

  test("a missing signature is refused and nothing is stored", async () => {
    const raw = bookingJson();
    const opened = openRequest(raw);
    const response = await refuse(opened.request);
    assert.equal(response.status, 401);
    assert.equal(capture.rows("events").length, 0);
    assert.equal(capture.rows("comms_log").length, 0);
  });

  test("a signature for a different key is refused and nothing is stored", async () => {
    const raw = bookingJson();
    const mac = createHmac("sha256", "placeholder-other-key").update(`${Math.floor(Date.now() / 1000)}.${raw}`).digest("hex");
    const opened = openRequest(raw, { signature: `t=${Math.floor(Date.now() / 1000)},v1=${mac}` });
    const response = await refuse(opened.request);
    assert.equal(response.status, 401);
    assert.equal(capture.rows("events").length, 0);
    assert.equal(capture.rows("comms_log").length, 0);
  });

  test("a signature older than the tolerance is refused and nothing is stored", async () => {
    const raw = bookingJson();
    const stale = Math.floor(Date.now() / 1000) - SIGNATURE_TOLERANCE_SECONDS - 60;
    const opened = openRequest(raw, { signature: sign(raw, stale) });
    const response = await refuse(opened.request);
    assert.equal(response.status, 401);
    assert.equal(capture.rows("events").length, 0);
    assert.equal(capture.rows("comms_log").length, 0);
  });

  test("an unset signing key refuses the booking", async () => {
    const script = path.join(process.cwd(), "tests/support/calendly-reject-without-signing-key.ts");
    const env = { ...process.env };
    delete env.CALENDLY_WEBHOOK_SIGNING_KEY;
    const child = spawn(process.execPath, ["--import", "tsx", script, capture.url], {
      env,
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const status = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`signing-key child timed out\n${Buffer.concat(stderr).toString("utf8")}`));
      }, 15_000);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });
    });
    const out = Buffer.concat(stdout).toString("utf8");
    const err = Buffer.concat(stderr).toString("utf8");
    assert.equal(status, 0, err || out);
    const result = JSON.parse(out.trim()) as { status: number };
    assert.equal(result.status, 401);
    assert.equal(capture.rows("events").length, 0);
    assert.equal(capture.rows("comms_log").length, 0);
  });

  test("a signed booking keeps the invitee email and drops the rest of the body", async () => {
    const raw = bookingJson();
    assert.ok(Buffer.byteLength(raw) <= MAX_CALENDLY_BODY_BYTES);
    const opened = openRequest(raw, { signature: sign(raw) });
    const response = await postCalendly(opened.request);
    assert.equal(response.status, 200);
    assertStoredBooking();
  });

  test("a signed booking that names the email on invitee keeps only that booking", async () => {
    const raw = bookingJson(undefined, "invitee");
    const opened = openRequest(raw, { signature: sign(raw) });
    const response = await postCalendly(opened.request);
    assert.equal(response.status, 200);
    assertStoredBooking();
  });

  test("the events drain deletes calendly rows older than a day", async () => {
    const aged = capture.seed("events", {
      id: "aged-calendly-event",
      source: "calendly",
      type: "booking",
      payload: { email: EMAIL },
      processed: false,
      received_at: new Date(Date.now() - CALENDLY_EVENT_MAX_AGE_MS - 60 * 60 * 1000).toISOString(),
    });
    const fresh = capture.seed("events", {
      id: "fresh-calendly-event",
      source: "calendly",
      type: "booking",
      payload: { email: EMAIL },
      processed: false,
      received_at: new Date().toISOString(),
    });
    capture.seed("events", {
      id: "workable-event",
      source: "workable",
      type: "candidate_created",
      payload: { event_type: "candidate_created" },
      processed: true,
      status: "succeeded",
      attempts: 1,
      received_at: new Date(Date.now() - CALENDLY_EVENT_MAX_AGE_MS - 60 * 60 * 1000).toISOString(),
    });

    await drainEvents({ limit: 25, budgetMs: 5_000 });

    const left = capture.rows("events");
    assert.equal(left.some((row) => row.id === aged.id), false);
    assert.equal(left.some((row) => row.id === "workable-event"), true);
    assert.equal(left.some((row) => row.id === fresh.id), true);
  });
});

function assertStoredBooking(): void {
  const events = capture.rows("events");
  const comms = capture.rows("comms_log");
  const stored = [...events.map(persistedText), ...comms.map(persistedText)].join("\n");
  assert.ok(stored.includes(EMAIL), "accepted booking did not keep the invitee email");
  assert.equal(stored.includes(MARKER), false, "accepted booking stored request JSON beyond the booking fields");
  for (const row of events) {
    assert.ok(persistedText(row).length < 2048);
  }
  for (const row of comms) {
    const body = typeof row.body === "string" ? row.body : persistedText(row);
    assert.ok(body.length < 2048);
    assert.equal(body.includes(MARKER), false);
  }
}
