import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { guardIngest, hasSharedSecretHeader } from "@/lib/ingest/guard";
import { recordEvent } from "@/lib/sync/workable-sync";

export const runtime = "nodejs";

/**
 * Gmail reply capture stub — read-only OAuth attaches replies as evidence rows.
 * The relay must send GMAIL_INGEST_SECRET in `x-gmail-ingest-secret`.
 */
export async function POST(request: NextRequest) {
  const guard = await guardIngest(request, {
    route: "gmail",
    secret: env.GMAIL_INGEST_SECRET,
    authorize: (_raw, req, secret) => hasSharedSecretHeader(req, "x-gmail-ingest-secret", secret),
  });
  if (!guard.ok) return guard.response;

  await recordEvent("gmail", "reply_captured", guard.payload);
  return NextResponse.json({ ok: true, status: "recorded" });
}
