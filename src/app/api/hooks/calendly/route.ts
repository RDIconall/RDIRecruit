import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { guardIngest, hasSharedSecretHeader, hmacSha256Hex, safeEqual } from "@/lib/ingest/guard";
import { recordEvent } from "@/lib/sync/workable-sync";
import { getServiceSupabase } from "@/lib/supabase/server";

export const runtime = "nodejs";

const SIGNATURE_TOLERANCE_SECONDS = 180;

/**
 * Calendly's native `Calendly-Webhook-Signature: t=<unix>,v1=<hex>` where v1 is
 * HMAC-SHA256(signing key, `${t}.${rawBody}`), with a replay window on t.
 * https://developer.calendly.com/api-docs/overview/webhooks/webhook-signatures
 */
function hasValidCalendlySignature(rawBody: string, request: NextRequest, secret: string): boolean {
  const header = request.headers.get("calendly-webhook-signature");
  if (!header) return false;
  const parts = new Map(
    header.split(",").map((part) => {
      const [key, ...rest] = part.split("=");
      return [key.trim(), rest.join("=").trim()] as const;
    }),
  );
  const t = parts.get("t");
  const v1 = parts.get("v1");
  if (!t || !v1 || !/^\d+$/.test(t)) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > SIGNATURE_TOLERANCE_SECONDS) return false;
  return safeEqual(v1, hmacSha256Hex(secret, `${t}.${rawBody}`));
}

/** Requires CALENDLY_WEBHOOK_SECRET, as the subscription signing key or in `x-calendly-webhook-secret`. */
export async function POST(request: NextRequest) {
  const guard = await guardIngest(request, {
    route: "calendly",
    secret: env.CALENDLY_WEBHOOK_SECRET,
    authorize: (raw, req, secret) =>
      hasSharedSecretHeader(req, "x-calendly-webhook-secret", secret) ||
      hasValidCalendlySignature(raw, req, secret),
  });
  if (!guard.ok) return guard.response;

  const payload = guard.payload as {
    payload?: { email?: string };
    invitee?: { email?: string };
  };
  await recordEvent("calendly", "booking", guard.payload);

  const email = payload.payload?.email ?? payload.invitee?.email;
  if (!email) return NextResponse.json({ ok: true });

  const supabase = getServiceSupabase();
  const { data: candidate } = await supabase
    .from("candidates")
    .select("workable_id, job_shortcode, stage")
    .eq("email", email)
    .maybeSingle();

  if (candidate) {
    await supabase.from("comms_log").insert({
      candidate_id: candidate.workable_id,
      channel: "calendly",
      direction: "inbound",
      template: "screen_booked",
      status: "sent",
      body: JSON.stringify(payload),
    });
  }

  return NextResponse.json({ ok: true });
}
