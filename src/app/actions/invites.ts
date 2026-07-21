"use server";

import { auth, clerkClient, currentUser } from "@clerk/nextjs/server";
import { hasSupabase, publicBaseUrl } from "@/lib/env";
import { getServiceSupabase } from "@/lib/supabase/server";
import { grantAccessInCache } from "@/lib/auth/access";
import { viewerFromClerkUser } from "@/lib/triage/reviewer";

export interface InviteResult {
  ok: boolean;
  message: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Clerk error codes that mean the person is already in — not a failure. */
function isAlreadyInvitedError(error: unknown): boolean {
  const errors = (error as { errors?: { code?: string }[] })?.errors ?? [];
  return errors.some(
    (e) => e.code === "duplicate_record" || e.code === "form_identifier_exists",
  );
}

/**
 * Invite a teammate from within the app. Two writes, both required for access:
 * 1. app_users row — puts the email on the dynamic allowlist the middleware
 *    checks (alongside APP_ALLOWED_EMAILS), so they can get past the gate.
 * 2. Clerk invitation email — so they can create the account itself.
 */
export async function inviteTeammate(input: { email: string }): Promise<InviteResult> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, message: "Enter a valid email address." };

  let invitedBy: string | undefined;
  try {
    invitedBy = viewerFromClerkUser(await currentUser()).label;
  } catch {
    invitedBy = undefined;
  }

  if (hasSupabase()) {
    const supabase = getServiceSupabase();
    const { error } = await supabase
      .from("app_users")
      .upsert({ email, invited_by: invitedBy ?? null }, { onConflict: "email" });
    if (error) {
      console.error("inviteTeammate: app_users write failed", error);
      return { ok: false, message: "Couldn't save the invite — please retry." };
    }
    grantAccessInCache(email);
  }

  try {
    const client = await clerkClient();
    await client.invitations.createInvitation({
      emailAddress: email,
      redirectUrl: `${publicBaseUrl()}/sign-up`,
      notify: true,
      ignoreExisting: true,
    });
  } catch (error) {
    if (isAlreadyInvitedError(error)) {
      return { ok: true, message: `${email} already has an account or a pending invite — access is granted.` };
    }
    console.error("inviteTeammate: Clerk invitation failed", error);
    return {
      ok: true,
      message: `Access granted for ${email}, but the invite email couldn't be sent — share the app link and ask them to sign up directly.`,
    };
  }

  return { ok: true, message: `Invitation sent to ${email}.` };
}
