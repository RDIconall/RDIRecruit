import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createRouteMatcher } from "@clerk/nextjs/server";

/**
 * The sign-up page is public in the middleware matcher the app ships.
 * Patterns are read from src/middleware.ts so this follows that list.
 */
function publicPatterns(): string[] {
  const source = readFileSync(new URL("../src/middleware.ts", import.meta.url), "utf8");
  const block = source.match(/createRouteMatcher\(\[([\s\S]*?)\]\)/);
  assert.ok(block, "middleware public route list missing");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

test("the sign-up page is not behind Clerk protect", () => {
  const patterns = publicPatterns();
  assert.ok(patterns.includes("/sign-up(.*)"));
  const isPublic = createRouteMatcher(patterns);
  const request = (pathname: string) => ({ nextUrl: { pathname } }) as Parameters<typeof isPublic>[0];
  assert.equal(isPublic(request("/sign-up")), true);
  assert.equal(isPublic(request("/sign-up/verify-email-address")), true);
  assert.equal(isPublic(request("/")), false);
});
