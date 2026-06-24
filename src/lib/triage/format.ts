// Presentation-layer normalizers for the pool board. These tame the messy,
// free-text source values (full mailing addresses, salary asks with notes) into
// the tight, consistent forms the data grid columns expect. Pure + deterministic
// so they're safe to use in the Supabase mapper and in UI cells alike.

const US_STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};
const STATE_CODES = new Set(Object.values(US_STATES));
const COUNTRY_NOISE = new Set(["usa", "us", "u.s.", "u.s.a.", "united states", "united states of america"]);
const STREET_RE = /\d|\b(st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|way|apt|suite|ste|unit|hwy|highway|ct|court|pl|place|pkwy|parkway|fl|floor)\b/i;

/** Resolve a location part to a 2-letter state code, or null if it isn't a state. */
function toStateCode(part: string): string | null {
  const p = part.trim().toLowerCase().replace(/\.$/, "");
  if (US_STATES[p]) return US_STATES[p];
  // "CA" or "CA 95123" → strip a trailing ZIP and test the code.
  const code = p.replace(/\s+\d{5}(-\d{4})?$/, "").toUpperCase();
  if (code.length === 2 && STATE_CODES.has(code)) return code;
  return null;
}

/**
 * Standardize a free-text location / mailing address to "City, ST". Falls back to
 * the state name when no city is recoverable, then to a cleaned single token, then
 * to a dash. Examples:
 *   "400 Hacker Blvd Apt 5, San Jose, CA 95123" → "San Jose, CA"
 *   "Pasadena, California, USA"                  → "Pasadena, CA"
 *   "California"                                 → "California"
 *   "Remote"                                     → "Remote"
 */
export function cityState(raw: string | null | undefined): string {
  if (!raw) return "—";
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned === "—") return "—";

  const parts = cleaned
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p && !COUNTRY_NOISE.has(p.toLowerCase()));
  if (parts.length === 0) return "—";

  // Find the state token (search from the right — state sits late in an address).
  let stateIdx = -1;
  let stateCode: string | null = null;
  for (let i = parts.length - 1; i >= 0; i--) {
    const code = toStateCode(parts[i]);
    if (code) {
      stateIdx = i;
      stateCode = code;
      break;
    }
  }

  if (stateCode && stateIdx >= 0) {
    // City is the part just before the state, unless that part is a street line.
    for (let i = stateIdx - 1; i >= 0; i--) {
      if (!STREET_RE.test(parts[i])) return `${parts[i]}, ${stateCode}`;
    }
    // No usable city → show the full state name for readability.
    const full = Object.keys(US_STATES).find((k) => US_STATES[k] === stateCode);
    return full ? full.replace(/\b\w/g, (c) => c.toUpperCase()) : stateCode;
  }

  // No state found: return the first non-street token (e.g. "Remote", "London").
  const city = parts.find((p) => !STREET_RE.test(p));
  return city ?? parts[parts.length - 1];
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
