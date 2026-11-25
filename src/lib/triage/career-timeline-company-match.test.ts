/**
 * Spec for career-company matching.
 *
 * An applicant on a public Workable posting chooses employer names. Those names
 * become résumé roles, narrative rows ("Title at Company"), and the company
 * field on each stored role write-up. The timeline then attaches a write-up
 * when the write-up's company merely contains the first eight characters of
 * the employer, and it keeps the first hit. The dossier record does the same
 * with a six-character check in both directions when a career chart is present,
 * and copies the timeline scope when no chart and no résumé roles are present.
 *
 * A write-up (or résumé bullet) may attach only when the normalized company
 * equals the employer, or when one normalized name is a full token-bounded
 * name of the other (contiguous whole tokens, not a character slice inside a
 * token). Normalization is lowercase, punctuation turned into spaces, and
 * collapsed whitespace. When several writes are eligible, the exact normalized
 * name wins over a longer name that merely contains it. If nothing is eligible,
 * the accomplishment stays blank ("—") rather than the first partial hit.
 *
 * These tests fail while that partial match is still in place.
 */
import "./career-timeline-company-match.stub.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildLifeNarrative } from "../narrative/builder.ts";
import { experienceFromParsedResume, narrativeFromParsedResume } from "../resume/narrative-from-parse.ts";
import { parseResumeIntelligently } from "../resume/parse-resume.ts";
import {
  buildEvaluatorRequest,
  parseEvaluatorMessage,
  type EvaluatorInput,
} from "../scoring/evaluator.ts";
import type { CandidateRow, NarrativeSegment, RoAssessmentRow, RoleReadPayload, ScoreRow } from "../types.ts";
import { TriageDataProvider } from "../../components/triage/context.tsx";
import type { WorkspaceApi } from "../../components/triage/use-workspace.ts";
import { mapCandidate, type MapInput } from "./from-supabase.ts";
import type { Candidate } from "./types.ts";
import { renderWorkingFile } from "./working-file.ts";

const STRONG_WRITEUP = "Led the flagship research organization through launch.";
const WEAK_WRITEUP = "Filed the weekly expense reports for the office.";
const STRONG_BULLET = "Shipped the flagship research model to customers.";
const WEAK_BULLET = "Sorted the incoming mail and booked the shuttle.";
const BETA_BULLET = "Ran the beta program for a single product line.";

const candidateRow: CandidateRow = {
  workable_id: "cand_prefix",
  job_shortcode: "JOB1",
  name: "Prefix Applicant",
  email: null,
  phone: null,
  location: "Los Angeles, CA",
  stage: "Applied",
  stage_kind: null,
  disqualified: false,
  source: null,
  assignee_id: null,
  raw: null,
  photo_url: null,
  created_at: "2026-06-01T00:00:00.000Z",
  synced_at: "2026-06-01T00:00:00.000Z",
};

function score(): ScoreRow {
  return {
    id: "score_prefix",
    candidate_id: candidateRow.workable_id,
    rubric_version: 1,
    category_scores: { principal: 0, environment: 0, scope: 0, writing: 0, tenure: 0, local: 0 },
    total: 70,
    salary_value: "justified",
    confidence: "medium",
    model_version: "test",
    created_at: "2026-06-01T00:00:00.000Z",
  };
}

interface ApplicantJob {
  title: string;
  company: string;
  start: string;
  end?: string;
  current?: boolean;
  summary: string;
}

interface GradedWriteup {
  company: string;
  role: string;
  read: string;
  level: string;
  stratum?: string;
}

function weights(): EvaluatorInput["weights"] {
  return { principal: 20, environment: 20, scope: 20, writing: 20, tenure: 20, local: 20 };
}

