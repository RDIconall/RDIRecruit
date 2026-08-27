import assert from "node:assert/strict";
import { sortBoard } from "./board-queries.ts";
import type { BoardCandidate, CandidateRow } from "../types.ts";

function row(id: string, createdAt: string, over: Partial<CandidateRow> = {}): CandidateRow {
  return {
    workable_id: id,
    job_shortcode: "JOB1",
    name: id,
    email: null,
    phone: null,
    location: null,
    stage: "Applied",
    stage_kind: null,
    disqualified: false,
    source: null,
    assignee_id: null,
    raw: null,
    photo_url: null,
    created_at: createdAt,
    synced_at: createdAt,
    ...over,
  } as CandidateRow;
}

function item(id: string, createdAt: string, over: Partial<BoardCandidate> = {}): BoardCandidate {
  return { candidate: row(id, createdAt), score: null, ro: null, overlay: null, ...over };
}

// The pool must lead with the newest applications, not whatever scored highest
// years ago. This is the regression that left the board showing old candidates.
const sorted = sortBoard([
  item("old", "2026-01-01T00:00:00.000Z"),
  item("newest", "2026-08-20T00:00:00.000Z"),
  item("middle", "2026-05-01T00:00:00.000Z"),
]);
assert.deepEqual(
  sorted.map((b) => b.candidate.workable_id),
  ["newest", "middle", "old"],
);

// Disqualified/withdrawn still collapse below every active candidate.
const withCut = sortBoard([
  item("cut-but-new", "2026-08-25T00:00:00.000Z", {
    candidate: row("cut-but-new", "2026-08-25T00:00:00.000Z", { disqualified: true }),
  }),
  item("active-old", "2026-02-01T00:00:00.000Z"),
]);
assert.deepEqual(
  withCut.map((b) => b.candidate.workable_id),
  ["active-old", "cut-but-new"],
);

// Missing timestamps sort last rather than jumping the queue.
const undated = sortBoard([
  item("undated", "", { candidate: row("undated", "") }),
  item("dated", "2026-03-01T00:00:00.000Z"),
]);
assert.deepEqual(
  undated.map((b) => b.candidate.workable_id),
  ["dated", "undated"],
);

console.log("board-queries.test.ts: ok");
