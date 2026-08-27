/**
 * Workable exposes more job states than `published` and `archived` (closed,
 * on_hold, draft…). The jobs sync only lists those two, so a job moved to any
 * other state was in neither list and its local row kept `status = 'published'`
 * forever — which is why closed roles stayed in the cross-role job picker and
 * kept feeding their old applicants into the inbox.
 *
 * Returns the locally-published shortcodes Workable no longer reports as
 * published. These are only CANDIDATES for closure: absence from a list is weak
 * evidence (a partial page, a rate limit, a locally-created job), so each one
 * must be confirmed against the job's actual state before anything is written.
 * Closing a job hides its whole pool, so this side never guesses.
 */
export function stalePublishedShortcodes(input: {
  localPublished: string[];
  published: string[];
  archived: string[];
  /** False when the Workable published fetch failed or returned nothing. */
  publishedFetchOk: boolean;
}): string[] {
  // Never close the whole board because one API call failed.
  if (!input.publishedFetchOk || !input.published.length) return [];

  const live = new Set(input.published);
  const archived = new Set(input.archived);
  return input.localPublished.filter((code) => !live.has(code) && !archived.has(code));
}

/**
 * Confirmation step: only Workable explicitly reporting a non-published state
 * justifies closing a job locally. An unknown/empty state leaves it alone.
 */
export function shouldCloseJob(state: string | null | undefined): boolean {
  const s = (state ?? "").trim().toLowerCase();
  if (!s) return false;
  return s !== "published";
}
