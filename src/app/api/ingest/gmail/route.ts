import { NextRequest, NextResponse } from "next/server";
import { recordEvent } from "@/lib/sync/workable-sync";
import { readTextWithLimit } from "@/lib/ingest/read-body";
import { WEBHOOK_BODY_MAX_BYTES } from "@/lib/triage/limits";

/** Gmail reply capture stub — read-only OAuth attaches replies as evidence rows. */
export async function POST(request: NextRequest) {
  const raw = await readTextWithLimit(request, WEBHOOK_BODY_MAX_BYTES);
  if (raw === null) return NextResponse.json({ ok: false, error: "payload_too_large" }, { status: 413 });
  let payload: unknown = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = {};
  }
  await recordEvent("gmail", "reply_captured", payload as Record<string, unknown>);
  return NextResponse.json({ ok: true, status: "recorded" });
}
