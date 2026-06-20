import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { backfillMissingResumes } from "@/lib/resume/backfill";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Re-ingest résumés for candidates left unparsed by the pdf-parse break. Safe to
 * re-run: it only touches candidates with a résumé URL and no stored copy, and is
 * time-budgeted so each pass finishes within maxDuration. Returns `remaining` so
 * a caller can keep hitting it until the backlog is drained.
 */
export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (env.CRON_SECRET && auth !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limitParam = request.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : undefined;

  try {
    const result = await backfillMissingResumes({
      budgetMs: 240_000,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("Resume backfill failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Backfill failed" },
      { status: 500 },
    );
  }
}
