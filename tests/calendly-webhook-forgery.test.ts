import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { NextRequest } from "next/server";

const cases = [
  "secret-unset",
  "missing-signature",
  "bad-signature",
  "stale-signature",
  "tampered-body",
  "no-email",
  "unknown-email",
  "invitee-email",
  "payload-email",
  "signed-booking",
] as const;

async function runCase(mode: (typeof cases)[number]): Promise<{ code: number; output: string }> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "tests/helpers/calendly-webhook-case.ts", mode],
    { cwd: process.cwd(), env: { ...process.env, NODE_ENV: "test" } },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  const [code] = (await once(child, "exit")) as [number | null];
  return { code: code ?? 1, output };
}

for (const mode of cases) {
  test(`calendly webhook ${mode}`, async () => {
    const result = await runCase(mode);
    assert.equal(result.code, 0, result.output);
  });
}

test("signed-out POST /api/hooks/calendly is not rejected by middleware", async () => {
  process.env.NODE_ENV = "development";
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
  ]) {
    delete process.env[name];
  }
  delete process.env.NEXT_PUBLIC_CLERK_KEYLESS_DISABLED;

  const { default: middleware } = await import("../src/middleware.ts");
  const hook = new NextRequest("http://localhost/api/hooks/calendly", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const hookResponse = await middleware(hook, {} as never);
  assert.notEqual(hookResponse.status, 401);
  assert.equal(hookResponse.headers.get("location"), null);
});
