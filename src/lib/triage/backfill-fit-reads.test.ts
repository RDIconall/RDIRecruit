import assert from "node:assert/strict";
import test from "node:test";
import { planFitReadBackfill } from "./backfill-fit-reads";

test("projects a completed analysis instead of buying a second read", () => {
  const plan = planFitReadBackfill({
    candidates: [
      { id: "done", jobShortcode: "JOB1", disqualified: false, createdAt: "2026-01-01" },
    ],
    overlayDisqualifiedIds: [],
    fitReadIds: [],
    reviewerLockedIds: [],
    completedAnalysisIds: ["done"],
  });
  assert.deepEqual(plan, [
    { action: "project", candidateId: "done", jobShortcode: "JOB1", createdAt: "2026-01-01" },
  ]);
});

test("enqueues people who have materials in the pool but no write-up yet", () => {
  const plan = planFitReadBackfill({
    candidates: [
      { id: "new", jobShortcode: "JOB1", disqualified: false, createdAt: "2026-02-01" },
    ],
    overlayDisqualifiedIds: [],
    fitReadIds: [],
    reviewerLockedIds: [],
    completedAnalysisIds: [],
  });
  assert.deepEqual(plan, [
    { action: "enqueue", candidateId: "new", jobShortcode: "JOB1", createdAt: "2026-02-01" },
  ]);
});

test("does not rewrite people who already have a fit read or are out of the pool", () => {
  const plan = planFitReadBackfill({
    candidates: [
      { id: "has-read", jobShortcode: "JOB1", disqualified: false, createdAt: "2026-01-01" },
      { id: "dq", jobShortcode: "JOB1", disqualified: true, createdAt: "2026-01-02" },
      { id: "overlay", jobShortcode: "JOB1", disqualified: false, createdAt: "2026-01-03" },
      { id: "locked", jobShortcode: "JOB1", disqualified: false, createdAt: "2026-01-04" },
    ],
    overlayDisqualifiedIds: ["overlay"],
    fitReadIds: ["has-read"],
    reviewerLockedIds: ["locked"],
    completedAnalysisIds: ["has-read", "dq", "overlay", "locked"],
  });
  assert.deepEqual(plan, []);
});

test("free projections run before paid enqueue, oldest first in each group", () => {
  const plan = planFitReadBackfill({
    candidates: [
      { id: "enqueue-new", jobShortcode: "JOB1", disqualified: false, createdAt: "2026-03-01" },
      { id: "project-old", jobShortcode: "JOB1", disqualified: false, createdAt: "2026-01-01" },
      { id: "enqueue-old", jobShortcode: "JOB2", disqualified: false, createdAt: "2026-02-01" },
      { id: "project-new", jobShortcode: "JOB2", disqualified: false, createdAt: "2026-04-01" },
    ],
    overlayDisqualifiedIds: [],
    fitReadIds: [],
    reviewerLockedIds: [],
    completedAnalysisIds: ["project-new", "project-old"],
  });
  assert.deepEqual(
    plan.map((item) => `${item.action}:${item.candidateId}`),
    ["project:project-old", "project:project-new", "enqueue:enqueue-old", "enqueue:enqueue-new"],
  );
});
