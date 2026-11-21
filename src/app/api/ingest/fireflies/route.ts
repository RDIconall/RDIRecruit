import { NextRequest, NextResponse } from "next/server";
import { recordEvent } from "@/lib/sync/workable-sync";
import { getServiceSupabase } from "@/lib/supabase/server";
import { env, hasSupabase } from "@/lib/env";
import { rescoreCandidateOnNewEvidence } from "@/lib/sync/rescore";
import { provesWebhookSecret } from "@/lib/ingest/webhook-auth";
import { boundJson, capTranscript, clipText, EVIDENCE_LABEL_MAX_CHARS } from "@/lib/ingest/limits";
import {
  extractInlineTranscript,
  extractTranscriptId,
  fetchFirefliesTranscript,
  hasFirefliesApiKey,
  type FirefliesTranscript,
} from "@/lib/ingest/fireflies";

export const runtime = "nodejs";

/**
 * Fireflies transcript ingest. Flows a meeting transcript into an `evidence` row
 * (source_type "fireflies") and triggers a re-score. The transcript is taken from
 * the webhook payload when present, otherwise fetched from the Fireflies GraphQL
 * API using FIREFLIES_API_KEY. The candidate is resolved from an explicit id in
 * the payload metadata, or by matching meeting participant emails to a candidate.
 *
 * The request must prove FIREFLIES_WEBHOOK_SECRET: Fireflies' own `X-Hub-Signature`
 * (HMAC-SHA256 of the body, `sha256=` prefix optional), or the raw secret in
 * `x-fireflies-secret` for relays that cannot sign. Unset secret refuses everything.
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const authorized = provesWebhookSecret(rawBody, request.headers, env.FIREFLIES_WEBHOOK_SECRET, {
    sharedHeaders: ["x-fireflies-secret"],
    signatureHeaders: ["x-hub-signature"],
  });
  if (!authorized) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    payload = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    payload = {};
  }
  await recordEvent("fireflies", "transcript_ready", boundJson(payload));

  if (!hasSupabase()) {
    return NextResponse.json({ ok: true, skipped: "supabase_not_configured" });
  }

  // 1) Get the transcript text — inline first, then via the API by id.
  let transcript: FirefliesTranscript | null = extractInlineTranscript(payload);
  let source: "inline" | "api" = "inline";

  if (!transcript) {
    const transcriptId = extractTranscriptId(payload);
    if (!transcriptId) {
      return NextResponse.json({ ok: true, skipped: "no_transcript_or_id" });
    }
    if (!hasFirefliesApiKey()) {
      return NextResponse.json({
        ok: true,
        skipped: "needs_fireflies_api_key",
        hint: "Set FIREFLIES_API_KEY to fetch transcripts that arrive by id only.",
        transcriptId,
      });
    }
    try {
      transcript = await fetchFirefliesTranscript(transcriptId);
      source = "api";
    } catch (error) {
      console.error("Fireflies fetch failed", error);
      return NextResponse.json(
        { ok: false, error: error instanceof Error ? error.message : "fireflies_fetch_failed" },
        { status: 502 },
      );
    }
  }

  if (!transcript || !transcript.text) {
    return NextResponse.json({ ok: true, skipped: "empty_transcript" });
  }

  // 2) Resolve the candidate.
  const supabase = getServiceSupabase();
  const explicitId =
    (payload.metadata as { workable_id?: string; candidate_id?: string } | undefined)?.workable_id ??
    (payload.metadata as { candidate_id?: string } | undefined)?.candidate_id ??
    (payload.workable_id as string | undefined) ??
    (payload.candidate_id as string | undefined) ??
    null;

  let workableId = explicitId;
  if (!workableId) {
    const candidateEmails = transcript.participantEmails.filter(
      (e) => e !== transcript!.organizerEmail,
    );
    const emailsToTry = candidateEmails.length ? candidateEmails : transcript.participantEmails;
    for (const email of emailsToTry) {
      const { data } = await supabase
        .from("candidates")
        .select("workable_id")
        .ilike("email", email)
        .maybeSingle();
      if (data?.workable_id) {
        workableId = data.workable_id as string;
        break;
      }
    }
  }

  if (!workableId) {
    return NextResponse.json({
      ok: true,
      skipped: "candidate_not_resolved",
      hint: "Pass metadata.workable_id, or ensure a candidate email matches a meeting participant.",
      participants: transcript.participantEmails,
    });
  }

  // 3) Store the transcript as evidence (raw_ref dedupes repeated webhook fires).
  const { error: insertError } = await supabase.from("evidence").insert({
    candidate_id: workableId,
    source_type: "fireflies",
    author: clipText(transcript.organizerEmail ?? "fireflies", EVIDENCE_LABEL_MAX_CHARS),
    label: clipText(transcript.title ?? "Fireflies meeting", EVIDENCE_LABEL_MAX_CHARS),
    captured_at: new Date().toISOString(),
    raw_ref: transcript.id ? `fireflies:${transcript.id}` : null,
    transcript: capTranscript(transcript.text),
    extracted: boundJson({ source, title: transcript.title, participants: transcript.participantEmails }),
  });

  if (insertError) {
    // Unique (candidate_id, raw_ref) collision means we already ingested this meeting.
    if (insertError.code === "23505") {
      return NextResponse.json({ ok: true, deduped: true, candidateId: workableId });
    }
    console.error("Fireflies evidence insert failed", insertError);
    return NextResponse.json({ ok: false, error: insertError.message }, { status: 500 });
  }

  // 4) Recalculate the read with the new interview evidence.
  const rescore = await rescoreCandidateOnNewEvidence(workableId, "fireflies");

  return NextResponse.json({ ok: true, candidateId: workableId, scored: rescore.scored, source });
}
