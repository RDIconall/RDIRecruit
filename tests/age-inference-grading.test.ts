import assert from "node:assert/strict";
import Module from "node:module";
import { register } from "node:module";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { startMemoryApi } from "./helpers/memory-api.ts";

// tsx loads these tests as CommonJS, so `server-only`'s throw runs through
// require(). The package's server export is an empty module; match that.
const moduleLoader = Module as unknown as {
  prototype: { require: (this: unknown, id: string) => unknown };
};
const originalRequire = moduleLoader.prototype.require;
moduleLoader.prototype.require = function (id: string) {
  if (id === "server-only") return {};
  return originalRequire.call(this, id);
};

// env.ts reads process.env once, on first import. The server and the
// server-only hook are installed in before(), and the product modules are
// imported only after that.
let apiUrl = "";
let closeApi: () => Promise<void> = async () => {};
let memoryRows: (table: string) => Array<Record<string, unknown>> = () => [];

const JOB = "LAB01";
const YEAR = new Date().getFullYear();

type Captured = {
  id: string;
  graduationYear: number;
  userPrompt: string;
  systemPrompt: string;
  snapshot: Record<string, unknown> | null;
  decision: string | null;
};

const captured: Captured[] = [];
let batchBody = "";

const originalFetch = globalThis.fetch.bind(globalThis);

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

async function requestText(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
  const body = init?.body;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  if (typeof Request !== "undefined" && input instanceof Request) return input.clone().text();
  return "";
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A stand-in for the model that follows only the maturation-placement sentence
 * the grader writes. Career span and the graduation year are ignored, so a
 * decision change is caused by the inferred age. With that sentence gone, every
 * applicant gets the same hold read.
 */
function modelRead(userPrompt: string): string {
  const age = Number(userPrompt.match(/puts them at roughly (\d+) now/)?.[1] ?? NaN);
  const placedYoung = Number.isFinite(age) && age < 34;
  const verdict = placedYoung ? "strong_seat" : "hold";
  const personQuality = placedYoung ? "high" : "solid";
  const total = placedYoung ? 90 : 64;
  return JSON.stringify({
    rubricSchemaVersion: "legacy-v1",
    personQuality,
    seatFit: {
      appliedSeat: "Laboratory Coordinator",
      verdict,
      score: total,
      summary: placedYoung ? "Placed high on the curve." : "Hold for more evidence.",
    },
    evidenceConfidence: "medium",
    integrityGate: { status: "clear", note: "" },
    otherGateResults: [],
    complement: "technician",
    complementRemoves: "sample accessioning",
    salaryVector: "priced about right",
    investHead: "Work off the desk",
    summary: placedYoung ? "Clears the seat on the maturation read." : "Holds at the current span.",
    categoryScores: { principal: 10, environment: 10, scope: 10, writing: 8, tenure: 6, local: 6 },
    confidence: "medium",
    salaryValue: "justified",
    salaryAsk: "$90000",
    seatStratum: "IIb–IIa",
    currentCapability: "II",
    trajectory: placedYoung ? "grows-the-role" : "plateaued",
    textConfidence: "confirmed",
    basis: "reasoning",
    aiLikelihood: 0.1,
    roReads: [],
    digIn: {
      quality: "OK",
      mix: "one owned answer",
      integrity: "Clear",
      integrityNote: "",
      careerRead: "Career read.",
      resolve: [],
    },
    verification: { read: "Clean", claims: [] },
    answerGrades: [
      {
        question: "Describe a process you owned.",
        verdict: "OWNED",
        note: "They owned accessioning.",
        kind: "screen",
      },
    ],
    triage: {
      why: placedYoung ? "Maturation placement clears an interview." : "Maturation placement holds them.",
      risk: "Confirm the chronology live.",
    },
    claims: [],
  });
}

function messageFrom(userPrompt: string) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    stop_reason: "end_turn",
    stop_sequence: null,
    content: [{ type: "text", text: modelRead(userPrompt) }],
    usage: { input_tokens: 20, output_tokens: 40 },
  };
}

