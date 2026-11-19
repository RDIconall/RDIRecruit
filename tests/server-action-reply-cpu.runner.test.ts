import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// npm test does not pass Node's react-server export condition. This runner
// re-executes the spec under that condition, which is how the Next.js server
// loads the reply decoder.
test("server-action reply decoder spec", () => {
  const env = { ...process.env };
  // A nested `node --test` inherits the parent runner and exits without
  // loading this spec. Drop those variables so the child is a real run.
  for (const key of Object.keys(env)) {
    if (key.startsWith("NODE_TEST") || key === "NODE_CHANNEL_FD") {
      delete env[key];
    }
  }
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--test",
      "tests/server-action-reply-cpu.test.mjs",
    ],
    { encoding: "utf8", timeout: 60_000, env },
  );
  assert.equal(
    result.status,
    0,
    `${result.stdout}\n${result.stderr}`,
  );
});
