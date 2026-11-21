import { NextRequest, NextResponse } from "next/server";
import { recordEvent } from "@/lib/sync/workable-sync";
import { parseJsonObject, payloadTooLarge, readBodyCapped } from "@/lib/ingest/webhook";

/** Gmail reply capture stub — read-only OAuth attaches replies as evidence rows. */
export async function POST(request: NextRequest) {
  const rawBody = await readBodyCapped(request);
  if (rawBody === null) return payloadTooLarge();
  const payload = parseJsonObject(rawBody) ?? {};
  await recordEvent("gmail", "reply_captured", payload);
  return NextResponse.json({ ok: true, status: "recorded" });
}
