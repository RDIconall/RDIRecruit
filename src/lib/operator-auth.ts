import { createHash, timingSafeEqual } from "crypto";
import { env } from "./env";

/**
 * True only when the request carries `Authorization: Bearer <CRON_SECRET>`.
 * Fails closed: with CRON_SECRET unset no request is an operator request, so
 * operational endpoints never run on an unconfigured deployment.
 */
export function isOperatorRequest(request: Request): boolean {
  const secret = env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization");
  if (!header) return false;
  // Hash both sides so the comparison is constant-time regardless of length.
  const presented = createHash("sha256").update(header).digest();
  const expected = createHash("sha256").update(`Bearer ${secret}`).digest();
  return timingSafeEqual(presented, expected);
}
