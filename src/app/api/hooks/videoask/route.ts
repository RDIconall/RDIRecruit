import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { recordEvent } from "@/lib/sync/workable-sync";
import { getServiceSupabase } from "@/lib/supabase/server";
import { rescoreCandidateOnNewEvidence } from "@/lib/sync/rescore";
import { verifyWebhookSecret } from "@/lib/ingest/webhook-auth";

export const runtime = "nodejs";

/**
 * Requires VIDEOASK_WEBHOOK_SECRET: the request must carry it in a shared-secret
 * header, or an HMAC-SHA256 signature of the body. With the env var unset or blank
 * the webhook refuses everything, since the body picks the candidate and is stored
 * as interview evidence that re-scores them.
 */
function isAuthorized(rawBody: string, request: NextRequest): boolean {
  return verifyWebhookSecret({
    secret: env.VIDEOASK_WEBHOOK_SECRET,
    rawBody,
    headers: request.headers,
    sharedSecretHeaders: ["x-videoask-secret", "videoask-secret"],
    signatureHeaders: ["x-videoask-signature", "videoask-signature"],
  });
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
