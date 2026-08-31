import assert from "node:assert/strict";
import test from "node:test";
import { isDefiniteBatchRejection, shouldHardenBatchAttempt } from "./batch-policy.ts";

test("first batch attempt keeps full candidate evidence", () => {
  assert.equal(shouldHardenBatchAttempt(0), false);
});

test("only explicit client/rate-limit responses are safe to retry", () => {
  for (const status of [400, 401, 403, 404, 409, 422, 429]) {
    assert.equal(isDefiniteBatchRejection({ status }), true);
  }
  assert.equal(isDefiniteBatchRejection({ status: 500 }), false);
  assert.equal(isDefiniteBatchRejection(new Error("socket timeout")), false);
});

test("retry hardens input instead of buying the identical refusal", () => {
  assert.equal(shouldHardenBatchAttempt(1), true);
  assert.equal(shouldHardenBatchAttempt(2), true);
});

