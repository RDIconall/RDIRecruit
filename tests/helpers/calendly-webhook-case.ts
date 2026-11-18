/**
 * One Calendly webhook case per process.
 *
 * The route reads environment through the module-level env parser, so each
 * case starts a fresh process with the secret either unset or set to the
 * placeholder before the route is imported.
 *
 * A request may be stored only when CALENDLY_WEBHOOK_SECRET is set and the
 * Calendly-Webhook-Signature header matches that secret:
 *   HMAC-SHA256(secret, `${timestamp}.${rawBody}`) as hex, header
 *   `t=<unix seconds>,v1=<hex>`, timestamp within 180 seconds.
 * The signature is over the raw request bytes. Fail closed when the secret
 * is unset, the header is missing, the MAC does not match, or the timestamp
 * is older than 180 seconds. Do not read or write the database before that
 * check passes.
 *
 * A passing booking stores an unprocessed calendly/booking event and, when
 * the invitee email equals candidates.email, a comms_log row for that
 * candidate's workable_id (channel calendly, template screen_booked). The
 * stored event payload and comms body may contain only booking fields:
 * email, name, event, uri, scheduled_at, status. They must not keep other
 * JSON from the request. An id in the body does not choose the candidate.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import {
  APPLICANT_EMAIL,
  APPLICANT_ID,
  SERVICE_KEY_PLACEHOLDER,
  startPostgrestStandIn,
  type CapturedRequest,
} from "./postgrest-stand-in.ts";

const SECRET_PLACEHOLDER = "test-calendly-webhook-secret";
const BOOKING_FIELDS = new Set(["email", "name", "event", "uri", "scheduled_at", "status"]);

type Mode =
  | "secret-unset"
  | "missing-signature"
  | "bad-signature"
  | "stale-signature"
  | "tampered-body"
  | "no-email"
  | "unknown-email"
  | "invitee-email"
  | "payload-email"
  | "signed-booking";

function signature(rawBody: string, secret: string, timestampSeconds: number): string {
  const mac = createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`).digest("hex");
  return `t=${timestampSeconds},v1=${mac}`;
}

function bookingBody(emailField: "invitee" | "payload" | "both" | "none", email = APPLICANT_EMAIL): string {
  const payload: Record<string, unknown> = {
    forged_note: "arbitrary-json",
    name: "Applicant Example",
    uri: "https://calendly.example/invitees/example",
    scheduled_at: "2026-12-01T15:00:00Z",
    status: "active",
  };
  if (emailField === "payload" || emailField === "both") payload.email = email;
  const body: Record<string, unknown> = {
    event: "invitee.created",
    forged_marker: "not-a-booking-field",
    candidate_id: "attacker_chosen",
    payload,
  };
  if (emailField === "invitee" || emailField === "both") {
    body.invitee = { email, forged_note: "arbitrary-json" };
  }
  return JSON.stringify(body);
}

function parseStored(body: unknown): unknown {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function containsForged(value: unknown): boolean {
  return JSON.stringify(value ?? null).includes("forged_marker") ||
    JSON.stringify(value ?? null).includes("forged_note") ||
    JSON.stringify(value ?? null).includes("attacker_chosen");
}

function assertBookingFieldsOnly(value: unknown, label: string) {
  assert.equal(containsForged(value), false, `${label} kept attacker-supplied JSON`);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      assert.equal(BOOKING_FIELDS.has(key), true, `${label} stored non-booking field ${key}`);
    }
  }
}

function table(request: CapturedRequest): string {
  const path = request.path.split("?")[0] ?? "";
  return path.slice("/rest/v1/".length).split("/")[0] ?? "";
}

async function post(rawBody: string, header?: string) {
  const headers = new Headers({ "content-type": "application/json" });
  if (header) headers.set("calendly-webhook-signature", header);
  const request = new NextRequest("http://localhost/api/hooks/calendly", {
    method: "POST",
    headers,
    body: rawBody,
  });
  const { POST } = await import("../../src/app/api/hooks/calendly/route.ts");
  return POST(request);
}

async function main() {
  const mode = process.argv[2] as Mode;
  const secretConfigured = mode !== "secret-unset";
  if (secretConfigured) process.env.CALENDLY_WEBHOOK_SECRET = SECRET_PLACEHOLDER;
  else delete process.env.CALENDLY_WEBHOOK_SECRET;

  const db = await startPostgrestStandIn();
  process.env.SUPABASE_URL = db.url;
  process.env.SUPABASE_SERVICE_KEY = SERVICE_KEY_PLACEHOLDER;

  const now = Math.floor(Date.now() / 1000);
  const raw = bookingBody(
    mode === "payload-email" ? "payload" : mode === "no-email" ? "none" : mode === "unknown-email" ? "both" : "invitee",
    mode === "unknown-email" ? "someone-else@example.com" : APPLICANT_EMAIL,
  );
  let header: string | undefined;
  if (mode === "missing-signature" || mode === "secret-unset" || mode === "no-email") {
    header = mode === "secret-unset" ? signature(raw, SECRET_PLACEHOLDER, now) : undefined;
  } else if (mode === "bad-signature") {
    header = `t=${now},v1=${"0".repeat(64)}`;
  } else if (mode === "stale-signature") {
    header = signature(raw, SECRET_PLACEHOLDER, now - 181);
  } else if (mode === "tampered-body") {
    header = signature('{"event":"invitee.created"}', SECRET_PLACEHOLDER, now);
  } else {
    header = signature(raw, SECRET_PLACEHOLDER, now);
  }

  const response = await post(raw, header);
  const writes = db.writes();
  const reads = db.rest().filter((request) => request.method === "GET");

  if (
    mode === "secret-unset" ||
    mode === "missing-signature" ||
    mode === "bad-signature" ||
    mode === "stale-signature" ||
    mode === "tampered-body" ||
    mode === "no-email"
  ) {
    assert.deepEqual(writes, [], `${mode} wrote before refusing`);
    assert.deepEqual(reads, [], `${mode} read the database before refusing`);
    assert.equal(response.status, 401, `${mode} was accepted`);
  } else if (mode === "unknown-email") {
    assert.equal(response.status, 200);
    assert.equal(
      writes.some((request) => table(request) === "comms_log"),
      false,
      "unknown email created a screen-booked row",
    );
    for (const request of writes) {
      assertBookingFieldsOnly(
        table(request) === "events"
          ? (request.body as { payload?: unknown }).payload
          : request.body,
        mode,
      );
    }
  } else {
    assert.equal(response.status, 200);
    const events = writes.filter((request) => table(request) === "events");
    const comms = writes.filter((request) => table(request) === "comms_log");
    assert.equal(events.length, 1, "signed booking did not record one event");
    assert.equal(comms.length, 1, "signed booking did not record one communications row");
    const event = events[0]?.body as {
      source?: string;
      type?: string;
      processed?: boolean;
      payload?: unknown;
    };
    assert.equal(event.source, "calendly");
    assert.equal(event.type, "booking");
    assert.equal(event.processed === true, false);
    assertBookingFieldsOnly(event.payload, "event payload");
    assert.equal(
      JSON.stringify(event.payload).includes(APPLICANT_EMAIL),
      true,
      "event payload dropped the applicant email",
    );
    const row = comms[0]?.body as {
      candidate_id?: string;
      channel?: string;
      template?: string;
      body?: string;
    };
    assert.equal(row.candidate_id, APPLICANT_ID);
    assert.equal(row.channel, "calendly");
    assert.equal(row.template, "screen_booked");
    const storedBody = parseStored(row.body);
    assertBookingFieldsOnly(storedBody, "comms body");
    assert.equal(
      JSON.stringify(storedBody).includes(APPLICANT_EMAIL),
      true,
      "comms body dropped the applicant email",
    );
  }

  await db.close();
  console.log(`${mode}: ok`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
