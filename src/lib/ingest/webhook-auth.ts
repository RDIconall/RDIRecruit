import { createHmac, timingSafeEqual } from "crypto";

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function firstHeader(headers: Headers, names: readonly string[]): string | null {
  for (const name of names) {
    const value = headers.get(name);
    if (value) return value;
  }
  return null;
}

/**
 * Fail-closed check for public ingest webhooks. A missing or blank secret means
 * the endpoint is not configured, so every request is refused. Otherwise the
 * request must carry the secret itself in one of `sharedSecretHeaders`, or an
 * HMAC-SHA256 hex digest of the exact raw body in one of `signatureHeaders`
 * (optionally prefixed with `sha256=`). Callers must parse `rawBody` — the same
 * bytes that were verified — and do no work before this returns true.
 */
export function verifyWebhookSecret(input: {
  secret: string | undefined;
  rawBody: string;
  headers: Headers;
  sharedSecretHeaders: readonly string[];
  signatureHeaders: readonly string[];
}): boolean {
  const secret = input.secret?.trim();
  if (!secret) return false;

  const shared = firstHeader(input.headers, input.sharedSecretHeaders);
  if (shared && safeEqual(shared, secret)) return true;

  const signature = firstHeader(input.headers, input.signatureHeaders);
  if (signature) {
    const provided = signature.trim().replace(/^sha256=/i, "").toLowerCase();
    const digest = createHmac("sha256", secret).update(input.rawBody, "utf8").digest("hex");
    if (safeEqual(provided, digest)) return true;
  }

  return false;
}
