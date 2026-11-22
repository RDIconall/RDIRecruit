/**
 * Size limits for human-entered text stored on a candidate. Every stored entry
 * ends up in the pool load or the dossier, so writers reject oversized text and
 * keep only the most recent entries.
 */
export const MAX_TEXT_CHARS = 4000;
export const MAX_SHORT_TEXT_CHARS = 500;
export const MAX_STORED_ENTRIES = 24;
export const MAX_REPLY_KEY_CHARS = 200;

export function exceeds(value: unknown, max: number): boolean {
  return typeof value !== "string" || value.length > max;
}

export function keepRecent<T>(entries: T[], max = MAX_STORED_ENTRIES): T[] {
  return entries.length > max ? entries.slice(-max) : entries;
}

export const TOO_LONG_MESSAGE = `Too long — keep it under ${MAX_TEXT_CHARS.toLocaleString("en-US")} characters.`;
