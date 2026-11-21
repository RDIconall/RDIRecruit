import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function run(mode: "unauth" | "auth", env: NodeJS.ProcessEnv) {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "./tests/support/register-server-only.mjs",
      "--import",
      "tsx",
      "tests/videoask-transcript-dos.runner.ts",
      mode,
    ],
    {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert.equal(result.status, 0, output);
}

function baseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.WORKABLE_TOKEN;
  delete env.WORKABLE_API_KEY;
  delete env.VIDEOASK_WEBHOOK_SECRET;
  return env;
}

test("public videoask webhook rejects callers that do not prove the secret", () => {
  run("unauth", baseEnv());
});

test("proved videoask and fireflies transcripts stay bounded and the inbox excerpts them", () => {
  run("auth", { ...baseEnv(), VIDEOASK_WEBHOOK_SECRET: "placeholder-videoask-secret" });
});
