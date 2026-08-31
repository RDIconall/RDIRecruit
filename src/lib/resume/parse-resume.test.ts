import assert from "node:assert/strict";
import test from "node:test";
import { parseResumeIntelligently } from "./parse-resume.ts";

test("resume ingest reshapes Workable fields without a second model analysis", async () => {
  const parsed = await parseResumeIntelligently({
    candidateName: "Candidate",
    resumeText: "A sufficiently long résumé body that the old implementation would have sent to Claude for parsing.".repeat(2),
    workableExperience: [
      {
        title: "Clinical Lead",
        company: "Example Co",
        start: "2021-01-01",
        end: "2024-02-01",
        summary: "Owned study operations.",
      },
    ],
    workableEducation: [
      {
        school: "Example University",
        degree: "BS",
        field: "Biology",
        end: "2020-06-01",
      },
    ],
  });

  assert.equal(parsed.modelVersion, "heuristic");
  assert.equal(parsed.roles[0]?.title, "Clinical Lead");
  assert.equal(parsed.roles[0]?.start, "2021-01");
  assert.equal(parsed.education[0]?.school, "Example University");
  assert.equal(parsed.education[0]?.field, "Biology");
});

