import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { backfillMissingResumes, recaptureBlockedResumes } from "@/lib/resume/backfill";
import { backfillMissingPhotos } from "@/lib/sync/photo-backfill";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Re-ingest résumés for candidates left unparsed by the pdf-parse break. Safe to
 * re-run: it only touches candidates with a résumé URL and no stored copy, and is
 * time-budgeted so each pass finishes within maxDuration. Returns `remaining` so
 * a caller can keep hitting it until the backlog is drained.
 *
 * `?mode=recapture` instead pulls the AUTHORITATIVE Workable candidate (which
 * carries resume_url the bulk-mirror LIST endpoint drops) for blocked candidates
 * with no stored résumé and re-ingests any that actually have one. Extra params:
 *   dryRun=1            only report whether Workable has a résumé (verification sample)
 *   limit=<n>           cap candidates processed
 *   ids=<id,id,...>     force re-ingest specific candidates (e.g. re-OCR a scan)
 *
 * `?mode=photos` backfills candidate profile photos the bulk mirror could never
 * capture (the LIST endpoint omits `image_url`): it pulls the authoritative single
 * candidate and writes `candidates.photo_url`. `limit=<n>` caps candidates processed.
 */
export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (env.CRON_SECRET && auth !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const limitParam = params.get("limit");
  const limit = limitParam ? Number(limitParam) : undefined;
  const boundedLimit = Number.isFinite(limit) ? limit : undefined;

  try {
    if (params.get("mode") === "photos") {
      const result = await backfillMissingPhotos({
        budgetMs: 240_000,
        limit: boundedLimit,
      });
      return NextResponse.json({ ok: true, mode: "photos", ...result });
    }

    if (params.get("mode") === "recapture") {
      const idsParam = params.get("ids");
      const ids = idsParam ? idsParam.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      const result = await recaptureBlockedResumes({
        budgetMs: 240_000,
        limit: boundedLimit,
        dryRun: params.get("dryRun") === "1",
        ids,
      });
      return NextResponse.json({ ok: true, mode: "recapture", ...result });
    }

    const result = await backfillMissingResumes({
      budgetMs: 240_000,
      limit: boundedLimit,
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
