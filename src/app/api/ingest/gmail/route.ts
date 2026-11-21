import { NextRequest, NextResponse } from "next/server";
import { recordEvent } from "@/lib/sync/workable-sync";
import { boundJson } from "@/lib/ingest/limits";

/** Gmail reply capture stub — read-only OAuth attaches replies as evidence rows. */
export async function POST(request: NextRequest) {
  const payload = await request.json().catch(() => ({}));
  await recordEvent("gmail", "reply_captured", boundJson(payload as Record<string, unknown>));
  return NextResponse.json({ ok: true, status: "recorded" });
}
