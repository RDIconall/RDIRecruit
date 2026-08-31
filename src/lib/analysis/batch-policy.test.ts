import assert from "node:assert/strict";
import test from "node:test";
import { shouldHardenBatchAttempt } from "./batch-policy.ts";

test("first batch attempt keeps full candidate evidence", () => {
  assert.equal(shouldHardenBatchAttempt(0), false);
});

test("retry hardens input instead of buying the identical refusal", () => {
  assert.equal(shouldHardenBatchAttempt(1), true);
  assert.equal(shouldHardenBatchAttempt(2), true);
});

