import "./support/install-server-only-hook.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  assertStillInOutreach,
  CONTACT_A,
  CONTACT_B,
  contactRow,
  installPlaceholderEnv,
  installPostgrestFetch,
  OPT_OUT_REASON,
  outreachStatus,
  requestFromFooter,
  seedOutreach,
  TOKEN_A,
} from "./support/radar-opt-out-harness.ts";

installPlaceholderEnv();
installPostgrestFetch();

type GetHandler = typeof import("../src/app/api/radar/unsubscribe/route.ts").GET;

let loaded = false;
let GET: GetHandler;
let setOptOutByToken: typeof import("../src/lib/radar/store.ts").setOptOutByToken;
let unsubscribeFooter: typeof import("../src/lib/radar/outreach.ts").unsubscribeFooter;
let hasSupabase: typeof import("../src/lib/env.ts").hasSupabase;
let isRadarEnabled: typeof import("../src/lib/radar/enabled.ts").isRadarEnabled;

async function load(): Promise<void> {
  if (loaded) return;
  GET = (await import("../src/app/api/radar/unsubscribe/route.ts")).GET;
  setOptOutByToken = (await import("../src/lib/radar/store.ts")).setOptOutByToken;
  unsubscribeFooter = (await import("../src/lib/radar/outreach.ts")).unsubscribeFooter;
  hasSupabase = (await import("../src/lib/env.ts")).hasSupabase;
  isRadarEnabled = (await import("../src/lib/radar/enabled.ts")).isRadarEnabled;
  loaded = true;
}

test("unsubscribe harness writes through the real store and supabase client", async () => {
  await load();
  assert.equal(hasSupabase(), true);
  seedOutreach();
  const wrote = await setOptOutByToken(TOKEN_A, OPT_OUT_REASON);
  assert.equal(wrote, true);
  assert.equal(contactRow(CONTACT_A).opt_out, true);
  assert.equal(contactRow(CONTACT_A).consent_status, "withdrawn");
  assert.equal(outreachStatus("outreach-a-sent"), "opted_out");
  assert.equal(outreachStatus("outreach-a-replied"), "replied");
  assert.equal(outreachStatus("outreach-a-meeting"), "meeting");
  assert.equal(contactRow(CONTACT_B).opt_out, false);
  assert.equal(outreachStatus("outreach-b-sent"), "sent");
});

test("a normal GET of the emailed unsubscribe link does not opt the contact out", async () => {
  await load();
  const source = readFileSync(new URL("../src/lib/radar/enabled.ts", import.meta.url), "utf8");
  assert.match(source, /export const RADAR_ENABLED = false/);
  assert.equal(isRadarEnabled(), false);
  seedOutreach();
  const footer = unsubscribeFooter(TOKEN_A);
  const response = await GET(requestFromFooter(footer));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  assertStillInOutreach();
});

test("a prefetch GET of the emailed unsubscribe link does not opt the contact out", async () => {
  await load();
  seedOutreach();
  const footer = unsubscribeFooter(TOKEN_A);
  const response = await GET(
    requestFromFooter(footer, {
      headers: {
        purpose: "prefetch",
        "sec-purpose": "prefetch",
        "x-purpose": "preview",
        "x-moz": "prefetch",
      },
    }),
  );
  assert.equal(response.status, 200);
  assertStillInOutreach();
});

test("HEAD of the emailed unsubscribe link does not opt the contact out", async () => {
  // Next 16 assigns the GET handler to HEAD when HEAD is not exported, and calls
  // it with the original request (method HEAD). This invokes that same function.
  await load();
  seedOutreach();
  const footer = unsubscribeFooter(TOKEN_A);
  const response = await GET(requestFromFooter(footer, { method: "HEAD" }));
  assert.equal(response.status, 200);
  assertStillInOutreach();
});

test("GET without a token or with an unknown token changes nothing", async () => {
  await load();
  seedOutreach();
  const missing = await GET(new NextRequest("https://recruit.example.test/api/radar/unsubscribe"));
  assert.equal(missing.status, 200);
  assertStillInOutreach();

  const unknown = await GET(
    new NextRequest("https://recruit.example.test/api/radar/unsubscribe?token=00000000-0000-4000-8000-000000000099"),
  );
  assert.equal(unknown.status, 200);
  assertStillInOutreach();
});

test("an unauthenticated scanner request is not blocked by Clerk", async () => {
  await load();
  (process.env as { NODE_ENV?: string }).NODE_ENV = "development";
  for (const name of [
    "CI",
    "CONTINUOUS_INTEGRATION",
    "GITHUB_ACTIONS",
    "GITLAB_CI",
    "CIRCLECI",
    "TRAVIS",
    "BUILDKITE",
    "BITBUCKET_BUILD_NUMBER",
    "APPVEYOR",
    "CODEBUILD_BUILD_ID",
    "TF_BUILD",
    "TEAMCITY_VERSION",
    "JENKINS_URL",
    "HUDSON_URL",
    "BAMBOO_BUILDKEY",
    "CF_PAGES",
    "CLERK_SECRET_KEY",
    "CLERK_MACHINE_SECRET_KEY",
    "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    "CLERK_ENCRYPTION_KEY",
  ]) {
    delete process.env[name];
  }
  const middleware = (await import("../src/middleware.ts")).default;
  const footer = unsubscribeFooter(TOKEN_A);
  const unsubscribe = requestFromFooter(footer);
  const allowed = await middleware(unsubscribe, {} as never);
  assert.ok(allowed);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("location"), null);

  // The same unauthenticated browser-like GET to a route outside the public
  // matcher reaches auth.protect(). With no Clerk key configured, that throws
  // instead of continuing to the route.
  await assert.rejects(async () => {
    await middleware(
      new NextRequest("https://recruit.example.test/api/radar/export", {
        headers: { accept: "text/html, */*", "user-agent": "Mozilla/5.0 (compatible; MailScanner/1.0)" },
      }),
      {} as never,
    );
  });
});
