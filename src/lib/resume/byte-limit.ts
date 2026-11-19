/**
 * Byte budgets for résumé ingest. Applicant files come from a public posting,
 * so every stage (download, unzip, PDF stream decode, OCR raster) is held to a
 * fixed ceiling and refuses with ResumeByteLimitError instead of buffering or
 * expanding without bound.
 */
export const RESUME_BYTE_LIMIT = 5_000_000;

/** Ceiling for one OCR page pixmap. A US Letter page at scale 3 in RGB is ~13MB. */
export const RASTER_BYTE_LIMIT = 32 * 1024 * 1024;

/** Ceiling for one decoded image the OCR renderer may have to materialise. */
export const IMAGE_BYTE_LIMIT = 64 * 1024 * 1024;

export class ResumeByteLimitError extends Error {
  constructor(detail: string) {
    super(`Resume byte limit exceeded: ${detail}`);
    this.name = "ResumeByteLimitError";
  }
}
