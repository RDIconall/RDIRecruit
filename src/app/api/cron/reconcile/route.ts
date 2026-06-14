import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { incrementalSync, rescoreOnly } from "@/lib/sync/incremental-sync";

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (env.CRON_SECRET && auth !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ?scoreOnly=1 drives a bulk re-score (stale + unscored) without the Workable
  // mirror — used to drain a scoring-epoch bump efficiently. The atomic lock keeps
  // it from colliding with the scheduled reconcile.
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
