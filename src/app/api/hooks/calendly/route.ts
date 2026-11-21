import { NextRequest, NextResponse } from "next/server";
import { recordEvent } from "@/lib/sync/workable-sync";
import { getServiceSupabase } from "@/lib/supabase/server";
import { parseJsonObject, payloadTooLarge, readBodyCapped } from "@/lib/ingest/webhook";

export async function POST(request: NextRequest) {
  const rawBody = await readBodyCapped(request);
  if (rawBody === null) return payloadTooLarge();
  const payload = parseJsonObject(rawBody) as
    | (Record<string, unknown> & { payload?: { email?: string }; invitee?: { email?: string } })
    | null;
  if (!payload) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
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
