import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { env } from "@/lib/env";
import { recordEvent } from "@/lib/sync/workable-sync";
import { getServiceSupabase } from "@/lib/supabase/server";
import { rescoreCandidateOnNewEvidence } from "@/lib/sync/rescore";

export const runtime = "nodejs";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Accepts the webhook when VIDEOASK_WEBHOOK_SECRET is unset (back-compat), or when
 * the request proves the secret: either a raw shared-secret header, or an HMAC-SHA256
 * signature of the body. Keeps the previously-working webhook flowing while letting
 * production lock it down by setting the env var + configuring the secret in VideoAsk.
 */
function isAuthorized(rawBody: string, request: NextRequest): boolean {
  const secret = env.VIDEOASK_WEBHOOK_SECRET;
  if (!secret) return true;

  const shared =
    request.headers.get("x-videoask-secret") ?? request.headers.get("videoask-secret");
  if (shared && safeEqual(shared, secret)) return true;

  const signature =
    request.headers.get("x-videoask-signature") ?? request.headers.get("videoask-signature");
  if (signature) {
    const digest = createHmac("sha256", secret).update(rawBody).digest("hex");
    if (safeEqual(signature, digest)) return true;
  }

  return false;
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  if (!isAuthorized(rawBody, request)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  await recordEvent("videoask", "response", payload);

  const p = payload as {
    contact?: { email?: string };
    respondent?: { email?: string };
    metadata?: { candidate_id?: string; workable_id?: string };
    form_response?: { response_id?: string; transcription?: string };
    transcript?: string;
    id?: string;
  };

  const email = p.contact?.email ?? p.respondent?.email ?? p.metadata?.candidate_id;
  if (!email) {
    return NextResponse.json({ ok: true, skipped: "no_candidate_reference" });
  }

  const supabase = getServiceSupabase();
  const { data: candidate } = await supabase
    .from("candidates")
    .select("workable_id")
    .eq("email", email)
    .maybeSingle();

  const workableId = candidate?.workable_id ?? p.metadata?.workable_id;
  if (!workableId) {
    return NextResponse.json({ ok: true, skipped: "candidate_not_resolved" });
  }

  const { error: insertError } = await supabase.from("evidence").insert({
    candidate_id: workableId,
    source_type: "async_video",
    author: "candidate",
    label: "VideoAsk",
    captured_at: new Date().toISOString(),
    raw_ref: p.form_response?.response_id ?? p.id,
    transcript: p.transcript ?? p.form_response?.transcription,
    extracted: payload,
  });

  if (insertError) {
    if (insertError.code === "23505") {
      return NextResponse.json({ ok: true, deduped: true, candidateId: workableId });
    }
    console.error("VideoAsk evidence insert failed", insertError);
    return NextResponse.json({ ok: false, error: insertError.message }, { status: 500 });
  }

  const rescore = await rescoreCandidateOnNewEvidence(workableId, "async_video");
  return NextResponse.json({ ok: true, candidateId: workableId, scored: rescore.scored });
}
