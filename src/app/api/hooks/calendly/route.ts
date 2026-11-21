import { NextRequest, NextResponse } from "next/server";
import { recordEvent } from "@/lib/sync/workable-sync";
import { getServiceSupabase } from "@/lib/supabase/server";
import { readTextWithLimit } from "@/lib/ingest/read-body";
import { WEBHOOK_BODY_MAX_BYTES } from "@/lib/triage/limits";

export async function POST(request: NextRequest) {
  const raw = await readTextWithLimit(request, WEBHOOK_BODY_MAX_BYTES);
  if (raw === null) return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  const payload = JSON.parse(raw);
  await recordEvent("calendly", "booking", payload);

  const email = payload.payload?.email ?? payload.invitee?.email;
  if (!email) return NextResponse.json({ ok: true });

  const supabase = getServiceSupabase();
  const { data: candidate } = await supabase
    .from("candidates")
    .select("workable_id, job_shortcode, stage")
    .eq("email", email)
    .maybeSingle();

  if (candidate) {
    await supabase.from("comms_log").insert({
      candidate_id: candidate.workable_id,
      channel: "calendly",
      direction: "inbound",
      template: "screen_booked",
      status: "sent",
      body: JSON.stringify(payload),
    });
  }

  return NextResponse.json({ ok: true });
}
