import { upsertOverlay } from "../data/overlay";
import { isPermanentWorkableNotFound } from "../workable/errors";

export { isPermanentWorkableNotFound };

/**
 * Workable is the ATS of record. A 404 from an authoritative candidate fetch
 * means the candidate was deleted/merged upstream. Retire the local row out of
 * the active pool without deleting historical scoring/evaluation data.
 */
export async function tombstoneMissingWorkableCandidate(
  candidateId: string,
  actor = "workable-sync",
): Promise<void> {
  await upsertOverlay(
    candidateId,
    {
      status: "withdrawn",
      status_reason: "Removed from Workable (no longer exists at source)",
    },
    actor,
  );
}
