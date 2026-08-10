import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { incrementalSync, rescoreOnly } from "@/lib/sync/incremental-sync";

// Mirror + enqueue only — Claude evaluations run as durable Workflow steps, so
// this cron should return in seconds. Keep maxDuration for the Workable mirror
// on a busy day, not for AI work.
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (env.CRON_SECRET && auth !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ?scoreOnly=1 enqueues the durable scoring workflow for stale + unscored
  // candidates without the Workable mirror.
  const scoreOnly = request.nextUrl.searchParams.get("scoreOnly") === "1";

  try {
    if (scoreOnly) {
      const result = await rescoreOnly();
      return NextResponse.json({ ok: true, mode: "scoreOnly", ...result });
    }
    const result = await incrementalSync("daily");
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("Daily reconcile failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Reconcile failed" },
      { status: 500 },
    );
  }
}
