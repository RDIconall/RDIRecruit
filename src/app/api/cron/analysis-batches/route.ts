import { NextRequest, NextResponse } from "next/server";
import { isOperatorRequest } from "@/lib/operator-auth";
import { processCanonicalAnalysisBatches } from "@/lib/analysis/batch";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Drain the Message Batch queue independently of Workable sync and the scoring
 * lock. Also copies already-paid canonical analyses onto the inbox as fit reads
 * and queues anyone still waiting on a first write-up.
 */
export async function GET(request: NextRequest) {
  if (!isOperatorRequest(request)) {
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