function evaluatorInput(jobs: ApplicantJob[]): EvaluatorInput {
  return {
    name: candidateRow.name ?? "Applicant",
    resumeText: jobs.map((job) => `${job.title} at ${job.company}\n${job.summary}`).join("\n\n"),
    roles: jobs.map((job) => ({
      title: job.title,
      company: job.company,
      start: job.start,
      end: job.end,
      current: job.current,
      summary: job.summary,
    })),
    answers: { "Why this seat?": "I want the work." },
    coverLetter: "Please consider this application.",
    seat: {
      jobTitle: "Operator",
      seatStratum: "II",
      jdSummary: "Operate the desk.",
      categoryLabels: {
        principal: "Principal",
        environment: "Environment",
        scope: "Scope",
        writing: "Writing",
        tenure: "Tenure",
        local: "Local",
      },
    },
    weights: weights(),
    rubricSchemaVersion: "legacy-v1",
    method: "Read actions.",
  };
}

/**
 * Grading persists each model role write-up's company and read unchanged.
 * This is the payload shape scoreCandidate writes for kind "role_read".
 */
function gradeWriteups(jobs: ApplicantJob[], writeups: GradedWriteup[]): RoleReadPayload[] {
  const input = evaluatorInput(jobs);
  const body = {
    categoryScores: { principal: 10, environment: 10, scope: 10, writing: 10, tenure: 10, local: 10 },
    answerGrades: [{ question: "Why this seat?", verdict: "OWNED", note: "Owned.", kind: "screen" }],
    roReads: writeups.map((writeup) => ({
      role: writeup.role,
      company: writeup.company,
      years: 2,
      stratum: writeup.stratum ?? "II",
      stratumRange: writeup.stratum ?? "II",
      verbs: { I: [], II: [], III: [] },
      read: writeup.read,
      level: writeup.level,
      burden: "execution",
      quote: writeup.read,
    })),
  };
  const evaluation = parseEvaluatorMessage(
    {
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify(body), citations: null }],
    },
    input,
  );
  assert.ok(evaluation, "grading payload must normalize");
  assert.equal(evaluation.heuristic, undefined);
  return evaluation.roReads.map((role) => ({
    role: role.role,
    company: role.company,
    read: role.read,
    level: role.level,
    burden: role.burden,
    stratum: role.stratum,
    quote: role.quote,
  }));
}

function roFromWriteups(evaluationReads: RoleReadPayload[], strata: Record<string, string>): RoAssessmentRow {
  return {
    id: "ro_prefix",
    candidate_id: candidateRow.workable_id,
    per_role: evaluationReads.map((role) => ({
      role: role.role,
      company: role.company,
      years: 2,
      stratum: strata[role.company] ?? "II",
      stratum_range: strata[role.company] ?? "II",
      verbs: { I: [], II: [], III: [] },
    })),
    seat_stratum: "II",
    current_capability: "II",
    trajectory: "plateaued",
    text_confidence: "confirmed",
    basis: "reasoning",
    created_at: "2026-06-01T00:00:00.000Z",
  };
}

async function narrativeFromApplication(jobs: ApplicantJob[]): Promise<{
  ingest: NarrativeSegment[];
  scored: NarrativeSegment[];
  parsedExperience: ReturnType<typeof experienceFromParsedResume>;
}> {
  const parsed = await parseResumeIntelligently({
    candidateName: candidateRow.name ?? "Applicant",
    resumeText: jobs.map((job) => `${job.title} · ${job.company}\n${job.summary}`).join("\n\n"),
    workableExperience: jobs.map((job) => ({
      title: job.title,
      company: job.company,
      start: job.start,
      end: job.end,
      current: job.current,
      summary: job.summary,
    })),
    workableEducation: [],
  });
  const parsedExperience = experienceFromParsedResume(parsed);
  return {
    ingest: narrativeFromParsedResume(parsed),
    scored: buildLifeNarrative({
      experience: parsedExperience,
      education: [],
    }),
    parsedExperience,
  };
}

