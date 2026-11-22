import { NextRequest, NextResponse } from "next/server";
import { recordEvent } from "@/lib/sync/workable-sync";
import { getServiceSupabase } from "@/lib/supabase/server";
import { readBodyWithLimit } from "@/lib/http/read-body";

export async function POST(request: NextRequest) {
  const body = await readBodyWithLimit(request);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }
  let payload;
  try {
    payload = JSON.parse(body.text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
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
