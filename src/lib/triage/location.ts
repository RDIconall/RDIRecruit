// Places a candidate's free-text address (copied verbatim from Workable, so it is
// whatever the applicant typed) as US / foreign / unconfirmed. A US state is only
// accepted when the address actually supports it: a 2-letter token that is also an
// ISO country code ("CA" Canada, "DE" Germany, "IN" India …) is never read as a
// state on its own, and a state name only counts as the whole region segment
// ("Baja California" is not California). Workable's parsed `location` object, when
// it belongs to the same address, outranks the text.

export const US_STATES: Record<string, string> = {
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

const US_MARKERS = new Set(["usa", "us", "u.s.", "u.s", "u.s.a.", "u.s.a", "united states", "united states of america"]);
const US_TERRITORIES = new Set(["pr", "gu", "vi", "as", "mp", "puerto rico", "guam", "u.s. virgin islands", "us virgin islands", "american samoa", "northern mariana islands"]);

const ISO_COUNTRY_CODES = new Set(
  (
    "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
    "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
    "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
    "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT " +
    "MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW " +
    "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG " +
    "UM UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW UK"
  ).split(" "),
);
/** US state names that are also country names, so they need the same confirmation as a shared code. */
const AMBIGUOUS_STATE_NAMES = new Set(["georgia"]);

const CANADIAN_PROVINCES = new Set([
  "ab", "bc", "mb", "nb", "nl", "ns", "nt", "nu", "on", "pe", "qc", "sk", "yt",
  "alberta", "british columbia", "manitoba", "new brunswick", "newfoundland and labrador",
  "newfoundland", "nova scotia", "northwest territories", "nunavut", "ontario",
  "prince edward island", "quebec", "québec", "saskatchewan", "yukon",
]);
const COUNTRY_NAMES = new Set([
  "canada", "mexico", "méxico", "united kingdom", "england", "scotland", "wales", "northern ireland",
  "ireland", "germany", "deutschland", "france", "spain", "españa", "italy", "portugal", "netherlands",
  "belgium", "switzerland", "austria", "sweden", "norway", "denmark", "finland", "poland", "greece",
  "turkey", "israel", "india", "pakistan", "bangladesh", "philippines", "china", "japan", "south korea",
  "korea", "taiwan", "singapore", "malaysia", "indonesia", "vietnam", "thailand", "australia",
  "new zealand", "brazil", "argentina", "colombia", "chile", "peru", "venezuela", "south africa",
  "nigeria", "kenya", "egypt", "uae", "united arab emirates", "saudi arabia", "ukraine", "russia",
]);

const STREET_RE = /\d|\b(st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|way|apt|suite|ste|unit|hwy|highway|ct|court|pl|place|pkwy|parkway|fl|floor)\b/i;
const ZIP_RE = /^\d{5}(?:-\d{4})?$/;
const TRAILING_ZIP_RE = /^(.*?)\s+(\d{5}(?:-\d{4})?)$/;

export type Placement =
  | { kind: "none" }
  | { kind: "us"; state: string | null }
  | { kind: "foreign" }
  | { kind: "unconfirmed" };

/** The parsed `location` object Workable returns alongside `address` on a candidate. */
export interface StructuredLocation {
  country?: string;
  country_code?: string;
  region?: string;
  region_code?: string;
  city?: string;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\.$/, "").trim();
const isUsMarker = (s: string) => US_MARKERS.has(s.trim().toLowerCase()) || US_MARKERS.has(norm(s));

function isCaliforniaZip(zip: string): boolean {
  const prefix = Number(zip.slice(0, 3));
  return prefix >= 900 && prefix <= 961;
}

function splitParts(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Resolve a segment to a state code, ignoring whether it is ambiguous. */
function stateCodeOf(part: string): string | null {
  const key = norm(part.replace(/\s+\d{5}(?:-\d{4})?$/, ""));
  if (US_STATES[key]) return US_STATES[key];
  const code = key.toUpperCase();
  return code.length === 2 && STATE_CODES.has(code) ? code : null;
}

function isCountryToken(part: string): boolean {
  const key = norm(part);
  return isUsMarker(part) || COUNTRY_NAMES.has(key) || (key.length === 2 && ISO_COUNTRY_CODES.has(key.toUpperCase()));
}

function placeText(text: string, usConfirmed: boolean): Placement {
  const parts = splitParts(text);
  if (parts.length === 0 || (parts.length === 1 && parts[0] === "—")) return { kind: "none" };

  let i = parts.length - 1;
  let zip: string | null = null;
  let usMarker = usConfirmed;
  if (ZIP_RE.test(parts[i])) zip = parts[i--];
  if (i >= 0 && isUsMarker(parts[i])) {
    usMarker = true;
    i--;
  }
  if (i < 0) return usMarker ? { kind: "us", state: null } : { kind: "unconfirmed" };

  let region = parts[i];
  const zipMatch = region.match(TRAILING_ZIP_RE);
  if (zipMatch) {
    region = zipMatch[1];
    zip = zipMatch[2];
  }
  const key = norm(region);
  const isName = Boolean(US_STATES[key]);
  const code = stateCodeOf(region);

  if (code) {
    const ambiguous = isName ? AMBIGUOUS_STATE_NAMES.has(key) : ISO_COUNTRY_CODES.has(code);
    if (!ambiguous || usMarker || (code === "CA" && zip && isCaliforniaZip(zip))) return { kind: "us", state: code };
    if (i >= 2 && CANADIAN_PROVINCES.has(norm(parts[i - 1]))) return { kind: "foreign" };
    return { kind: "unconfirmed" };
  }
  if (US_TERRITORIES.has(key) || usMarker) return { kind: "us", state: null };
  if (CANADIAN_PROVINCES.has(key) || isCountryToken(region)) return { kind: "foreign" };
  return { kind: "unconfirmed" };
}

function readStructured(value: unknown): StructuredLocation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const str = (k: string) => (typeof v[k] === "string" && (v[k] as string).trim() ? (v[k] as string).trim() : undefined);
  const out: StructuredLocation = {
    country: str("country"),
    country_code: str("country_code"),
    region: str("region"),
    region_code: str("region_code"),
    city: str("city"),
  };
  return out.country_code || out.country ? out : null;
}

function structuredIsUs(loc: StructuredLocation): boolean {
  if (loc.country_code) return loc.country_code.toUpperCase() === "US";
  return isUsMarker(loc.country ?? "");
}

function structuredState(loc: StructuredLocation): string | null {
  const code = loc.region_code?.toUpperCase();
  if (code && STATE_CODES.has(code)) return code;
  return loc.region ? US_STATES[norm(loc.region)] ?? null : null;
}

/**
 * Place an address. `structured` is Workable's parsed location for the same
 * candidate payload; pass it only when it was returned with this exact address.
 */
export function placeLocation(text: string | null | undefined, structured?: unknown): Placement {
  const t = (text ?? "").trim();
  if (!t || t === "—") return { kind: "none" };
  const loc = readStructured(structured);
  if (loc) {
    if (!structuredIsUs(loc)) return { kind: "foreign" };
    const state = structuredState(loc);
    if (state) return { kind: "us", state };
    const fromText = placeText(t, true);
    return fromText.kind === "us" ? fromText : { kind: "us", state: null };
  }
  return placeText(t, false);
}

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Standardize an address to a short label. A confirmed US address becomes
 * "City, ST"; anything else keeps its own wording so a country code is never
 * rewritten into a state abbreviation. Examples:
 *   "400 Hacker Blvd Apt 5, San Jose, CA 95123" → "San Jose, CA"
 *   "Pasadena, California, USA"                  → "Pasadena, CA"
 *   "California"                                 → "California"
 *   "London, Ontario, CA"                        → "London, Ontario"
 *   "Berlin, de"                                 → "Berlin, de"
 */
export function shortLocation(raw: string | null | undefined, structured?: unknown): string {
  if (!raw) return "—";
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned === "—") return "—";
  const placement = placeLocation(cleaned, structured);
  const all = splitParts(cleaned).filter((p) => !ZIP_RE.test(p));
  const loc = readStructured(structured);

  if (placement.kind === "us") {
    const parts = all.filter((p) => !isUsMarker(p));
    if (parts.length === 0) return cleaned;
    if (placement.state) {
      for (let s = parts.length - 1; s >= 0; s--) {
        if (stateCodeOf(parts[s]) !== placement.state) continue;
        for (let c = s - 1; c >= 0; c--) {
          if (!STREET_RE.test(parts[c])) return `${parts[c]}, ${placement.state}`;
        }
        break;
      }
      if (loc?.city) return `${loc.city}, ${placement.state}`;
      const full = Object.keys(US_STATES).find((k) => US_STATES[k] === placement.state);
      return full ? titleCase(full) : placement.state;
    }
    return parts.find((p) => !STREET_RE.test(p)) ?? parts[parts.length - 1];
  }

  if (placement.kind === "foreign" && loc?.city && (loc.region || loc.country)) {
    return `${loc.city}, ${loc.region ?? loc.country}`;
  }
  if (all.length === 0) return cleaned;
  let parts = all.map((p) => p.replace(TRAILING_ZIP_RE, "$1")).filter((p) => !STREET_RE.test(p));
  if (parts.length === 0) return all[all.length - 1];
  if (placement.kind === "foreign" && parts.length > 2 && isCountryToken(parts[parts.length - 1])) {
    parts = parts.slice(0, -1);
  }
  return parts.slice(-2).join(", ");
}