globalThis.fetch = async (input, init) => {
  const url = requestUrl(input);
  if (apiUrl && url.startsWith(apiUrl)) return originalFetch(input, init);

  if (url.includes(".workable.com/")) {
    const parsed = new URL(url);
    if (parsed.pathname.includes("/activities")) {
      return jsonResponse({ activities: [] });
    }
    const candidateMatch = parsed.pathname.match(/\/candidates\/([^/]+)$/);
    if (candidateMatch) {
      const candidate = workableCandidates.get(decodeURIComponent(candidateMatch[1]));
      if (!candidate) return jsonResponse({ error: "missing candidate" }, 404);
      return jsonResponse({ candidate });
    }
    if (parsed.pathname.endsWith(".txt")) {
      const text =
        "Laboratory associate. Owned sample accessioning, chain of custody, and data review for IVD studies.";
      return new Response(text, { status: 200, headers: { "content-type": "text/plain" } });
    }
    return jsonResponse({ error: `unhandled workable ${parsed.pathname}` }, 404);
  }

  if (url.startsWith("https://api.anthropic.com/")) {
    const body = await requestText(input, init);
    if (url.endsWith("/v1/messages")) {
      const request = JSON.parse(body) as {
        system?: Array<{ text?: string }>;
        messages?: Array<{ content?: string }>;
      };
      const userPrompt = request.messages?.[0]?.content ?? "";
      return jsonResponse(messageFrom(userPrompt));
    }
    if (url.endsWith("/v1/messages/batches") && (init?.method ?? "GET") !== "GET") {
      batchBody = body;
      return jsonResponse({
        id: "msgbatch_test",
        type: "message_batch",
        processing_status: "in_progress",
        request_counts: { processing: 1, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        ended_at: null,
        results_url: "",
      });
    }
    if (url.includes("/v1/messages/batches/")) {
      return jsonResponse({
        id: "msgbatch_test",
        type: "message_batch",
        processing_status: "in_progress",
        request_counts: { processing: 1, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
        ended_at: null,
      });
    }
    return jsonResponse({ error: `unhandled anthropic ${url}` }, 404);
  }

  throw new Error(`Refusing unexpected network request ${url}`);
};

type WorkableCandidate = Record<string, unknown>;
const workableCandidates = new Map<string, WorkableCandidate>();

function applicant(input: {
  id: string;
  degree: string;
  end?: string;
  start?: string;
  roleStart: string;
  resume?: boolean;
}): WorkableCandidate {
  const candidate = {
    id: input.id,
    name: `Applicant ${input.id}`,
    firstname: "Applicant",
    lastname: input.id,
    headline: "Laboratory associate",
    account: { subdomain: "rditrials", name: "RDI" },
    job: { shortcode: JOB, title: "Laboratory Coordinator" },
    stage: "Applied",
    disqualified: false,
    disqualification_reason: null,
    hired_at: null,
    sourced: false,
    profile_url: `https://rditrials.workable.com/backend/jobs/${JOB}/candidates/${input.id}`,
    address: "Los Angeles, CA",
    phone: "555-0100",
    email: `${input.id}@example.com`,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-02T00:00:00Z",
    resume_url: input.resume ? `https://rditrials.workable.com/uploads/${input.id}.txt` : undefined,
    education_entries: [
      {
        school: "Example University",
        degree: input.degree,
        field_of_study: "Biology",
        start_date: input.start ?? "",
        end_date: input.end ?? "",
      },
    ],
    experience_entries: [
      {
        title: "Laboratory Associate",
        company: "Example Labs",
        industry: "Diagnostics",
        start_date: input.roleStart,
        end_date: "",
        summary: "Owned accessioning and sample chain of custody.",
        current: true,
      },
    ],
    answers: [
      {
        question: { body: "Describe a process you owned." },
        answer: { body: "I built the accessioning checklist and ran it for a year." },
      },
    ],
  };
  workableCandidates.set(input.id, candidate);
  return candidate;
}

function promptsOf(body: string): string[] {
  const parsed = JSON.parse(body) as {
    requests?: Array<{ params?: { messages?: Array<{ content?: string }>; system?: Array<{ text?: string }> } }>;
  };
  return (parsed.requests ?? []).map((request) => {
    const user = request.params?.messages?.[0]?.content ?? "";
    const system = (request.params?.system ?? []).map((block) => block.text ?? "").join("\n");
    return `${system}\n${user}`;
  });
}

function ageFor(graduationYear: number): number {
  return 22 + (YEAR - graduationYear);
}

function assertNoInferredAge(text: string, graduationYear: number) {
  const age = ageFor(graduationYear);
  const ageLine = text.match(/MATURATION PLACEMENT[\s\S]{0,500}/)?.[0] ?? "";
  assert.equal(text.includes(`puts them at roughly ${age}`), false, ageLine || `${graduationYear} inferred ${age}`);
  assert.equal(text.includes("MATURATION PLACEMENT"), false, ageLine);
  assert.equal(/at undergraduate graduation/i.test(text), false, ageLine);
  assert.equal(/approxCurrentAge|assumedGradAge/.test(text), false);
  assert.equal(text.includes("years of career"), true);
}

before(async () => {
  const api = await startMemoryApi();
  apiUrl = api.url;
  closeApi = api.close;
  memoryRows = api.rows;
  process.env.SUPABASE_URL = api.url;
  process.env.SUPABASE_SERVICE_KEY = "test-service-key";
  process.env.WORKABLE_TOKEN = "test-workable-token";
  process.env.WORKABLE_SUBDOMAIN = "rditrials";
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  delete process.env.WORKABLE_WEBHOOK_SECRET;
  delete process.env.CLAUDE_MODEL_JUDGMENT;
  register(
    pathToFileURL(path.join(process.cwd(), "tests/helpers/server-only-hook.mjs")).href,
    pathToFileURL(`${process.cwd()}/`),
  );

  api.rows("jobs").push({
    shortcode: JOB,
    title: "Laboratory Coordinator",
    department: "Clinical",
    location: "Van Nuys, CA",
    status: "published",
    raw: {
      full_description:
        "<p>Coordinate sample accessioning, chain of custody, and data review for IVD studies. The seat takes operational lab work off the founder.</p>",
    },
  });

  const cases = [
    applicant({ id: "straight-2020", degree: "Bachelor of Science", end: "2020-05-31", roleStart: "2020-06-01" }),
    applicant({ id: "straight-2008", degree: "B.S.", end: "2008-05-31", roleStart: "2008-06-01" }),
    applicant({ id: "masters-2015", degree: "Master of Science", end: "2015-05-31", roleStart: "2015-06-01" }),
    applicant({
      id: "start-only-2018",
      degree: "Bachelor of Arts",
      start: "2018-09-01",
      roleStart: "2022-06-01",
    }),
    applicant({
      id: "resume-2019",
      degree: "B.S. Biology",
      end: "2019-05-31",
      roleStart: "2019-06-01",
      resume: true,
    }),
  ];
  const graduationYearById: Record<string, number> = {
    "straight-2020": 2020,
    "straight-2008": 2008,
    "masters-2015": 2015,
    "start-only-2018": 2018,
    "resume-2019": 2019,
  };

  const { POST } = await import("../src/app/api/hooks/workable/route.ts");
  const { NextRequest } = await import("next/server");
  const { rescoreCandidateOnNewEvidence } = await import("../src/lib/sync/rescore.ts");
  const { batchRequestForAnalysis } = await import("../src/lib/analysis/batch-request.ts");
  const { buildEvaluatorRequest } = await import("../src/lib/scoring/evaluator.ts");
  const { processCanonicalAnalysisBatches } = await import("../src/lib/analysis/batch.ts");
  const { loadLatestFitRead } = await import("../src/lib/triage/fit-read.ts");
  const { deriveDecisionDetail } = await import("../src/lib/triage/from-supabase.ts");

  for (const candidate of cases) {
    const response = await POST(
      new NextRequest("http://localhost/api/hooks/workable", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: `evt-${candidate.id}`,
          event_type: "candidate_created",
          data: { id: candidate.id, job: { shortcode: JOB } },
        }),
      }),
    );
    assert.equal(response.status, 200, await response.text());
  }

  const resumeRow = memoryRows("applications").find((row) => row.candidate_id === "resume-2019");
  const parsed = resumeRow?.resume_parsed as { education?: Array<{ end?: string | null }> } | undefined;
  assert.equal(parsed?.education?.[0]?.end?.slice(0, 4), "2019");

  const analyses = memoryRows("candidate_analyses");
  for (const row of analyses) {
    const id = String(row.candidate_id);
    const snapshot = row.input_snapshot as Record<string, unknown>;
    const request = batchRequestForAnalysis({
      id: String(row.id),
      input_snapshot: snapshot as never,
      attempt_count: 0,
    });
    const params = request.params as unknown as {
      messages: Array<{ content: string }>;
      system: Array<{ text: string }>;
    };
    const userPrompt = params.messages[0].content;
    const systemPrompt = params.system.map((block) => block.text).join("\n");
    const hardened = buildEvaluatorRequest(snapshot as never, true);
    const hardenedUser = hardened.messages[0].content;
    captured.push({
      id,
      graduationYear: graduationYearById[id],
      userPrompt: `${userPrompt}\n${typeof hardenedUser === "string" ? hardenedUser : ""}`,
      systemPrompt,
      snapshot,
      decision: null,
    });
  }

  for (const id of ["straight-2020", "straight-2008"]) {
    const result = await rescoreCandidateOnNewEvidence(id, "manual", { immediate: true });
    assert.equal(result.scored, true, JSON.stringify(result.result));
    const fit = await loadLatestFitRead(id);
    assert.ok(fit, `${id} did not store a fit read`);
    const decision = deriveDecisionDetail({
      candidate: {
        workable_id: id,
        name: id,
        email: null,
        phone: null,
        location: null,
        stage: "Applied",
        disqualified: false,
        photo_url: null,
        raw: {},
        created_at: "2026-11-01T00:00:00Z",
      } as never,
      score: null,
      ro: null,
      overlay: { status: "active" } as never,
      application: { answers: {}, cover_letter: null, parsed_experience: [] },
      narrative: [],
      evals: {
        invest: null,
        dig: null,
        verification: null,
        roleReads: [],
        answerGrades: [],
        fitRead: fit,
      },
      interviewEvidence: [],
      read: null,
      rank: 0,
      jobLocation: "Van Nuys, CA",
      jobShortcode: JOB,
    }).decision;
    const entry = captured.find((item) => item.id === id);
    assert.ok(entry);
    entry.decision = decision;
  }

  await processCanonicalAnalysisBatches();
});

