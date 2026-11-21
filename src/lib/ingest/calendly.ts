import { createHmac, timingSafeEqual } from "crypto";

/** Calendly invitee payloads are a few KB; anything far beyond that is not a booking. */
export const MAX_CALENDLY_BODY_BYTES = 16 * 1024;

/** Calendly's recommended replay window for `Calendly-Webhook-Signature`. */
export const CALENDLY_SIGNATURE_TOLERANCE_SECONDS = 180;

/** Calendly event rows are an audit trail only; nothing consumes them after this. */
export const CALENDLY_EVENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const MAX_FIELD_CHARS = 256;
const MAX_EMAIL_CHARS = 320;

export interface CalendlySignature {
  timestamp: number;
  v1: string;
}

/** Parses `t=<unix seconds>,v1=<hex>`; returns null when either part is missing or malformed. */
export function parseCalendlySignature(header: string | null): CalendlySignature | null {
  if (!header) return null;
  let timestamp: number | null = null;
  let v1: string | null = null;
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2).map((piece) => piece?.trim());
    if (key === "t" && value && /^\d+$/.test(value)) timestamp = Number(value);
    if (key === "v1" && value && /^[0-9a-f]{64}$/i.test(value)) v1 = value.toLowerCase();
  }
  if (timestamp === null || v1 === null) return null;
  return { timestamp, v1 };
}

export function isFreshCalendlySignature(signature: CalendlySignature, nowMs = Date.now()): boolean {
  const ageSeconds = Math.abs(nowMs / 1000 - signature.timestamp);
  return ageSeconds <= CALENDLY_SIGNATURE_TOLERANCE_SECONDS;
}

/** v1 is HMAC-SHA256 of `${t}.${rawBody}` with the webhook signing key. */
export function verifyCalendlySignature(
  rawBody: string,
  signature: CalendlySignature,
  signingKey: string,
): boolean {
  const expected = createHmac("sha256", signingKey)
    .update(`${signature.timestamp}.${rawBody}`)
    .digest();
  const provided = Buffer.from(signature.v1, "hex");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/** The booking fields the hiring record keeps; everything else in the webhook is dropped. */
export interface CalendlyBooking {
  event: string | null;
  email: string;
  name: string | null;
  status: string | null;
  invitee_uri: string | null;
  scheduled_event_uri: string | null;
  start_time: string | null;
  end_time: string | null;
}

function field(value: unknown, max = MAX_FIELD_CHARS): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Returns the booking, or null when the body names no usable invitee email. */
export function extractCalendlyBooking(body: unknown): CalendlyBooking | null {
  const root = asRecord(body);
  if (!root) return null;
  const invitee = asRecord(root.payload) ?? asRecord(root.invitee);
  if (!invitee) return null;

  const email = typeof invitee.email === "string" ? invitee.email.trim() : "";
  if (!email || email.length > MAX_EMAIL_CHARS || !email.includes("@")) return null;

  const scheduled = asRecord(invitee.scheduled_event);
  return {
    event: field(root.event),
    email,
    name: field(invitee.name),
    status: field(invitee.status),
    invitee_uri: field(invitee.uri),
    scheduled_event_uri: field(scheduled?.uri),
    start_time: field(scheduled?.start_time),
    end_time: field(scheduled?.end_time),
  };
}
