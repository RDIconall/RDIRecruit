import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { env } from "@/lib/env";
import { recordEvent } from "@/lib/sync/workable-sync";
import { getServiceSupabase } from "@/lib/supabase/server";
import { rescoreCandidateOnNewEvidence } from "@/lib/sync/rescore";
import {
  MAX_TRANSCRIPT_CHARS,
  parseJsonObject,
  payloadTooLarge,
  readBodyCapped,
  verifyHmacSha256,
} from "@/lib/ingest/webhook";

export const runtime = "nodejs";

function sameSecret(provided: string, secret: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

/**
 * The request must prove VIDEOASK_WEBHOOK_SECRET: either a raw shared-secret
 * header, or an HMAC-SHA256 signature of the body. The route is public, so when
 * the secret is unset every delivery is refused.
 */
function isAuthorized(rawBody: string, request: NextRequest): boolean {
  const secret = env.VIDEOASK_WEBHOOK_SECRET;
  if (!secret) return false;

  const shared =
    request.headers.get("x-videoask-secret") ?? request.headers.get("videoask-secret");
  if (shared && sameSecret(shared, secret)) return true;

  const signature =
    request.headers.get("x-videoask-signature") ?? request.headers.get("videoask-signature");
  return verifyHmacSha256(rawBody, signature, secret);
}

function transcriptFrom(payload: Record<string, unknown>): string | null {
  const p = payload as { transcript?: unknown; form_response?: { transcription?: unknown } };
  const value = p.transcript ?? p.form_response?.transcription;
  if (typeof value !== "string") return null;
  return value.trim() || null;
}

export async function POST(request: NextRequest) {
  const rawBody = await readBodyCapped(request);
  if (rawBody === null) return payloadTooLarge();

  const payload = parseJsonObject(rawBody);
  if (!payload) {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const transcript = transcriptFrom(payload);
  if (transcript && transcript.length > MAX_TRANSCRIPT_CHARS) {
    return payloadTooLarge("transcript_too_long");
  }

  if (!isAuthorized(rawBody, request)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
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
    transcript,
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
