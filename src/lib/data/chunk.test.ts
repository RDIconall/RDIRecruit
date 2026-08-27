import assert from "node:assert/strict";
import { ID_CHUNK, chunkIds } from "./chunk.ts";

// Every per-candidate query embeds its ids in the request URL. Unbounded id
// lists made the pool page fail to load once the whole pool was fetched, so the
// ids must always be split into bounded batches.
assert.deepEqual(chunkIds([], 3), []);
assert.deepEqual(chunkIds(["a"], 3), [["a"]]);
assert.deepEqual(chunkIds(["a", "b", "c", "d"], 2), [
  ["a", "b"],
  ["c", "d"],
]);
assert.deepEqual(chunkIds(["a", "b", "c"], 2), [["a", "b"], ["c"]]);

// A pool larger than one batch must never produce a single oversized request.
const many = Array.from({ length: 2500 }, (_, i) => `cand_${i}`);
const batches = chunkIds(many);
assert.ok(batches.length > 1);
assert.ok(batches.every((b) => b.length <= ID_CHUNK));
assert.equal(batches.flat().length, many.length);
assert.equal(new Set(batches.flat()).size, many.length);

// A bad size must not spin forever or drop ids.
assert.deepEqual(chunkIds(["a", "b"], 0), [["a", "b"]]);

console.log("chunk.test.ts: ok");
