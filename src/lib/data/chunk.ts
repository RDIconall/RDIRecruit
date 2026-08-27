/**
 * Max candidate ids per query. Every per-candidate read filters with
 * `.in("candidate_id", ids)`, and PostgREST puts that list in the request URL —
 * an unbounded list makes the request fail outright, which took the whole pool
 * page down. 300 keeps each URL well inside safe limits.
 */
export const ID_CHUNK = 300;

/** Split ids into bounded batches. A non-positive size yields one batch. */
export function chunkIds<T>(ids: T[], size: number = ID_CHUNK): T[][] {
  if (!ids.length) return [];
  if (size <= 0) return [ids];
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    out.push(ids.slice(i, i + size));
  }
  return out;
}
