import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The grader module is server-only. Next loads it with the react-server export
// condition; plain `tsx --test` resolves `server-only` to the client throw.
// Re-exec the cases under that condition so `npm test` hits the real assertions.
const cases = path.join(path.dirname(fileURLToPath(import.meta.url)), "integrity-gate-board.cases.ts");

test("integrity failure stays off the interview list", () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "--test", cases],
    { encoding: "utf8", env },
  );
  assert.equal(
    result.status,
    0,
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  );
});
