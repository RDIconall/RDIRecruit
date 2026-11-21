import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { readBodyWithLimit } from "@/lib/http/bounded-body";
import {
  MAX_CALENDLY_BODY_BYTES,
  extractCalendlyBooking,
  isFreshCalendlySignature,
  parseCalendlySignature,
  verifyCalendlySignature,
} from "@/lib/ingest/calendly";
import { recordEvent } from "@/lib/sync/workable-sync";
import { getServiceSupabase } from "@/lib/supabase/server";

export const runtime = "nodejs";

function unauthorized() {
  return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
}

export async function POST(request: NextRequest) {
  const signingKey = env.CALENDLY_WEBHOOK_SIGNING_KEY;
  if (!signingKey) {
    console.error("Calendly webhook refused: CALENDLY_WEBHOOK_SIGNING_KEY is not set");
    return unauthorized();
  }

  const signature = parseCalendlySignature(request.headers.get("calendly-webhook-signature"));
  if (!signature || !isFreshCalendlySignature(signature)) return unauthorized();

  const body = await readBodyWithLimit(request, MAX_CALENDLY_BODY_BYTES);
  if (!body.ok) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  if (!verifyCalendlySignature(body.text, signature, signingKey)) return unauthorized();

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const booking = extractCalendlyBooking(parsed);
  if (!booking) return NextResponse.json({ ok: true, skipped: "no_invitee_email" });

  await recordEvent("calendly", "booking", { ...booking });

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
