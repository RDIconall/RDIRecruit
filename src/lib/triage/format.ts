// Presentation-layer normalizers for the pool board. These tame the messy,
// free-text source values (full mailing addresses, salary asks with notes) into
// the tight, consistent forms the data grid columns expect. Pure + deterministic
// so they're safe to use in the Supabase mapper and in UI cells alike.

import { shortLocation } from "./location";

/**
 * Standardize a free-text location / mailing address to "City, ST" when it is a
 * confirmed US address; see `shortLocation`. `structured` is Workable's parsed
 * location for the same address, when known.
 */
export function cityState(raw: string | null | undefined, structured?: unknown): string {
  return shortLocation(raw, structured);
}

/** Parse a salary token like "$145,000", "145k", "145" into thousands (→ 145). */
function tokenToK(token: string): number | null {
  const hasK = /k/i.test(token);
  const digits = token.replace(/[^0-9.]/g, "");
  if (!digits) return null;
  const n = parseFloat(digits);
  if (!Number.isFinite(n)) return null;
  if (hasK) return Math.round(n);
  if (n >= 1000) return Math.round(n / 1000);
  return Math.round(n);
}

const MONEY_TOKEN = "\\$?\\s*[\\d,]+(?:\\.\\d+)?\\s*[kK]?";
const RANGE_RE = new RegExp(`(${MONEY_TOKEN})\\s*(?:-|–|—|to)\\s*(${MONEY_TOKEN})`, "i");
const SINGLE_RE = new RegExp(`\\$?\\s*[\\d,]+(?:\\.\\d+)?\\s*[kK]?`, "g");

/** True for a bare 4-digit year-looking number (no $ / k) — keeps "2019" out of salaries. */
function looksLikeYear(token: string): boolean {
  return /^\s*(19|20)\d{2}\s*$/.test(token) && !/[$k]/i.test(token);
}

/**
 * Clean a free-text salary ask into a tight column form, dropping parenthetical
 * notes and trailing prose, and preferring an explicit range:
 *   "$145,000-$160,000"                       → "$145–160k"
 *   "$112k (excluding $110-130k start range)" → "$112k"
 *   "110-140k negotiable"                      → "$110–140k"
 *   "$130K"                                    → "$130k"
 * Falls back to a dash when nothing parseable remains.
 */
export function formatAsk(raw: string | null | undefined): string {
  if (!raw) return "—";
  if (/\b[mb]illion\b/i.test(raw)) return raw.trim();
  // Drop parenthetical asides ("(excluding ...)") — they carry stray numbers.
  const cleaned = raw.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned === "—") return "—";

  const range = cleaned.match(RANGE_RE);
  if (range) {
    const a = tokenToK(range[1]);
    const b = tokenToK(range[2]);
    if (a != null && b != null) return `$${a}–${b}k`;
  }

  const tokens = cleaned.match(SINGLE_RE) ?? [];
  for (const t of tokens) {
    if (looksLikeYear(t)) continue;
    const k = tokenToK(t);
    if (k != null && k > 0) return `$${k}k`;
  }
  return "—";
}

/**
 * Sortable numeric ask in thousands, parsed with the same range/token rules as
 * formatAsk (a range sorts by its low end): "$145,000-$160,000" → 145,
 * "$130K" → 130, unparseable/unstated → 0.
 */
export function askNumK(raw: string | null | undefined): number {
  if (!raw) return 0;
  const cleaned = raw.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned === "—") return 0;

  const range = cleaned.match(RANGE_RE);
  if (range) {
    const a = tokenToK(range[1]);
    const b = tokenToK(range[2]);
    if (a != null && b != null) return Math.min(a, b);
  }

  const tokens = cleaned.match(SINGLE_RE) ?? [];
  for (const t of tokens) {
    if (looksLikeYear(t)) continue;
    const k = tokenToK(t);
    if (k != null && k > 0) return k;
  }
  return 0;
}