function project(narrative: NarrativeSegment[], reads: RoleReadPayload[], ro: RoAssessmentRow | null, parsedExperience: MapInput["application"]): Candidate {
  const input: MapInput = {
    candidate: candidateRow,
    score: score(),
    ro,
    overlay: null,
    application: parsedExperience,
    narrative,
    evals: {
      invest: {
        complement: "technician",
        head: "Work off the desk",
        removes: "desk load",
        vector: "unpriced",
        summary: "Materials on file.",
        ask: "—",
      },
      dig: null,
      verification: null,
      roleReads: reads,
      answerGrades: [],
      fitRead: null,
    },
    interviewEvidence: [],
    read: null,
    rank: 1,
    jobLocation: "Van Nuys, CA",
    jobShortcode: "JOB1",
    jobTitle: "Operator",
  };
  return mapCandidate(input);
}

function caseFileScope(candidate: Candidate, org: string): string {
  const markdown = renderWorkingFile(candidate, {}, { workableUrl: "https://example.test/candidate", disqualified: false });
  const row = markdown
    .split("\n")
    .filter((line) => line.startsWith("|") && !line.includes("---") && !line.includes("Period"))
    .map((line) => line.split("|").map((cell) => cell.trim()))
    .find((cells) => cells[2] === org);
  assert.ok(row, `case file is missing a row for ${org}\n${markdown}`);
  return row[5] ?? "";
}

function timelineScope(candidate: Candidate, org: string): { scope: string; lang: string; role: string } {
  const row = candidate.timeline.find((entry) => entry.type === "role" && entry.org === org);
  assert.ok(row, `timeline is missing ${org}`);
  return { scope: row.scope, lang: row.lang, role: row.role };
}

const openaiThenAi: ApplicantJob[] = [
  {
    title: "Director",
    company: "OpenAI",
    start: "2016-01-01",
    end: "2022-01-01",
    summary: STRONG_BULLET,
  },
  {
    title: "Analyst",
    company: "AI",
    start: "2024-06-01",
    current: true,
    summary: WEAK_BULLET,
  },
];

test("a short employer inside an earlier company name steals that job's write-up", async () => {
  const narratives = await narrativeFromApplication(openaiThenAi);
  const roleTexts = (segments: NarrativeSegment[]) =>
    segments.filter((segment) => segment.type === "role").map((segment) => segment.text);
  assert.deepEqual(roleTexts(narratives.ingest), ["Director at OpenAI", "Analyst at AI"]);
  assert.deepEqual(roleTexts(narratives.scored), roleTexts(narratives.ingest));

  const request = buildEvaluatorRequest(evaluatorInput(openaiThenAi));
  const prompt = JSON.stringify(request.messages);
  assert.ok(prompt.includes("OpenAI"));
  assert.ok(prompt.includes('\\"company\\": \\"AI\\"'));

  // Stored in the same order the application listed the jobs. "AI" is contained
  // in "OpenAI", so the first-hit eight-character check credits the thin job
  // with the earlier write-up.
  const reads = gradeWriteups(openaiThenAi, [
    { company: "OpenAI", role: "Director", read: STRONG_WRITEUP, level: "IV", stratum: "IV" },
    { company: "AI", role: "Analyst", read: WEAK_WRITEUP, level: "I", stratum: "I" },
  ]);
  assert.equal(reads[0]?.company, "OpenAI");
  assert.equal(reads[1]?.company, "AI");
  assert.equal(reads[0]?.read, STRONG_WRITEUP);

  const candidate = project(
    narratives.ingest,
    reads,
    null,
    { answers: null, cover_letter: null, parsed_experience: narratives.parsedExperience },
  );
  const thin = timelineScope(candidate, "AI");
  const strong = timelineScope(candidate, "OpenAI");

  assert.equal(strong.scope, STRONG_WRITEUP);
  assert.equal(strong.role, "Director");
  assert.equal(thin.role, "Analyst");
  assert.equal(thin.scope, WEAK_WRITEUP);
  assert.equal(thin.lang, "Reads I");
  assert.equal(caseFileScope(candidate, "AI"), WEAK_WRITEUP);
  assert.equal(caseFileScope(candidate, "OpenAI"), STRONG_WRITEUP);
});

