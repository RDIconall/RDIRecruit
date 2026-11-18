import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { env } from "@/lib/env";
import { recordEvent } from "@/lib/sync/workable-sync";
import { getServiceSupabase } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Calendly signs `${t}.${rawBody}` and recommends rejecting anything older
// than three minutes to limit replay.
const SIGNATURE_TOLERANCE_SECONDS = 180;
const MAX_FIELD_LENGTH = 512;

type Booking = {
  email?: string;
  name?: string;
  event?: string;
  uri?: string;
  scheduled_at?: string;
  status?: string;
};

/**
 * Verifies the `Calendly-Webhook-Signature: t=<unix seconds>,v1=<hex>` header,
 * an HMAC-SHA256 of `${t}.${rawBody}` keyed with the webhook signing key.
 */
function verifyCalendlySignature(
  rawBody: Buffer,
  header: string | null,
  secret: string,
  nowSeconds: number,
): boolean {
  if (!header) return false;

  let timestamp: string | undefined;
  let signature: string | undefined;
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t") timestamp = value;
    else if (key === "v1") signature = value;
  }
  if (!timestamp || !/^\d{1,12}$/.test(timestamp)) return false;
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD_LENGTH
    ? value
    : undefined;
}

/** Keeps only the booking fields the product uses; everything else in the body is dropped. */
function toBooking(body: Record<string, unknown>): Booking {
  const inner = isRecord(body.payload) ? body.payload : {};
  const invitee = isRecord(body.invitee) ? body.invitee : {};
  const scheduled = isRecord(inner.scheduled_event) ? inner.scheduled_event : {};

  const booking: Booking = {
    email: field(inner.email) ?? field(invitee.email),
    name: field(inner.name) ?? field(invitee.name),
    event: field(body.event),
    uri: field(inner.uri) ?? field(invitee.uri),
    scheduled_at: field(scheduled.start_time) ?? field(inner.scheduled_at),
    status: field(inner.status) ?? field(invitee.status),
  };
  for (const key of Object.keys(booking) as (keyof Booking)[]) {
    if (booking[key] === undefined) delete booking[key];
  }
  return booking;
}

export async function POST(request: NextRequest) {
  const secret = env.CALENDLY_WEBHOOK_SECRET;
  const rawBody = Buffer.from(await request.arrayBuffer());

  if (
    !secret ||
    !verifyCalendlySignature(
      rawBody,
      request.headers.get("calendly-webhook-signature"),
      secret,
      Math.floor(Date.now() / 1000),
    )
  ) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!isRecord(body)) {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const booking = toBooking(body);
  await recordEvent("calendly", "booking", booking);

  if (!booking.email || booking.event !== "invitee.created") {
    return NextResponse.json({ ok: true });
  }

  const supabase = getServiceSupabase();
  const { data: candidate } = await supabase
    .from("candidates")
    .select("workable_id, job_shortcode, stage")
    .eq("email", booking.email)
    .maybeSingle();

  if (candidate) {
    await supabase.from("comms_log").insert({
      candidate_id: candidate.workable_id,
      channel: "calendly",
      direction: "inbound",
      template: "screen_booked",
      status: "sent",
      body: JSON.stringify(booking),
    });
  }

  return NextResponse.json({ ok: true });
}
