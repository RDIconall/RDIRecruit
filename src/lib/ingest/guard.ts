import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

/**
 * Shared front door for every public route that enqueues into `events`
 * (`/api/ingest/*`, `/api/hooks/*`). Those routes are exempt from Clerk in
 * middleware, so this is their only gate. Fails closed: an unset or empty
 * secret rejects every request.
 */

export const INGEST_MAX_BODY_BYTES = 64 * 1024;
export const INGEST_RATE_LIMIT = 10;
export const INGEST_RATE_WINDOW_MS = 60_000;
const MAX_TRACKED_CLIENTS = 10_000;

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function hmacSha256Hex(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("hex");
}

/** True when `header` carries exactly `secret`. */
export function hasSharedSecretHeader(request: NextRequest, header: string, secret: string): boolean {
  const presented = request.headers.get(header);
  return Boolean(presented) && safeEqual(presented!, secret);
}

/** Reads the raw body, or returns null as soon as it exceeds `maxBytes`. */
export async function readBodyCapped(request: NextRequest, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function clientAddress(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
}

// Per-instance sliding window. Serverless instances each keep their own, so
// this bounds a single credential holder's burst rather than a global quota.
const recentWrites = new Map<string, number[]>();

export function takeRateLimit(route: string, client: string, now = Date.now()): boolean {
  const key = `${route}\u0000${client}`;
  const cutoff = now - INGEST_RATE_WINDOW_MS;
  const hits = (recentWrites.get(key) ?? []).filter((at) => at > cutoff);
  recentWrites.delete(key);
  if (hits.length >= INGEST_RATE_LIMIT) {
    recentWrites.set(key, hits);
    return false;
  }
  hits.push(now);
  recentWrites.set(key, hits);
  while (recentWrites.size > MAX_TRACKED_CLIENTS) {
    const oldest = recentWrites.keys().next().value;
    if (oldest === undefined) break;
    recentWrites.delete(oldest);
  }
  return true;
}

export type IngestGuardResult =
  | { ok: true; rawBody: string; payload: Record<string, unknown> }
  | { ok: false; response: NextResponse };

function reject(status: number, error: string, headers?: Record<string, string>): IngestGuardResult {
  return { ok: false, response: NextResponse.json({ error }, { status, headers }) };
}

export async function guardIngest(
  request: NextRequest,
  options: {
    route: string;
    secret: string | undefined;
    authorize: (rawBody: string, request: NextRequest, secret: string) => boolean;
  },
): Promise<IngestGuardResult> {
  const { route, secret, authorize } = options;
  if (!secret) return reject(401, "Unauthorized");

  const rawBody = await readBodyCapped(request, INGEST_MAX_BODY_BYTES);
  if (rawBody === null) return reject(413, "Payload too large");

  if (!authorize(rawBody, request, secret)) return reject(401, "Unauthorized");

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return reject(400, "Invalid JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return reject(400, "Expected a JSON object");
  }

  if (!takeRateLimit(route, clientAddress(request))) {
    return reject(429, "Too many requests", {
      "retry-after": String(Math.ceil(INGEST_RATE_WINDOW_MS / 1000)),
    });
  }

  return { ok: true, rawBody, payload: payload as Record<string, unknown> };
}