test("an employer with no eligible write-up stays blank instead of taking the first partial hit", async () => {
  const narratives = await narrativeFromApplication(openaiThenAi);
  const reads = gradeWriteups(openaiThenAi, [
    { company: "OpenAI", role: "Director", read: STRONG_WRITEUP, level: "IV", stratum: "IV" },
  ]);
  const candidate = project(narratives.scored, reads, null, {
    answers: null,
    cover_letter: null,
    parsed_experience: narratives.parsedExperience,
  });

  assert.equal(timelineScope(candidate, "OpenAI").scope, STRONG_WRITEUP);
  assert.equal(timelineScope(candidate, "AI").scope, "—");
  assert.equal(timelineScope(candidate, "AI").lang, "—");
  assert.equal(caseFileScope(candidate, "AI"), "—");
});

test("the first eight characters of a different company are not a match", async () => {
  const jobs: ApplicantJob[] = [
    {
      title: "Director",
      company: "Acme Corporation",
      start: "2015-03-01",
      end: "2021-03-01",
      summary: STRONG_BULLET,
    },
    {
      title: "Clerk",
      company: "Acme Corp",
      start: "2024-01-01",
      current: true,
      summary: WEAK_BULLET,
    },
  ];
  const narratives = await narrativeFromApplication(jobs);
  const reads = gradeWriteups(jobs, [
    { company: "Acme Corporation", role: "Director", read: STRONG_WRITEUP, level: "IV" },
    { company: "Acme Corp", role: "Clerk", read: WEAK_WRITEUP, level: "I" },
  ]);
  const candidate = project(narratives.ingest, reads, null, {
    answers: null,
    cover_letter: null,
    parsed_experience: narratives.parsedExperience,
  });

  assert.equal(timelineScope(candidate, "Acme Corporation").scope, STRONG_WRITEUP);
  assert.equal(timelineScope(candidate, "Acme Corp").scope, WEAK_WRITEUP);
  assert.equal(caseFileScope(candidate, "Acme Corp"), WEAK_WRITEUP);
});

test("an exact normalized name wins even when a longer containing name is stored first", async () => {
  const jobs: ApplicantJob[] = [
    {
      title: "Director",
      company: "Acme Inc",
      start: "2014-01-01",
      end: "2020-01-01",
      summary: STRONG_BULLET,
    },
    {
      title: "Clerk",
      company: "Inc",
      start: "2025-01-01",
      current: true,
      summary: WEAK_BULLET,
    },
  ];
  const narratives = await narrativeFromApplication(jobs);
  const reads = gradeWriteups(jobs, [
    { company: "Acme Inc", role: "Director", read: STRONG_WRITEUP, level: "IV" },
    { company: "Inc", role: "Clerk", read: WEAK_WRITEUP, level: "I" },
  ]);
  const candidate = project(narratives.ingest, reads, null, {
    answers: null,
    cover_letter: null,
    parsed_experience: [],
  });

  assert.equal(timelineScope(candidate, "Inc").scope, WEAK_WRITEUP);
  assert.equal(timelineScope(candidate, "Acme Inc").scope, STRONG_WRITEUP);
  assert.equal(caseFileScope(candidate, "Inc"), WEAK_WRITEUP);
});

test("a token-bounded full name may use the longer company's write-up when nothing else matches", async () => {
  const jobs: ApplicantJob[] = [
    {
      title: "Director",
      company: "Acme International",
      start: "2012-01-01",
      end: "2020-01-01",
      summary: STRONG_BULLET,
    },
    {
      title: "Clerk",
      company: "Acme",
      start: "2024-04-01",
      current: true,
      summary: WEAK_BULLET,
    },
  ];
  const narratives = await narrativeFromApplication(jobs);
  const reads = gradeWriteups(jobs, [
    { company: "Acme International", role: "Director", read: STRONG_WRITEUP, level: "IV" },
  ]);
  const candidate = project(narratives.ingest, reads, null, {
    answers: null,
    cover_letter: null,
    parsed_experience: narratives.parsedExperience,
  });

  assert.equal(timelineScope(candidate, "Acme").scope, STRONG_WRITEUP);
  assert.equal(caseFileScope(candidate, "Acme"), STRONG_WRITEUP);
});

