import "server-only";
import { auth, currentUser } from "@clerk/nextjs/server";

/**
 * A Clerk session alone is not enough to touch applicant data: anyone who can
 * complete sign-up gets one. Every hiring read and write must pass this check,
 * which requires the session's own verified primary email to be on
 * HIRING_ADMIN_EMAILS. An unset or empty allowlist admits nobody.
 */

export class HiringAccessError extends Error {
  readonly status: 401 | 403;

  constructor(status: 401 | 403) {
    super(status === 401 ? "Unauthorized" : "Forbidden: not on the hiring-admin allowlist");
    this.name = "HiringAccessError";
    this.status = status;
  }
}

export interface HiringAdmin {
  userId: string;
  email: string;
}

function hiringAdminEmails(): Set<string> {
  return new Set(
    (process.env.HIRING_ADMIN_EMAILS ?? "")
      .split(",")
      .map((address) => address.trim().toLowerCase())
      .filter(Boolean),
  );
}

export async function requireHiringAdmin(): Promise<HiringAdmin> {
  const { userId } = await auth();
  if (!userId) throw new HiringAccessError(401);

  const allowed = hiringAdminEmails();
  if (allowed.size === 0) throw new HiringAccessError(403);

  let user: Awaited<ReturnType<typeof currentUser>>;
  try {
    user = await currentUser();
  } catch {
    throw new HiringAccessError(403);
  }
  // currentUser() resolves the session again; refuse if it is not the user auth() saw.
  if (!user || user.id !== userId) throw new HiringAccessError(403);

  const addresses = user.emailAddresses ?? [];
  const primary = user.primaryEmailAddressId
    ? addresses.find((address) => address.id === user.primaryEmailAddressId)
    : undefined;
  if (!primary) throw new HiringAccessError(403);
  if (primary.verification && primary.verification.status !== "verified") {
    throw new HiringAccessError(403);
  }

  const email = primary.emailAddress?.trim().toLowerCase();
  if (!email || !allowed.has(email)) throw new HiringAccessError(403);
  return { userId, email };
}

/** For route handlers and pages: the admin, or the status to refuse with. */
export async function checkHiringAdmin(): Promise<
  { ok: true; admin: HiringAdmin } | { ok: false; status: 401 | 403; error: string }
> {
  try {
    return { ok: true, admin: await requireHiringAdmin() };
  } catch (error) {
    if (error instanceof HiringAccessError) {
      return { ok: false, status: error.status, error: error.message };
    }
    throw error;
  }
}
