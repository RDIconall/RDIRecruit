import assert from "node:assert/strict";
import { complexityWeight, rankWeight } from "./ranking.ts";
import type { Candidate } from "./types.ts";

function stub(over: Partial<Candidate>): Candidate {
  return {
    id: "x",
    rank: 1,
    name: "X",
    role: "Role",
    company: "Co",
    appliedAt: null,
    salary: "",
    salaryNum: 0,
    decision: "interview",
    rev: "none",
    revNote: "",
    why: "",
    flag: "",
    next: "",
    survivor: true,
    value: { headline: "", level: "none", detail: "" },
    askTier: "mid",
    askNote: "",
    roLevel: "",
    roVsPool: "",
    mismatch: false,
    mismatchRead: "",
    timeline: [],
    cover: { hasLetter: false, lines: [] },
    answers: [],
    logistics: {
      location: "",
      commute: "",
      relocate: "",
      workAuth: "",
      start: "",
    },
    redFlags: [],
    resume: { hasFile: false, fileName: "", highlights: [] },
    workableUrl: "",
    initials: "X",
    avatarColor: "#000",
    locationShort: "",
    experience: "—",
    answersRead: { label: "—", level: "none" },
    specRead: { label: "—", level: "none" },
    ...over,
  } as Candidate;
}

assert.equal(complexityWeight("IV"), 3);
assert.equal(complexityWeight("IVc–IVb"), 3);
assert.equal(complexityWeight("III"), 2);
assert.equal(complexityWeight("II"), 1);
assert.equal(complexityWeight(""), 0);

const jdMatch = stub({
  specRead: { label: "Clears the bar", level: "strong" },
  answersRead: { label: "mixed", level: "mixed" },
  roLevel: "II",
  value: { headline: "Ask not stated", level: "none", detail: "" },
});
const cheaperWeakerFit = stub({
  specRead: { label: "Partial", level: "mixed" },
  answersRead: { label: "strong", level: "strong" },
  roLevel: "II",
  value: { headline: "Strong candidate, good value", level: "strong", detail: "" },
});
assert.ok(
  rankWeight(jdMatch) > rankWeight(cheaperWeakerFit),
  "job-description match outranks salary value",
);

const complex = stub({
  specRead: { label: "Clears the bar", level: "strong" },
  answersRead: { label: "strong", level: "strong" },
  roLevel: "IV",
});
const simpler = stub({
  specRead: { label: "Clears the bar", level: "strong" },
  answersRead: { label: "strong", level: "strong" },
  roLevel: "II",
});
assert.ok(
  rankWeight(complex) > rankWeight(simpler),
  "higher problem complexity ranks above a weaker RO level at the same job match",
);

console.log("ranking.test.ts: ok");