test("punctuation and case differences still match the same company", async () => {
  const jobs: ApplicantJob[] = [
    {
      title: "Director",
      company: "OpenAI Inc",
      start: "2018-01-01",
      end: "2023-01-01",
      summary: STRONG_BULLET,
    },
  ];
  const narratives = await narrativeFromApplication(jobs);
  const reads = gradeWriteups(jobs, [
    { company: "OpenAI, Inc.", role: "Director", read: STRONG_WRITEUP, level: "IV" },
  ]);
  const candidate = project(narratives.ingest, reads, null, {
    answers: null,
    cover_letter: null,
    parsed_experience: narratives.parsedExperience,
  });

  assert.equal(timelineScope(candidate, "OpenAI Inc").scope, STRONG_WRITEUP);
  assert.equal(caseFileScope(candidate, "OpenAI Inc"), STRONG_WRITEUP);
});

test("distinct employers keep their own write-ups", async () => {
  const jobs: ApplicantJob[] = [
    {
      title: "Director",
      company: "Initech",
      start: "2017-01-01",
      end: "2021-01-01",
      summary: STRONG_BULLET,
    },
    {
      title: "Analyst",
      company: "Hooli",
      start: "2023-01-01",
      current: true,
      summary: WEAK_BULLET,
    },
  ];
  const narratives = await narrativeFromApplication(jobs);
  const reads = gradeWriteups(jobs, [
    { company: "Initech", role: "Director", read: STRONG_WRITEUP, level: "IV" },
    { company: "Hooli", role: "Analyst", read: WEAK_WRITEUP, level: "I" },
  ]);
  const candidate = project(narratives.ingest, reads, null, {
    answers: null,
    cover_letter: null,
    parsed_experience: narratives.parsedExperience,
  });

  assert.equal(timelineScope(candidate, "Initech").scope, STRONG_WRITEUP);
  assert.equal(timelineScope(candidate, "Hooli").scope, WEAK_WRITEUP);
  assert.equal(caseFileScope(candidate, "Hooli"), WEAK_WRITEUP);
});

interface DossierExports {
  CandidateDossier?: (props: {
    wsApi: WorkspaceApi;
    activeId: string;
    openPool: () => void;
    stages: [];
  }) => ReactNode;
  default?: { CandidateDossier?: DossierExports["CandidateDossier"] };
}

async function loadDossier(): Promise<NonNullable<DossierExports["CandidateDossier"]>> {
  const loaded = (await import("../../components/triage/candidate-dossier.tsx")) as DossierExports;
  const component = loaded.CandidateDossier ?? loaded.default?.CandidateDossier;
  assert.ok(component, "CandidateDossier export missing");
  return component;
}

function renderDossier(component: NonNullable<DossierExports["CandidateDossier"]>, candidate: Candidate): string {
  const ws = {
    dq: {},
    ovr: {},
    replies: {},
    corrections: {},
    transcripts: {},
    deep: {},
    chat: {},
    activity: {},
    regen: {},
    process: {},
  };
  const wsApi = {
    ws,
    hydrated: true,
    busy: {},
    chatBusy: {},
    notice: null,
    clearNotice: () => {},
    sendChat: () => {},
    clearChat: () => {},
    toggleDq: () => {},
    bulkDq: () => {},
    setDqMany: () => {},
    openCount: 1,
    runDeep: () => {},
    setDecision: () => {},
    setProcessStatus: () => {},
    moveStage: () => {},
    sendToScreen: () => {},
    reanalyze: () => {},
    compareRubric: () => {},
    resync: () => {},
    effTimeline: () => candidate.timeline,
    editCell: () => {},
    addRow: () => {},
    removeRow: () => {},
    setReply: () => {},
    setTranscript: () => {},
    addCorrection: () => {},
    logActivity: () => {},
    updateAssessment: () => {},
  } as WorkspaceApi;
  const html = renderToStaticMarkup(
    // Provider declares children as a normal prop, so createElement's third argument does not type-check.
    // eslint-disable-next-line react/no-children-prop
    createElement(TriageDataProvider, {
      value: {
        candidates: [candidate],
        findCandidate: () => candidate,
        meta: {
          title: "Operator",
          jobShortcode: "JOB1",
          jobUrl: "https://example.test/job",
          healthState: "",
          healthRead: "",
          total: 1,
        },
        jobs: [],
        viewer: { label: "Reviewer", kind: "other" },
        rubricMd: "",
        specMd: "",
        stages: [],
      },
      children: createElement(component, {
        wsApi,
        activeId: candidate.id,
        openPool: () => {},
        stages: [],
      }),
    }),
  );
  return html;
}