after(async () => {
  globalThis.fetch = originalFetch;
  moduleLoader.prototype.require = originalRequire;
  await closeApi();
});

test("a public application's graduation year is not turned into an age in the grading prompt", () => {
  assert.deepEqual(
    captured.map((entry) => entry.id).sort(),
    ["masters-2015", "resume-2019", "start-only-2018", "straight-2008", "straight-2020"],
  );
  for (const entry of captured) {
    assertNoInferredAge(`${entry.systemPrompt}\n${entry.userPrompt}`, entry.graduationYear);
  }
});

test("the analysis row does not keep the inferred age", () => {
  for (const entry of captured) {
    const context = (entry.snapshot?.careerContext ?? {}) as Record<string, unknown>;
    assert.equal(Object.hasOwn(context, "approxCurrentAge"), false, entry.id);
    assert.equal(Object.hasOwn(context, "assumedGradAge"), false, entry.id);
    const years = context.yearsOfCareer;
    assert.equal(typeof years, "number");
    assert.ok((years as number) >= 0);
  }
});

test("the provider batch is sent without an inferred age", () => {
  assert.ok(batchBody.length > 0, "automatic scoring never submitted a provider batch");
  const prompts = promptsOf(batchBody);
  assert.ok(prompts.length >= 1);
  for (const prompt of prompts) {
    const ageLine = prompt.match(/MATURATION PLACEMENT[\s\S]{0,280}/)?.[0] ?? "";
    assert.equal(prompt.includes("MATURATION PLACEMENT"), false, ageLine);
    assert.equal(/puts them at roughly \d+/.test(prompt), false, ageLine);
    assert.equal(prompt.includes("years of career"), true);
  }
});

test("two straight-through applicants with the same kind of degree do not get different interview calls from an inferred age", () => {
  const younger = captured.find((entry) => entry.id === "straight-2020");
  const older = captured.find((entry) => entry.id === "straight-2008");
  assert.ok(younger?.decision);
  assert.ok(older?.decision);
  assert.equal(younger.decision, older.decision);
});
