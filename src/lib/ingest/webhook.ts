import { createHmac, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";

/**
 * Longest transcript (in characters, after sentence arrays are joined) an ingest
 * webhook will store as evidence. Roughly a two-hour meeting.
 */
export const MAX_TRANSCRIPT_CHARS = 100_000;

/**
 * Largest raw webhook body read into memory. Leaves room for a transcript at
 * MAX_TRANSCRIPT_CHARS after JSON escaping and multi-byte characters, plus the
 * rest of the payload.
 */
export const MAX_WEBHOOK_BODY_BYTES = 1_000_000;

/**
 * Read the request body as text, refusing anything over `maxBytes`. Returns null
 * when the body is too large; the stream is cancelled at the limit, so an
 * oversized body is never fully buffered.
 */
export async function readBodyCapped(
  request: Request,
  maxBytes: number = MAX_WEBHOOK_BODY_BYTES,
): Promise<string | null> {
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
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Parse a webhook body that must be a JSON object. Returns null otherwise. */
export function parseJsonObject(rawBody: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * True when `signature` is the hex HMAC-SHA256 of `rawBody` keyed with `secret`.
 * Accepts an optional `sha256=` prefix. An empty secret never verifies.
 */
export function verifyHmacSha256(
  rawBody: string,
  signature: string | null | undefined,
  secret: string | null | undefined,
): boolean {
  if (!secret || !signature) return false;
  const provided = signature.trim().replace(/^sha256=/i, "").toLowerCase();
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqual(provided, expected);
}

export function payloadTooLarge(error = "payload_too_large") {
  return NextResponse.json(
    { ok: false, error, maxTranscriptChars: MAX_TRANSCRIPT_CHARS },
    { status: 413 },
  );
}
