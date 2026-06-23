import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { markEventProcessed, recordEvent } from "@/lib/sync/workable-sync";
import { syncCandidateFromWebhook } from "@/lib/sync/incremental-sync";
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
