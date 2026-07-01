import { hasSupabase, hasWorkable } from "../env";
import { getServiceSupabase } from "../supabase/server";
import { getCandidate } from "../workable/client";

/**
 * Backfill candidate profile photos the bulk mirror could never capture.
 *
 * Workable's LIST endpoint omits `image_url`, so candidates mirrored in bulk have
 * `photo_url is null`. This pulls the AUTHORITATIVE single candidate (which DOES
 * carry `image_url`) for each and stores it on the durable `candidates.photo_url`
 * column. Candidates Workable genuinely has no photo for are marked with an empty
 * string sentinel so they drop out of the queue and are never re-fetched.
 *
 * Rate-limited (~1 req/1.1s) under Workable's ~10 req/s ceiling, time-budgeted so
 * a cron never exceeds maxDuration, and resumable via `remaining`. Never throws.
 */
export interface PhotoBackfillResult {
  attempted: number;
  withPhoto: number;
  withoutPhoto: number;
  failed: number;
  remaining: number;
  errors: string[];
}

export async function backfillMissingPhotos(options?: {
  budgetMs?: number;
  limit?: number;
}): Promise<PhotoBackfillResult> {
  const result: PhotoBackfillResult = {
    attempted: 0,
    withPhoto: 0,
    withoutPhoto: 0,
    failed: 0,
    remaining: 0,
    errors: [],
  };

  if (!hasSupabase() || !hasWorkable()) return result;

  const supabase = getServiceSupabase();

  // Candidates with no photo decision yet (null = never single-fetched). The ''
  // sentinel ("checked, Workable has none") is excluded so we don't re-fetch them.
  const { data: rows, error } = await supabase
    .from("candidates")
    .select("workable_id, job_shortcode")
    .is("photo_url", null)
    .not("job_shortcode", "is", null);

  if (error) {
    result.errors.push(`query failed: ${error.message}`);
    return result;
  }

  const queue = (rows ?? [])
    .map((r) => ({ id: r.workable_id as string, shortcode: r.job_shortcode as string }))
    .slice(0, options?.limit ?? rows?.length ?? 0);

  if (!queue.length) return result;

  const budgetMs = options?.budgetMs ?? 240_000;
  const start = Date.now();
  let processed = 0;

  for (const { id, shortcode } of queue) {
    if (Date.now() - start > budgetMs) break;
    processed += 1;
    result.attempted += 1;

    try {
      const candidate = await getCandidate(shortcode, id);
      const img = candidate.image_url;
      const photo = typeof img === "string" && img.startsWith("http") ? img : "";

      // '' is the "checked, no photo" sentinel — it drops the row out of the
      // `is null` queue so it is never re-fetched, while still failing the
      // startsWith("http") test on the read side (falls back to initials).
      const { error: updateError } = await supabase
        .from("candidates")
        .update({ photo_url: photo })
        .eq("workable_id", id);

      if (updateError) {
        result.failed += 1;
        if (result.errors.length < 10) result.errors.push(`${id}: ${updateError.message}`);
      } else if (photo) {
        result.withPhoto += 1;
      } else {
        result.withoutPhoto += 1;
      }
    } catch (err) {
      result.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      if (result.errors.length < 10) result.errors.push(`${id}: ${message}`);
      console.error(`Photo backfill failed for ${id}`, err);
    }

    // Respect Workable's ~10 req/s ceiling with margin.
    await new Promise((r) => setTimeout(r, 1100));
  }

  result.remaining = Math.max(0, queue.length - processed);
  return result;
}
