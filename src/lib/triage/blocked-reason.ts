import { READINESS_INPUT_LABELS } from "./app-theme";
import type { CandidateReadiness } from "./types";

export interface BlockedReason {
  /** Short sub-line for the pool row. */
  short: string;
  /** Full sentence for the tooltip / dossier. */
  title: string;
  /** What actually clears it: pull materials again, or run the analysis. */
  fix: "resync" | "analyze";
}

/**
 * Why a file reads "Review blocked", in the language of the thing that fixes it.
 *
 * There are two genuinely different states and the UI used to show a reason for
 * only one of them:
 *  - materials are missing → re-sync from Workable
 *  - materials are all present but nothing has been graded → run the analysis
 *
 * The second case previously rendered with no explanation at all, which read as
 * "the app is broken" when the real answer was "this file was never scored".
 */
export function blockedReason(readiness: CandidateReadiness | undefined): BlockedReason {
  if (readiness && !readiness.ready) {
    if (readiness.resumeMissingFromSource) {
      return {
        short: "no résumé on file",
        title: "Review blocked — no résumé on file in Workable, nothing to grade",
        fix: "resync",
      };
    }
    const missing = readiness.missing.map((m) => READINESS_INPUT_LABELS[m]).join(", ");
    return {
      short: `waiting on ${missing}`,
      title: `Review blocked — waiting on ${missing}`,
      fix: "resync",
    };
  }

  return {
    short: "waiting on analysis",
    title: "Review blocked — materials are on file but no analysis has run yet",
    fix: "analyze",
  };
}
