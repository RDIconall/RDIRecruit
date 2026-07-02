import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { hasEmailAllowlist, isEmailAllowed } from "@/lib/auth/access";

const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/access-denied(.*)",
  "/preview(.*)", // unauthenticated UI preview harness (mock data only — no PII)
  "/api/hooks/(.*)",
  "/api/cron/(.*)",
  "/api/health",
  "/api/ingest/(.*)",
  "/api/radar/unsubscribe",
]);

async function primaryEmailForUser(userId: string): Promise<string | undefined> {
  const { clerkClient } = await import("@clerk/nextjs/server");
  const client = await clerkClient();
  const user = await client.users.getUser(userId);
  return user.emailAddresses.find((entry) => entry.id === user.primaryEmailAddressId)?.emailAddress;
}

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    const { userId, sessionClaims } = await auth.protect();

    if (hasEmailAllowlist() && userId) {
      const claimEmail =
        (sessionClaims?.email as string | undefined) ??
        (sessionClaims?.primary_email_address as string | undefined);
      let email = claimEmail;
      if (!isEmailAllowed(email)) {
        email = await primaryEmailForUser(userId);
      }
      if (!isEmailAllowed(email)) {
        return NextResponse.redirect(new URL("/access-denied", request.url));
      }
    }
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
