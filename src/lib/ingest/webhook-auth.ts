import { createHmac, timingSafeEqual } from "crypto";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function firstHeader(headers: Headers, names: string[]): string | null {
  for (const name of names) {
    const value = headers.get(name);
    if (value) return value;
  }
  return null;
}

/**
 * True only when a secret is configured and the request proves it, either with
 * the raw secret in one of `sharedHeaders` or with an HMAC-SHA256 hex digest of
 * the exact raw body (optionally prefixed `sha256=`) in one of `signatureHeaders`.
 * An unset secret refuses every request: these endpoints write candidate evidence.
 */
export function provesWebhookSecret(
  rawBody: string,
  headers: Headers,
  secret: string | undefined,
  options: { sharedHeaders: string[]; signatureHeaders: string[] },
): boolean {
  if (!secret) return false;

  const shared = firstHeader(headers, options.sharedHeaders);
  if (shared && safeEqual(shared, secret)) return true;

  const signature = firstHeader(headers, options.signatureHeaders);
  if (signature) {
    const provided = signature.trim().replace(/^sha256=/i, "").toLowerCase();
    const digest = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
    if (safeEqual(provided, digest)) return true;
  }

  return false;
}
