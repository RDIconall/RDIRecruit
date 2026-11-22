import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Bounds on pasted or posted interview material (transcripts, VideoAsk answers,
 * activity entries). Every capture is stored on the applicant and most of them
 * start a model re-score, so both the size of one capture and how many one
 * caller can add are capped before anything is written.
 *
 * The count caps are enforced again inside Postgres by enforce_capture_quota()
 * (supabase/migrations/20261122050000_capture_quotas.sql) so parallel requests
 * cannot slip past the read-then-insert check here. Keep the numbers in sync.
 */
export const MAX_CAPTURE_CHARS = 65_536;
export const MAX_CAPTURES = 40;

/** Interview evidence a signed-in account may add per rolling window (each one re-scores). */
export const EVIDENCE_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Activity-log entries a signed-in account may add per rolling window. */
export const ACTIVITY_QUOTA_WINDOW_MS = 60 * 60 * 1000;

/** Largest JSON body the public transcript webhooks will read. */
export const MAX_WEBHOOK_BODY_CHARS = 1_048_576;

/** Largest serialized working-file workspace a write may grow to. */
export const MAX_WORKSPACE_CHARS = 1_048_576;

export const CAPTURE_QUOTA_ERROR = "capture_quota_exceeded";

export function captureTooLong(text: string | null | undefined): boolean {
  return (text?.length ?? 0) > MAX_CAPTURE_CHARS;
}

export const CAPTURE_TOO_LONG_MESSAGE = `That text is longer than ${MAX_CAPTURE_CHARS.toLocaleString("en-US")} characters. Trim it and save again.`;

export function isCaptureQuotaError(error: { message?: string } | null | undefined): boolean {
  return Boolean(error?.message?.includes(CAPTURE_QUOTA_ERROR));
}

/**
 * True when `accountId` has already added MAX_CAPTURES rows to `table` inside
 * the window. Fails closed: an unreadable count is treated as over quota.
 */
export async function accountQuotaReached(
  supabase: SupabaseClient,
  table: "evidence" | "activity",
  accountId: string,
  windowMs: number,
): Promise<boolean> {
  const since = new Date(Date.now() - windowMs).toISOString();
  const { count, error } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("created_by", accountId)
    .gte("created_at", since);
  if (error) {
    console.error(`Capture quota check failed for ${table}`, error);
    return true;
  }
  return (count ?? 0) >= MAX_CAPTURES;
}

/**
 * True when a candidate already holds MAX_CAPTURES evidence rows of one source
 * (webhook captures have no signed-in account to count against). Fails closed.
 */
export async function candidateQuotaReached(
  supabase: SupabaseClient,
  candidateId: string,
  sourceType: string,
): Promise<boolean> {
  const { count, error } = await supabase
    .from("evidence")
    .select("id", { count: "exact", head: true })
    .eq("candidate_id", candidateId)
    .eq("source_type", sourceType);
  if (error) {
    console.error(`Capture quota check failed for ${sourceType}`, error);
    return true;
  }
  return (count ?? 0) >= MAX_CAPTURES;
}
