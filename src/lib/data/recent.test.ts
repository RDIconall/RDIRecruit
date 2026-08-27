import assert from "node:assert/strict";
import { selectRecentApplicants } from "./recent.ts";
import type { BoardCandidate, CandidateRow } from "../types.ts";

const NOW = new Date("2026-08-27T12:00:00Z");

function item(id: string, createdAt: string): BoardCandidate {
  return {
    candidate: {
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
    } as CandidateRow,
    score: null,
    ro: null,
    overlay: null,
  };
}

// The cross-role inbox is "new across roles" — a two-year-old application is not new.
const mixed = [
  item("today", "2026-08-27T09:00:00Z"),
  item("last-week", "2026-08-20T09:00:00Z"),
  item("two-years-ago", "2024-08-01T09:00:00Z"),
];
const recent = selectRecentApplicants(mixed, { now: NOW, days: 30, minimum: 1 });
assert.deepEqual(
  recent.map((b) => b.candidate.workable_id),
  ["today", "last-week"],
);

// Never show an empty inbox: with nothing inside the window, fall back to the
// most recent applications so the view still works on a quiet pool.
const stale = [
  item("older", "2024-01-01T09:00:00Z"),
  item("newer", "2025-01-01T09:00:00Z"),
];
const fallback = selectRecentApplicants(stale, { now: NOW, days: 30, minimum: 1 });
assert.deepEqual(
  fallback.map((b) => b.candidate.workable_id),
  ["newer"],
);

// The minimum tops up a thin window rather than truncating a busy one.
const thin = selectRecentApplicants(mixed, { now: NOW, days: 30, minimum: 3 });
assert.equal(thin.length, 3);

const busy = selectRecentApplicants(mixed, { now: NOW, days: 3650, minimum: 1 });
assert.equal(busy.length, 3);

// Undated rows never crowd out real applications.
const undated = selectRecentApplicants(
  [item("undated", ""), item("today", "2026-08-27T09:00:00Z")],
  { now: NOW, days: 30, minimum: 1 },
);
assert.deepEqual(
  undated.map((b) => b.candidate.workable_id),
  ["today"],
);

console.log("recent.test.ts: ok");
