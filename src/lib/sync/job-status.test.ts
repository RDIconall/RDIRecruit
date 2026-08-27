import assert from "node:assert/strict";
import { shouldCloseJob, stalePublishedShortcodes } from "./job-status.ts";

// A job closed in Workable appears in neither the published nor the archived
// list, so its local row kept status "published" forever and stayed in the
// cross-role job picker. It must be reconciled to closed.
assert.deepEqual(
  stalePublishedShortcodes({
    localPublished: ["A", "B", "C"],
    published: ["A"],
    archived: ["B"],
    publishedFetchOk: true,
  }),
  ["C"],
);

// Still published, or explicitly archived, is not stale.
assert.deepEqual(
  stalePublishedShortcodes({
    localPublished: ["A", "B"],
    published: ["A", "B"],
    archived: [],
    publishedFetchOk: true,
  }),
  [],
);

// Safety: a failed/empty published fetch must never close the whole board.
assert.deepEqual(
  stalePublishedShortcodes({
    localPublished: ["A", "B"],
    published: [],
    archived: [],
    publishedFetchOk: false,
  }),
  [],
);

// Closing a job hides its entire pool, so absence from a list is only a
// candidate — Workable must explicitly report a non-published state.
assert.equal(shouldCloseJob("closed"), true);
assert.equal(shouldCloseJob("draft"), true);
assert.equal(shouldCloseJob("on_hold"), true);
assert.equal(shouldCloseJob("archived"), true);
assert.equal(shouldCloseJob("published"), false);
assert.equal(shouldCloseJob("Published"), false);
// Unknown state (failed fetch, missing field) must never close a live job.
assert.equal(shouldCloseJob(""), false);
assert.equal(shouldCloseJob(null), false);
assert.equal(shouldCloseJob(undefined), false);

console.log("job-status.test.ts: ok");