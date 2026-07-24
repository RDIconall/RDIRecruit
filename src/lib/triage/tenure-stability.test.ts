import assert from "node:assert/strict";
import {
  analyzeTenureStability,
  applyTenureDecisionGate,
  capTenureCategoryScore,
  coalesceTenureRoles,
  parseResumeDate,
  roleFromPeriodSpan,
  roleTenureMonths,
} from "./tenure-stability";

const NOW = new Date("2026-07-01T12:00:00Z");

assert.deepEqual(parseResumeDate("2024-03"), { y: 2024, m: 2 });
assert.deepEqual(parseResumeDate("Jan 2023"), { y: 2023, m: 0 });
assert.equal(parseResumeDate("Present"), null);

assert.equal(
  roleTenureMonths({ title: "EA", company: "A", start: "2024-01", end: "2024-10" }, NOW),
  9,
);

const hopper = analyzeTenureStability(
  [
    { title: "EA", company: "One", start: "2022-01", end: "2022-08" },
    { title: "EA", company: "Two", start: "2023-01", end: "2023-10" },
    { title: "EA", company: "Three", start: "2024-01", end: null, current: true },
  ],
  NOW,
);
assert.equal(hopper.severity, "severe"); // 2 shorts, no multi-year anchor
assert.equal(hopper.shortCompletedCount, 2);
assert.ok(hopper.caveat);
assert.ok(hopper.flagDetail);

const withAnchor = analyzeTenureStability(
  [
    { title: "Coordinator", company: "LongCo", start: "2018-01", end: "2022-01" },
    { title: "EA", company: "ShortA", start: "2023-01", end: "2023-08" },
    { title: "EA", company: "ShortB", start: "2024-01", end: "2024-10" },
  ],
  NOW,
);
assert.equal(withAnchor.severity, "pattern");
assert.equal(withAnchor.longAnchorCount, 1);

const mild = analyzeTenureStability(
  [
    { title: "EA", company: "Short", start: "2023-01", end: "2023-10" },
    { title: "EA", company: "Now", start: "2024-01", end: null, current: true },
  ],
  NOW,
);
assert.equal(mild.severity, "mild");
assert.equal(mild.flagDetail, null);

assert.equal(applyTenureDecisionGate("interview", hopper), "backup");
assert.equal(applyTenureDecisionGate("interview", withAnchor), "backup");
assert.equal(applyTenureDecisionGate("interview", mild), "interview");
assert.equal(applyTenureDecisionGate("reject", hopper), "reject");
assert.equal(applyTenureDecisionGate("backup", hopper), "backup");

assert.equal(capTenureCategoryScore(10, 10, hopper), 2);
assert.equal(capTenureCategoryScore(10, 10, withAnchor), 4);
assert.equal(capTenureCategoryScore(10, 10, mild), 7);
assert.equal(capTenureCategoryScore(10, 10, analyzeTenureStability([], NOW)), 10);

const fromSpan = roleFromPeriodSpan("Ops", "Acme", "2023-01 – 2023-09");
assert.ok(fromSpan);
assert.equal(roleTenureMonths(fromSpan!, NOW), 8);

const coalesced = coalesceTenureRoles(
  [{ title: "Thin", company: "X" }], // no dates
  [
    { title: "A", company: "One", span: "2022-01 – 2022-06" },
    { title: "B", company: "Two", span: "2023-01 – 2023-08" },
    { title: "C", company: "Three", span: "2024-01 – Present" },
  ],
);
const fromNarrative = analyzeTenureStability(coalesced, NOW);
assert.equal(fromNarrative.severity, "severe");

console.log("tenure-stability.test.ts: ok");
