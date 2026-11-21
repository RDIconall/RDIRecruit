import { NextRequest, NextResponse } from "next/server";
import { recordEvent } from "@/lib/sync/workable-sync";
import { getServiceSupabase } from "@/lib/supabase/server";
import { boundJson } from "@/lib/ingest/limits";

export async function POST(request: NextRequest) {
  const payload = await request.json();
  await recordEvent("calendly", "booking", boundJson(payload));

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
      body: JSON.stringify(boundJson(payload)),
    });
  }

  return NextResponse.json({ ok: true });
}
