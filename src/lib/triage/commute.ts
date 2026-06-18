import "server-only";
import { env, hasGeoapify } from "../env";

// Real door-to-door driving-time lookup for the candidate commute read, via
// Geoapify (free tier: 3,000 credits/day, no credit card). Geocodes the
// candidate's home location and RDI's office, then asks the routing API for the
// driving time + distance. Fully resilient: every failure path returns null so
// the caller can fall back to Claude's geographic estimate and never break the
// page or the assessment. The office address is read once from env so it lives
// in a single configurable place.

const GEOCODE_URL = "https://api.geoapify.com/v1/geocode/search";
const ROUTING_URL = "https://api.geoapify.com/v1/routing";
const TIMEOUT_MS = 8000;

export interface CommuteResult {
  minutes: number;
  miles: number;
  homeLabel: string;
  officeLabel: string;
  /** Ready-to-display sentence stored on the assessment / .md working file. */
  text: string;
}

interface GeoPoint {
  lat: number;
  lon: number;
  label: string;
}

async function fetchJson(url: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function geocode(address: string, apiKey: string): Promise<GeoPoint | null> {
  const q = address.trim();
  if (!q) return null;
  const url = `${GEOCODE_URL}?text=${encodeURIComponent(q)}&format=json&limit=1&apiKey=${apiKey}`;
  const data = await fetchJson(url);
  const results = (data as { results?: Array<Record<string, unknown>> } | null)?.results;
  const top = results?.[0];
  if (!top) return null;
  const lat = Number(top.lat);
  const lon = Number(top.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const label = typeof top.formatted === "string" ? top.formatted : q;
  return { lat, lon, label };
}

// Geocoding the fixed office address every call would burn credits, so memoise
// it for the lifetime of the (warm) serverless instance.
let officeCache: GeoPoint | null = null;
async function geocodeOffice(apiKey: string): Promise<GeoPoint | null> {
  if (officeCache) return officeCache;
  const point = await geocode(env.RDI_OFFICE_ADDRESS, apiKey);
  if (point) officeCache = point;
  return point;
}

async function drive(from: GeoPoint, to: GeoPoint, apiKey: string): Promise<{ minutes: number; miles: number } | null> {
  const url =
    `${ROUTING_URL}?waypoints=${from.lat},${from.lon}|${to.lat},${to.lon}` +
    `&mode=drive&units=imperial&format=geojson&apiKey=${apiKey}`;
  const data = await fetchJson(url);
  const props = (data as { features?: Array<{ properties?: Record<string, unknown> }> } | null)?.features?.[0]
    ?.properties;
  if (!props) return null;
  const seconds = Number(props.time);
  const distance = Number(props.distance);
  if (!Number.isFinite(seconds)) return null;
  const units = typeof props.distance_units === "string" ? props.distance_units.toLowerCase() : "miles";
  // imperial → miles; guard in case the API echoes meters.
  const miles = Number.isFinite(distance)
    ? units.startsWith("meter")
      ? distance / 1609.34
      : distance
    : 0;
  return { minutes: Math.round(seconds / 60), miles: Math.round(miles * 10) / 10 };
}

function shorten(label: string): string {
  // "Calabasas, Los Angeles County, California, United States of America"
  //   → "Calabasas, California"
  const parts = label.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 2) return label;
  return [parts[0], parts[parts.length - 2]].filter(Boolean).join(", ");
}

/**
 * Compute a real driving commute from the candidate's home to the RDI office.
 * Returns null when Geoapify is not configured, the location is missing, or any
 * call fails — the caller then falls back to Claude's estimate.
 */
export async function computeCommute(homeAddress: string | null | undefined): Promise<CommuteResult | null> {
  if (!hasGeoapify()) return null;
  const home = (homeAddress ?? "").trim();
  if (!home || home === "—") return null;
  const apiKey = env.GEOAPIFY_API_KEY as string;

  const [from, office] = await Promise.all([geocode(home, apiKey), geocodeOffice(apiKey)]);
  if (!from || !office) return null;

  const route = await drive(from, office, apiKey);
  if (!route) return null;

  const homeLabel = shorten(from.label);
  const officeLabel = shorten(office.label);
  const milePart = route.miles > 0 ? ` (${route.miles} mi)` : "";
  const text = `${homeLabel} is about a ${route.minutes}-minute drive${milePart} from RDI's office in ${officeLabel}, in typical traffic.`;

  return { minutes: route.minutes, miles: route.miles, homeLabel, officeLabel, text };
}
