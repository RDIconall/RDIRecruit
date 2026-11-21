import "./support/install-server-only-hook.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { NextRequest } from "next/server";
import {
  assertOptedOutOnlyContactA,
  assertStillInOutreach,
  confirmationPost,
  CONTACT_B,
  installPlaceholderEnv,
  installPostgrestFetch,
  rebindTokenOnNextLookup,
  requestFromFooter,
  seedOutreach,
  TOKEN_A,
} from "./support/radar-opt-out-harness.ts";

installPlaceholderEnv();
installPostgrestFetch();

type GetHandler = typeof import("../src/app/api/radar/unsubscribe/route.ts").GET;
type PostHandler = (request: NextRequest) => Promise<Response>;

let loaded = false;
let GET: GetHandler;
let routePost: PostHandler | undefined;
let unsubscribeFooter: typeof import("../src/lib/radar/outreach.ts").unsubscribeFooter;
let isRadarEnabled: typeof import("../src/lib/radar/enabled.ts").isRadarEnabled;

async function load(): Promise<void> {
  if (loaded) return;
  const route = await import("../src/app/api/radar/unsubscribe/route.ts");
  GET = route.GET;
  routePost = (route as { POST?: PostHandler }).POST;
  unsubscribeFooter = (await import("../src/lib/radar/outreach.ts")).unsubscribeFooter;
  isRadarEnabled = (await import("../src/lib/radar/enabled.ts")).isRadarEnabled;
  loaded = true;
}

function postHandler(): PostHandler {
  if (typeof routePost !== "function") {
    throw new Error("opt-out must be applied by a POST handler");
  }
  return routePost;
}

test("confirmation POST still opts out while Talent Radar is off", async () => {
  await load();
  const source = readFileSync(new URL("../src/lib/radar/enabled.ts", import.meta.url), "utf8");
  assert.match(source, /export const RADAR_ENABLED = false/);
  assert.equal(isRadarEnabled(), false);

  seedOutreach();
  const footer = unsubscribeFooter(TOKEN_A);
  const link = footer.match(/https?:\/\/\S+/)?.[0];
  assert.ok(link);
  const opened = await GET(requestFromFooter(footer));
  assert.equal(opened.status, 200);
  assertStillInOutreach();

  // If the handler looks the token up again, the second read names contact B.
  // The write must still apply to the contact authorized by the first read.
  rebindTokenOnNextLookup(CONTACT_B);

  const html = await opened.text();
  const submitted = confirmationPost(html, link, TOKEN_A);
  const confirmed = await postHandler()(submitted);
  assert.equal(confirmed.status, 200);
  assertOptedOutOnlyContactA();
});

test("POST of an unknown token or a missing token changes nothing", async () => {
  await load();
  seedOutreach();
  const footer = unsubscribeFooter(TOKEN_A);
  const link = footer.match(/https?:\/\/\S+/)?.[0];
  assert.ok(link);
  const opened = await GET(requestFromFooter(footer));
  assertStillInOutreach();
  const html = await opened.text();

  const unknown = confirmationPost(html, link, TOKEN_A);
  const url = new URL(unknown.url);
  url.searchParams.set("token", "00000000-0000-4000-8000-000000000099");
  const body = new URLSearchParams(await unknown.text());
  if (body.has("token")) body.set("token", "00000000-0000-4000-8000-000000000099");
  const { NextRequest } = await import("next/server");
  const missed = await postHandler()(
    new NextRequest(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body,
    }),
  );
  assert.equal(missed.status, 200);
  assertStillInOutreach();

  url.searchParams.delete("token");
  const empty = await postHandler()(
    new NextRequest(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams(),
    }),
  );
  assert.equal(empty.status, 200);
  assertStillInOutreach();
});
