import assert from "node:assert/strict";
import test from "node:test";
import { analysisFingerprint, stableJson } from "./fingerprint.ts";

test("stableJson ignores object insertion order", () => {
  assert.equal(
    stableJson({ b: 2, nested: { z: 3, a: 1 }, a: 1 }),
    stableJson({ a: 1, nested: { a: 1, z: 3 }, b: 2 }),
  );
});

test("analysis fingerprint is stable for equivalent snapshots", () => {
  const left = { candidateId: "c1", input: { answers: { second: "b", first: "a" } } };
  const right = { input: { answers: { first: "a", second: "b" } }, candidateId: "c1" };
  assert.equal(analysisFingerprint(left), analysisFingerprint(right));
});

test("analysis fingerprint changes with decision-relevant evidence", () => {
  const base = { candidateId: "c1", input: { transcript: "", rubric: "v1" } };
  assert.notEqual(
    analysisFingerprint(base),
    analysisFingerprint({ candidateId: "c1", input: { transcript: "new interview", rubric: "v1" } }),
  );
  assert.notEqual(
    analysisFingerprint(base),
    analysisFingerprint({ candidateId: "c1", input: { transcript: "", rubric: "v2" } }),
  );
});