function recordRows(html: string): string[][] {
  const table = html.split('id="record"')[1]?.split("</table>")[0] ?? "";
  return [...table.matchAll(/<tr[\s\S]*?<\/tr>/g)].map((match) =>
    [...match[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) =>
      cell[1].replace(/<[^>]+>/g, "").trim(),
    ),
  );
}

function recordAccomplishment(html: string, org: string): string {
  const row = recordRows(html).find((cells) => cells[1] === org);
  assert.ok(row, `dossier record is missing ${org}`);
  return row[4] ?? "";
}

test("the dossier record does not give one job another job's bullet through a short shared fragment", async () => {
  const CandidateDossier = await loadDossier();
  const jobs: ApplicantJob[] = [
    {
      title: "Director",
      company: "OpenAI",
      start: "2012-05-01",
      end: "2019-05-01",
      summary: STRONG_BULLET,
    },
    {
      title: "Producer",
      company: "BetaCo",
      start: "2020-02-01",
      end: "2022-02-01",
      summary: BETA_BULLET,
    },
    {
      title: "Analyst",
      company: "AI",
      start: "2024-06-01",
      current: true,
      summary: WEAK_BULLET,
    },
  ];
  const narratives = await narrativeFromApplication(jobs);
  const reads = gradeWriteups(jobs, [
    { company: "OpenAI", role: "Director", read: STRONG_WRITEUP, level: "IV", stratum: "IV" },
    { company: "BetaCo", role: "Producer", read: BETA_BULLET, level: "II", stratum: "II" },
    { company: "AI", role: "Analyst", read: WEAK_WRITEUP, level: "I", stratum: "I" },
  ]);
  const candidate = project(
    narratives.ingest,
    reads,
    roFromWriteups(reads, { OpenAI: "IV", BetaCo: "II", AI: "I" }),
    { answers: null, cover_letter: null, parsed_experience: narratives.parsedExperience },
  );
  const html = renderDossier(CandidateDossier, candidate);

  assert.equal(recordAccomplishment(html, "AI"), WEAK_BULLET);
  assert.equal(recordAccomplishment(html, "OpenAI"), STRONG_BULLET);
  assert.equal(recordAccomplishment(html, "BetaCo"), BETA_BULLET);
});

test("listing the short employer first does not copy its bullet onto the longer company", async () => {
  const CandidateDossier = await loadDossier();
  const jobs: ApplicantJob[] = [
    {
      title: "Analyst",
      company: "AI",
      start: "2024-06-01",
      current: true,
      summary: WEAK_BULLET,
    },
    {
      title: "Producer",
      company: "BetaCo",
      start: "2020-02-01",
      end: "2022-02-01",
      summary: BETA_BULLET,
    },
    {
      title: "Director",
      company: "OpenAI",
      start: "2012-05-01",
      end: "2019-05-01",
      summary: STRONG_BULLET,
    },
  ];
  const narratives = await narrativeFromApplication(jobs);
  const reads = gradeWriteups(jobs, [
    { company: "AI", role: "Analyst", read: WEAK_WRITEUP, level: "I", stratum: "I" },
    { company: "BetaCo", role: "Producer", read: BETA_BULLET, level: "II", stratum: "II" },
    { company: "OpenAI", role: "Director", read: STRONG_WRITEUP, level: "IV", stratum: "IV" },
  ]);
  const candidate = project(
    narratives.ingest,
    reads,
    roFromWriteups(reads, { OpenAI: "IV", BetaCo: "II", AI: "I" }),
    { answers: null, cover_letter: null, parsed_experience: narratives.parsedExperience },
  );
  const html = renderDossier(CandidateDossier, candidate);
  assert.equal(recordAccomplishment(html, "OpenAI"), STRONG_BULLET);
  assert.equal(recordAccomplishment(html, "AI"), WEAK_BULLET);
});

