import "server-only";
import { auth, currentUser } from "@clerk/nextjs/server";
import { env } from "@/lib/env";
import { reviewerKindFrom } from "@/lib/triage/reviewer";
import type { ReviewerKind } from "@/lib/triage/types";

export const HIRING_TEAM_ONLY_MESSAGE =
  "Not allowed: Claude-backed review actions are limited to the hiring team.";

export interface HiringTeamMember {
  userId: string;
  label?: string;
  kind: ReviewerKind;
}

function csv(value: string | undefined, lowercase: boolean): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => (lowercase ? item.trim().toLowerCase() : item.trim()))
    .filter(Boolean);
}

/**
 * Resolve the signed-in Clerk user and require them to be on the hiring team.
 * Sign-up is public, so a Clerk session alone must never be enough to spend on
 * Claude. Identity comes only from Clerk — never from client input.
 */
export async function requireHiringTeam(): Promise<HiringTeamMember> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");
  const user = await currentUser();
  if (!user || user.id !== userId) throw new Error("Unauthorized");

  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  const primary =
    user.primaryEmailAddress ?? user.emailAddresses?.find((item) => item.id === user.primaryEmailAddressId) ?? user.emailAddresses?.[0];
  const email = primary?.emailAddress;
  const label = name || (email ? email.split("@")[0] : undefined);
  const nameKind = reviewerKindFrom(name);
  const kind = nameKind !== "other" ? nameKind : reviewerKindFrom(email);

  const allowedIds = csv(env.HIRING_TEAM_USER_IDS, false);
  const allowedEmails = csv(env.HIRING_TEAM_EMAILS, true);
  let allowed: boolean;
  if (allowedIds.length || allowedEmails.length) {
    const verifiedEmails = (user.emailAddresses ?? [])
      .filter((item) => item.verification?.status === "verified")
      .map((item) => item.emailAddress.toLowerCase());
    allowed = allowedIds.includes(user.id) || verifiedEmails.some((item) => allowedEmails.includes(item));
  } else {
    allowed = kind !== "other";
  }

  if (!allowed) throw new Error(HIRING_TEAM_ONLY_MESSAGE);
  return { userId: user.id, label, kind };
}
