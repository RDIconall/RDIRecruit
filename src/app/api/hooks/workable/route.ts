import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { markEventProcessed, recordEvent } from "@/lib/sync/workable-sync";
import { syncCandidateFromWebhook } from "@/lib/sync/incremental-sync";
import { verifyWorkableSignature } from "@/lib/workable/client";

const HANDLED_EVENTS = new Set([
  "candidate_created",
  "candidate_updated",
  "candidate_moved",
  "candidate_disqualified",
  "candidate_requalified",
  "candidate_hired",
]);

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get("X-Workable-Signature");

  if (env.WORKABLE_WEBHOOK_SECRET) {
    const valid = verifyWorkableSignature(
      rawBody,
      signature,
      env.WORKABLE_WEBHOOK_SECRET,
    );
    if (!valid) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  }

  const payload = JSON.parse(rawBody) as {
    id?: string;
    event_type?: string;
    data?: {
      id?: string;
      candidate?: { id?: string };
      job?: { shortcode?: string };
    };
  };

  const eventType = payload.event_type ?? "unknown";
  await recordEvent("workable", eventType, payload as Record<string, unknown>);

  try {
    const candidateId = payload.data?.candidate?.id ?? payload.data?.id;
    const jobShortcode = payload.data?.job?.shortcode;

    if (candidateId && jobShortcode && HANDLED_EVENTS.has(eventType)) {
      await syncCandidateFromWebhook({ eventType, jobShortcode, candidateId });
    }

    if (payload.id) await markEventProcessed(payload.id);
  } catch (error) {
    console.error("Workable webhook processing failed", error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