test("the requisite chart dates a job from its own résumé period, not a fragment match", async () => {
  const CandidateDossier = await loadDossier();
  const jobs: ApplicantJob[] = [
    {
      title: "Analyst",
      company: "AI",
      start: "2024-06-01",
      current: true,
      summary: WEAK_BULLET,
    },
    {
      title: "Producer",
      company: "BetaCo",
      start: "2020-02-01",
      end: "2022-02-01",
      summary: BETA_BULLET,
    },
    {
      title: "Director",
      company: "OpenAI",
      start: "2012-05-01",
      end: "2019-05-01",
      summary: STRONG_BULLET,
    },
  ];
  const narratives = await narrativeFromApplication(jobs);
  const reads = gradeWriteups(jobs, [
    { company: "AI", role: "Analyst", read: WEAK_WRITEUP, level: "I", stratum: "I" },
    { company: "BetaCo", role: "Producer", read: BETA_BULLET, level: "II", stratum: "II" },
    { company: "OpenAI", role: "Director", read: STRONG_WRITEUP, level: "IV", stratum: "IV" },
  ]);
  const candidate = project(
    narratives.ingest,
    reads,
    roFromWriteups(reads, { OpenAI: "IV", BetaCo: "II", AI: "I" }),
    { answers: null, cover_letter: null, parsed_experience: narratives.parsedExperience },
  );
  const html = renderDossier(CandidateDossier, candidate);
  const svg = html.split('aria-label="RO capability over time"')[1]?.split("</svg>")[0] ?? "";
  const labels = [...svg.matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map((match) => match[1]);
  const orgs = labels.filter((label) => label === "BetaCo" || label === "AI" || label === "OpenAI");
  assert.deepEqual(orgs, ["OpenAI", "BetaCo", "AI"]);
});

test("with no career chart and no résumé roles, the dossier shows the matched write-up and not a partial hit", async () => {
  const CandidateDossier = await loadDossier();
  const narratives = await narrativeFromApplication(openaiThenAi);
  const reads = gradeWriteups(openaiThenAi, [
    { company: "OpenAI", role: "Director", read: STRONG_WRITEUP, level: "IV", stratum: "IV" },
    { company: "AI", role: "Analyst", read: WEAK_WRITEUP, level: "I", stratum: "I" },
  ]);
  const candidate = project(narratives.ingest, reads, null, {
    answers: null,
    cover_letter: null,
    parsed_experience: [],
  });
  assert.equal(candidate.resume.roles.length, 0);
  assert.equal(candidate.careerProgression, undefined);

  const html = renderDossier(CandidateDossier, candidate);
  assert.equal(recordAccomplishment(html, "AI"), WEAK_WRITEUP);
  assert.equal(recordAccomplishment(html, "OpenAI"), STRONG_WRITEUP);
});

test("resume rows with no career chart keep each employer's own bullet", async () => {
  const CandidateDossier = await loadDossier();
  const narratives = await narrativeFromApplication(openaiThenAi);
  const candidate = project(narratives.ingest, [], null, {
    answers: null,
    cover_letter: null,
    parsed_experience: narratives.parsedExperience,
  });
  const html = renderDossier(CandidateDossier, candidate);
  assert.equal(recordAccomplishment(html, "AI"), WEAK_BULLET);
  assert.equal(recordAccomplishment(html, "OpenAI"), STRONG_BULLET);
});
