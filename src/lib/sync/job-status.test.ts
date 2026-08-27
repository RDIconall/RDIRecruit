import assert from "node:assert/strict";
import { stalePublishedShortcodes } from "./job-status.ts";

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

console.log("job-status.test.ts: ok");
