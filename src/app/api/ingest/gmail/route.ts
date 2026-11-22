import { NextRequest, NextResponse } from "next/server";
import { recordEvent } from "@/lib/sync/workable-sync";
import { readBodyWithLimit } from "@/lib/http/read-body";

/** Gmail reply capture stub — read-only OAuth attaches replies as evidence rows. */
export async function POST(request: NextRequest) {
  const body = await readBodyWithLimit(request);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }
  let payload: unknown = {};
  try {
    payload = JSON.parse(body.text);
  } catch {}
  await recordEvent("gmail", "reply_captured", payload as Record<string, unknown>);
  return NextResponse.json({ ok: true, status: "recorded" });
}
