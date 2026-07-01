import { env } from "@/lib/env";

/** Parsed allowlist from APP_ALLOWED_EMAILS. Empty = any authenticated Clerk user. */
export function allowedEmails(): string[] {
  return (env.APP_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((address) => address.trim().toLowerCase())
    .filter(Boolean);
}

export function hasEmailAllowlist(): boolean {
  return allowedEmails().length > 0;
}

export function isEmailAllowed(email: string | null | undefined): boolean {
  const allowlist = allowedEmails();
  if (!allowlist.length) return true;
  const normalized = email?.trim().toLowerCase();
  return Boolean(normalized && allowlist.includes(normalized));
}
