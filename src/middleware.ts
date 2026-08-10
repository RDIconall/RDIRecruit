import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/preview(.*)", // unauthenticated UI preview harness (mock data only — no PII)
  "/api/hooks/(.*)",
  "/api/cron/(.*)",
  "/api/health",
  "/api/ingest/(.*)",
  "/api/radar/unsubscribe",
  // Vercel Workflows internal enqueue / resume routes — must not hit Clerk.
  "/.well-known/workflow/(.*)",
]);

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Exclude Workflow SDK internals — intercepting them breaks enqueue/resume
    // (detached ArrayBuffer / queue failures on Next 16).
    "/((?!_next|\\.well-known/workflow|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
