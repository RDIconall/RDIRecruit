// Location terms arrive from the sourcing planner as a flat list of free-text
// strings ("Los Angeles", "California", "United States", "91406"). Providers
// want them separated: Seamless has distinct country / state / zip filters and
// no city filter at all, so a city sent as a country matches nothing.

const US_STATE_NAMES = [
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut",
  "delaware", "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa",
  "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan",
  "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada",
  "new hampshire", "new jersey", "new mexico", "new york", "north carolina",
  "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania", "rhode island",
  "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont",
  "virginia", "washington", "west virginia", "wisconsin", "wyoming",
  "district of columbia",
];

const US_STATE_CODES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN",
  "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV",
  "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN",
  "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
]);

const COUNTRY_NAMES = new Set([
  "united states", "united states of america", "usa", "us", "canada",
  "united kingdom", "uk", "great britain", "ireland", "germany", "france", "spain",
  "italy", "netherlands", "belgium", "switzerland", "sweden", "norway", "denmark",
  "finland", "poland", "portugal", "austria", "australia", "new zealand", "india",
  "japan", "china", "singapore", "israel", "mexico", "brazil", "argentina",
  "south africa",
]);

const ZIP_RE = /^\d{5}(-\d{4})?$/;

export interface SplitLocations {
  countries: string[];
  states: string[];
  /** Cities have no provider filter on Seamless — kept so callers can report them. */
  cities: string[];
  zips: string[];
}

/**
 * Classify free-text location terms into the buckets providers actually accept.
 * A term that looks like nothing recognisable is treated as a city, because the
 * planner emits city names far more often than any other unclassifiable term.
 */
export function splitLocationTerms(terms: string[]): SplitLocations {
  const out: SplitLocations = { countries: [], states: [], cities: [], zips: [] };

  for (const rawTerm of terms) {
    const term = rawTerm.trim();
    if (!term) continue;

    // "Los Angeles, California, United States" — classify each part separately.
    const parts = term.includes(",")
      ? term.split(",").map((p) => p.trim()).filter(Boolean)
      : [term];

    for (const part of parts) {
      const lower = part.toLowerCase();

      if (ZIP_RE.test(part)) {
        push(out.zips, part);
      } else if (COUNTRY_NAMES.has(lower)) {
        push(out.countries, part);
      } else if (US_STATE_NAMES.includes(lower) || US_STATE_CODES.has(part.toUpperCase())) {
        push(out.states, part);
      } else {
        push(out.cities, part);
      }
    }
  }

  return out;
}

function push(list: string[], value: string): void {
  if (!list.some((existing) => existing.toLowerCase() === value.toLowerCase())) {
    list.push(value);
  }
}
