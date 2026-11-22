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
]);

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect();
  }
});

// Webhook and ingest routes never use Clerk and are kept out of the matcher:
// running middleware makes Next.js buffer the whole request body (up to 10MB)
// before the route handler can enforce its own size cap.
export const config = {
  matcher: [
    "/((?!_next|api/hooks/|api/ingest/|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api(?!/hooks/|/ingest/)|trpc)(.*)",
  ],
};
