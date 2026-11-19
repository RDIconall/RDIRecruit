import "server-only";
import { createHash, timingSafeEqual } from "crypto";
import { env } from "@/lib/env";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Gate for every /api/cron/* handler. Middleware leaves those paths public, so
 * this is their only check. It fails closed: a missing or blank CRON_SECRET
 * refuses every request rather than letting it through.
 */
export function isAuthorizedCronRequest(request: Request): boolean {
  const secret = env.CRON_SECRET;
  if (!secret || !secret.trim()) return false;
  const header = request.headers.get("authorization");
  if (!header) return false;
  // Hashing both sides gives equal-length buffers, so the compare is constant
  // time and does not reveal the secret's length.
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}
