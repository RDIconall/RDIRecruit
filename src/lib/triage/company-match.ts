/**
 * Employer-name matching for attaching role write-ups, résumé bullets, and
 * periods to a career row. Employer names are applicant-supplied, so a match
 * must never rest on a character fragment: two names match only when their
 * normalized forms are equal, or when one is a contiguous run of whole tokens
 * inside the other.
 */

// Words that say what kind of entity a company is rather than which one. A name
// made only of these ("Inc", "The Group") cannot claim a longer name's record.
const GENERIC_COMPANY_TOKENS = new Set([
  "the", "and", "of", "a", "an",
  "inc", "incorporated", "llc", "llp", "lp", "ltd", "limited", "plc", "corp",
  "corporation", "co", "company", "companies", "group", "holdings", "gmbh", "ag",
  "sa", "srl", "bv", "pty", "pte", "pc", "pllc",
]);

export function normalizeCompanyName(name: string | null | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokens(normalized: string): string[] {
  return normalized ? normalized.split(" ") : [];
}

function containsTokenRun(haystack: string[], needle: string[]): boolean {
  if (!needle.length || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

export type CompanyMatch = "exact" | "contained" | null;

export function companyMatch(a: string | null | undefined, b: string | null | undefined): CompanyMatch {
  const na = normalizeCompanyName(a);
  const nb = normalizeCompanyName(b);
  if (!na || !nb) return null;
  if (na === nb) return "exact";
  const ta = tokens(na);
  const tb = tokens(nb);
  const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (shorter.every((t) => GENERIC_COMPANY_TOKENS.has(t))) return null;
  return containsTokenRun(longer, shorter) ? "contained" : null;
}

/**
 * The single item whose company matches `company`. An exact normalized match
 * wins; otherwise a token-bounded match is used only when exactly one distinct
 * company qualifies. Returns undefined when nothing (or more than one company)
 * matches, so callers leave the field blank rather than borrow another job's.
 */
export function findByCompany<T>(
  company: string | null | undefined,
  items: readonly T[],
  companyOf: (item: T) => string | null | undefined,
): T | undefined {
  const target = normalizeCompanyName(company);
  if (!target) return undefined;

  const exact = items.filter((item) => normalizeCompanyName(companyOf(item)) === target);
  if (exact.length) return exact[0];

  const contained = items.filter((item) => companyMatch(target, companyOf(item)) === "contained");
  const distinct = new Set(contained.map((item) => normalizeCompanyName(companyOf(item))));
  return distinct.size === 1 ? contained[0] : undefined;
}
