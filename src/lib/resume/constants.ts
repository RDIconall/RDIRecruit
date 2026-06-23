/**
 * Minimum extracted-text length that counts as a genuinely parsed résumé.
 * Centralized so the résumé extractor (OCR-fallback trigger) and the grading
 * readiness gate agree on what "has a parsed résumé" means.
 */
export const MIN_RESUME_TEXT = 60;
