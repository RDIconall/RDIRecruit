import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { markEventFailure, markEventProcessed, recordEvent } from "@/lib/sync/workable-sync";
import { syncCandidateFromWebhook } from "@/lib/sync/incremental-sync";
import { eventFailureStatus } from "@/lib/sync/event-queue";
import { verifyWorkableSignature } from "@/lib/workable/client";

// Workable SPI v3 only exposes two subscribable candidate events:
// `candidate_created` and `candidate_moved`. Disqualification, requalification,
// and hire are NOT separate events — they all surface as `candidate_moved` (a
// move to the disqualified/hired state), so we derive them from the re-fetched
// candidate's stage / `disqualified` flag in syncCandidateFromWebhook.
// NOTE: a subscription's `target` URL must be unique (a duplicate returns 409);
// the live candidate_created subscription is id 103591 — don't re-create it.
// https://workable.readme.io/reference/webhook-subscriptions
const HANDLED_EVENTS = new Set(["candidate_created", "candidate_moved"]);

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
    type?: string;
    data?: {
      id?: string;
      candidate?: { id?: string };
      job?: { shortcode?: string };
    };
  };

  const eventType = payload.event_type ?? payload.type ?? "unknown";
  let eventId: string | null;
  try {
    eventId = await recordEvent("workable", eventType, payload as Record<string, unknown>);
  } catch (error) {
    console.error("Workable webhook enqueue failed", error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  const candidateId = payload.data?.candidate?.id ?? payload.data?.id;
  const jobShortcode = payload.data?.job?.shortcode;
  if (candidateId && jobShortcode && HANDLED_EVENTS.has(eventType)) {
    try {
      await syncCandidateFromWebhook({ eventType, jobShortcode, candidateId });
      if (eventId) await markEventProcessed(eventId);
      return NextResponse.json({ ok: true, processed: true, eventId });
    } catch (error) {
      console.error("Workable webhook processing failed", error);
      if (eventId) {
        await markEventFailure(
          eventId,
          eventFailureStatus(error, 1),
          error instanceof Error ? error.message : String(error),
        );
      }
      return NextResponse.json({ ok: false, queued: true, eventId }, { status: 500 });
    }
  }

  if (eventId) await markEventProcessed(eventId);
  return NextResponse.json({ ok: true, queued: false, eventId });
}
