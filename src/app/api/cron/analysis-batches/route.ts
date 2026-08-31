import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { processCanonicalAnalysisBatches } from "@/lib/analysis/batch";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Drain the Message Batch queue independently of Workable sync and the scoring
 * lock. Submit pending fingerprints, poll in-flight batches, and project durable
 * results so automated analysis stays on the 50% Anthropic batch path.
 */
export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (env.CRON_SECRET && auth !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await processCanonicalAnalysisBatches();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("Canonical analysis batch tick failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Batch tick failed" },
      { status: 500 },
    );
  }
}
