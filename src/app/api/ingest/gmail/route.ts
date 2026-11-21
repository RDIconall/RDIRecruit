import { NextRequest, NextResponse } from "next/server";
import { recordEvent } from "@/lib/sync/workable-sync";
import { readCappedBody } from "@/lib/ingest/limits";

/** Gmail reply capture stub — read-only OAuth attaches replies as evidence rows. */
export async function POST(request: NextRequest) {
  const rawBody = await readCappedBody(request);
  if (rawBody === null) {
    return NextResponse.json({ ok: false, error: "Payload too large" }, { status: 413 });
  }
  let payload: unknown = {};
  try {
    payload = JSON.parse(rawBody);
  } catch {
    payload = {};
  }
  await recordEvent("gmail", "reply_captured", payload as Record<string, unknown>);
  return NextResponse.json({ ok: true, status: "recorded" });
}
