/**
 * Workable exposes more job states than `published` and `archived` (closed,
 * on_hold, draft…). The jobs sync only lists those two, so a job moved to any
 * other state was in neither list and its local row kept `status = 'published'`
 * forever — which is why closed roles stayed in the cross-role job picker and
 * kept feeding their old applicants into the inbox.
 *
 * Returns the locally-published shortcodes Workable no longer reports as
 * published, so they can be reconciled to closed.
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
