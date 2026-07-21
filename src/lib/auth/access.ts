import { env, hasSupabase } from "@/lib/env";

/** Parsed allowlist from APP_ALLOWED_EMAILS. Empty = any authenticated Clerk user. */
export function allowedEmails(): string[] {
  return (env.APP_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((address) => address.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether allowlist enforcement is on. Enforcement is keyed off the env var only
 * (never off app_users rows) so an in-app invite can never lock out the person
 * who sent it in an env with no allowlist configured.
 */
export function hasEmailAllowlist(): boolean {
  return allowedEmails().length > 0;
}

// Per-instance cache of app_users lookups so the middleware doesn't hit
// Supabase on every request. Invites prime it via grantAccessInCache().
const accessCache = new Map<string, { allowed: boolean; at: number }>();
const ACCESS_CACHE_TTL_MS = 30_000;

/** Prime the cache after an invite so access is immediate on this instance. */
export function grantAccessInCache(email: string): void {
  accessCache.set(email.trim().toLowerCase(), { allowed: true, at: Date.now() });
}

async function isInvitedInDb(email: string): Promise<boolean> {
  if (!hasSupabase()) return false;
  try {
    const { getServiceSupabase } = await import("@/lib/supabase/server");
    const supabase = getServiceSupabase();
    const { data } = await supabase.from("app_users").select("email").eq("email", email).maybeSingle();
    return Boolean(data);
  } catch (error) {
    console.error("app_users lookup failed", error);
    return false;
  }
}

/**
 * Whether this email may use the app: no allowlist configured → yes; otherwise
 * the email must be in APP_ALLOWED_EMAILS or invited in-app (app_users table).
 */
export async function isEmailAllowed(email: string | null | undefined): Promise<boolean> {
  if (!hasEmailAllowlist()) return true;
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return false;
  if (allowedEmails().includes(normalized)) return true;

  const cached = accessCache.get(normalized);
  if (cached && Date.now() - cached.at < ACCESS_CACHE_TTL_MS) return cached.allowed;

  const allowed = await isInvitedInDb(normalized);
  accessCache.set(normalized, { allowed, at: Date.now() });
  return allowed;
}
