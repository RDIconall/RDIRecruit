import { hasSupabase, hasWorkable } from "../env";
import { fetchEvaluations, fetchOverlays, poolLineFromBoard } from "./overlay";
import { fetchScoresForCandidates, getBoardFromSupabase, getPoolStatsForJob } from "./board-queries";
import { listCandidates as listWorkableCandidates } from "../workable/client";
import { getServiceSupabase } from "../supabase/server";
import type { WorkableCandidate } from "../workable/client";
import { INTERVIEW_EVIDENCE_TYPES } from "../sync/candidate-hash";
import type {
  BoardCandidate,
  CandidateRow,
  EvidenceRow,
  NarrativeSegment,
  RoAssessmentRow,
  ScoreInputRow,
  ScoreRow,
} from "../types";
import type { ParsedResumeReview } from "../resume/types";

function workableToCandidateRow(
  candidate: WorkableCandidate,
  jobShortcode: string,
): CandidateRow {
  return {
    workable_id: candidate.id,
    job_shortcode: jobShortcode,
    name: candidate.name,
    email: candidate.email,
    phone: candidate.phone,
    location: candidate.address,
    stage: candidate.stage,
    stage_kind: null,
    disqualified: candidate.disqualified,
    source: candidate.sourced ? "sourced" : "applied",
    assignee_id: null,
    raw: candidate as unknown as Record<string, unknown>,
    photo_url:
      typeof candidate.image_url === "string" && candidate.image_url.startsWith("http")
        ? candidate.image_url
        : null,
    created_at: candidate.created_at,
    synced_at: new Date().toISOString(),
  };
}

function isNewCandidate(createdAt: string | null): boolean {
  if (!createdAt) return false;
  const created = new Date(createdAt).getTime();
  return Date.now() - created < 7 * 24 * 60 * 60 * 1000;
}

export const DEMO_BOARD: BoardCandidate[] = [
  {
    candidate: {
      workable_id: "demo-1",
      job_shortcode: "EA-001",
      name: "Jordan Lee",
      email: "jordan@example.com",
      phone: "",
      location: "Los Angeles, CA",
      stage: "Applied",
      stage_kind: "applied",
      disqualified: false,
      source: "applied",
      assignee_id: null,
      raw: null,
      photo_url: null,
      created_at: new Date(Date.now() - 2 * 86400000).toISOString(),
      synced_at: new Date().toISOString(),
    },
    score: {
      id: "score-demo-1",
      candidate_id: "demo-1",
      rubric_version: 1,
      category_scores: { principal: 22, environment: 17, scope: 18, writing: 12, tenure: 8, local: 9 },
      total: 86,
      salary_value: "great value",
      confidence: "high",
      model_version: "claude-sonnet-4-6",
      created_at: new Date().toISOString(),
    },
    ro: {
      id: "ro-demo-1",
      candidate_id: "demo-1",
      per_role: [{
        role: "Executive Assistant", company: "NaviMed Capital", years: 4.2,
        stratum: "IIa", stratum_range: "IIa",
        verbs: { I: [], II: ["managed", "anticipated"], III: ["built"] },
      }],
      seat_stratum: "IIb-IIa", current_capability: "IIa",
      trajectory: "grows-the-role", text_confidence: "confirmed", basis: "reasoning",
      created_at: new Date().toISOString(),
    },
  },
  {
    candidate: {
      workable_id: "demo-2",
      job_shortcode: "EA-001",
      name: "Alex Morgan",
      email: "alex@example.com",
      phone: "",
      location: "Remote — Austin, TX",
      stage: "Async interview",
      stage_kind: "assessment",
      disqualified: false,
      source: "applied",
      assignee_id: null,
      raw: null,
      photo_url: null,
      created_at: new Date(Date.now() - 20 * 86400000).toISOString(),
      synced_at: new Date().toISOString(),
    },
    score: {
      id: "score-demo-2",
      candidate_id: "demo-2",
      rubric_version: 1,
      category_scores: { principal: 18, environment: 14, scope: 12, writing: 8, tenure: 6, local: 5 },
      total: 63,
      salary_value: "rich for fit",
      confidence: "text-unreliable",
      model_version: "claude-sonnet-4-6",
      created_at: new Date().toISOString(),
    },
    ro: {
      id: "ro-demo-2",
      candidate_id: "demo-2",
      per_role: [{
        role: "Operations Coordinator", company: "BrightPath", years: 1.5,
        stratum: "IIb", stratum_range: "IIb",
        verbs: { I: ["processed"], II: ["managed"], III: [] },
      }],
      seat_stratum: "IIb-IIa", current_capability: "IIb",
      trajectory: "plateaued", text_confidence: "text-unreliable", basis: "role-and-tenure",
      created_at: new Date().toISOString(),
    },
  },
  {
    candidate: {
      workable_id: "demo-3",
      job_shortcode: "CTRL-002",
      name: "Sam Rivera",
      email: "sam@example.com",
      phone: "",
      location: "Los Angeles, CA",
      stage: "Phone screen",
      stage_kind: "screen",
      disqualified: false,
      source: "applied",
      assignee_id: null,
      raw: null,
      photo_url: null,
      created_at: new Date(Date.now() - 1 * 86400000).toISOString(),
      synced_at: new Date().toISOString(),
    },
    score: {
      id: "score-demo-3",
      candidate_id: "demo-3",
      rubric_version: 1,
      category_scores: { principal: 23, environment: 18, scope: 19, writing: 13, tenure: 9, local: 8 },
      total: 90,
      salary_value: "justified",
      confidence: "high",
      model_version: "claude-sonnet-4-6",
      created_at: new Date().toISOString(),
    },
    ro: null,
  },
];

export const DEMO_NARRATIVES: Record<string, NarrativeSegment[]> = {
  "demo-1": [
    { span: "2012 – 2016", type: "education", text: "BA Economics at UCLA" },
    { span: "2016 – 2018", type: "role", text: "Coordinator at Harbor Health" },
    { span: "2018 – 03/2019", type: "gap", text: "[~4 months between roles — likely job search]", assumption: true },
    { span: "2019 – present", type: "role", text: "Executive Assistant at NaviMed Capital" },
  ],
  "demo-2": [
    { span: "2018 – 2022", type: "education", text: "BS Business at UT Austin" },
    { span: "2022 – present", type: "role", text: "Operations Coordinator at BrightPath" },
  ],
};

export const DEMO_SCORE_INPUTS: Record<string, ScoreInputRow[]> = {
  "demo-1": [
    {
      id: "input-1", score_id: "score-demo-1", category: "scope",
      claim: "Built calendar and travel systems for a PE principal",
      source_type: "resume", source_ref: "resume:NaviMed bullet 3",
      quote: "Built executive scheduling system reducing conflicts by 40%",
      capture_kind: "text_card", capture_path: null,
      capture_locator: { kind: "pdf_region", page: 1 }, capture_status: "ready",
    },
  ],
  "demo-2": [
    {
      id: "input-3", score_id: "score-demo-2", category: "writing",
      claim: "Generic AI-style boilerplate in written answer",
      source_type: "answer", source_ref: "application:scenario-1",
      quote: "I maintain a positive working relationship and prevent recurrence.",
      capture_kind: "text_card", capture_path: null, capture_locator: null, capture_status: "ready",
    },
  ],
};

export async function fetchApplication(candidateId: string) {
  const { getServiceSupabase } = await import("../supabase/server");
  const { hasSupabase } = await import("../env");
  if (!hasSupabase()) return null;
  const supabase = getServiceSupabase();
  const { data } = await supabase
    .from("applications")
    .select("*")
    .eq("candidate_id", candidateId)
    .maybeSingle();
  return data as {
    resume_url: string | null;
    resume_parsed: ParsedResumeReview | null;
    resume_text: string | null;
    cover_letter: string | null;
    parsed_experience: unknown[] | null;
  } | null;
}

export async function getBoardCandidates(jobShortcode: string): Promise<BoardCandidate[]> {
  const cached = await getBoardFromSupabase(jobShortcode);
  if (cached?.length) return cached;

  if (hasWorkable()) {
    try {
      const workableCandidates = await listWorkableCandidates(jobShortcode, { limit: 100 });
      const scoreMap = await fetchScoresForCandidates(workableCandidates.map((c) => c.id));
      const overlayMap = await fetchOverlays(workableCandidates.map((c) => c.id));

      const board = workableCandidates.map((candidate) => {
        const meta = scoreMap.get(candidate.id);
        return {
          candidate: workableToCandidateRow(candidate, jobShortcode),
          score: meta?.score ?? null,
          ro: meta?.ro ?? null,
          overlay: overlayMap.get(candidate.id) ?? null,
        };
      });

      return board.sort((a, b) => {
        const aActive = !(a.overlay?.status === "disqualified" || a.overlay?.status === "withdrawn" || a.candidate.disqualified);
        const bActive = !(b.overlay?.status === "disqualified" || b.overlay?.status === "withdrawn" || b.candidate.disqualified);
        if (aActive !== bActive) return aActive ? -1 : 1;
        return (b.score?.total ?? -1) - (a.score?.total ?? -1);
      });
    } catch (error) {
      console.error("Workable board fetch failed", error);
    }
  }

  return DEMO_BOARD.filter((item) => item.candidate.job_shortcode === jobShortcode);
}

export async function getCandidateDetail(candidateId: string, jobShortcode?: string) {
  if (!hasSupabase() || candidateId.startsWith("demo-")) {
    const boardItem = DEMO_BOARD.find((item) => item.candidate.workable_id === candidateId);
    if (!boardItem) return null;
    const jobCode = jobShortcode ?? boardItem.candidate.job_shortcode ?? "EA-001";
    const board = DEMO_BOARD.filter((i) => i.candidate.job_shortcode === jobCode);
    return {
      ...boardItem,
      narrative: DEMO_NARRATIVES[candidateId] ?? [],
      scoreInputs: DEMO_SCORE_INPUTS[candidateId] ?? [],
      overlay: null,
      evaluations: [],
      interviewEvidence: [] as EvidenceRow[],
      poolLine: poolLineFromBoard(board, new Map()),
      workable: null,
      application: null,
    };
  }

  const supabase = getServiceSupabase();
  const { data: candidate } = await supabase
    .from("candidates")
    .select("*")
    .eq("workable_id", candidateId)
    .single();

  if (!candidate) return null;

  const jobCode = (candidate as CandidateRow).job_shortcode ?? jobShortcode;
  const scoreMap = await fetchScoresForCandidates([candidateId]);
  const meta = scoreMap.get(candidateId);
  const score = meta?.score ?? null;

  const [overlayMap, evaluations, narrativeResult, application, poolStats, evidenceResult] =
    await Promise.all([
      fetchOverlays([candidateId]),
      fetchEvaluations(candidateId),
      supabase
        .from("narratives")
        .select("*")
        .eq("candidate_id", candidateId)
        .order("generated_at", { ascending: false })
        .limit(1),
      fetchApplication(candidateId),
      jobCode ? getPoolStatsForJob(jobCode) : Promise.resolve({ poolLine: "" }),
      supabase
        .from("evidence")
        .select("*")
        .eq("candidate_id", candidateId)
        .in("source_type", [...INTERVIEW_EVIDENCE_TYPES])
        .order("captured_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false }),
    ]);

  const interviewEvidence = (evidenceResult.data ?? []) as EvidenceRow[];

  let scoreInputs: ScoreInputRow[] = [];
  if (score) {
    const { data: inputs } = await supabase
      .from("score_inputs")
      .select("*")
      .eq("score_id", score.id);
    scoreInputs = (inputs ?? []) as ScoreInputRow[];
  }

  const { workableFromRaw } = await import("./workable-cache");

  return {
    candidate: candidate as CandidateRow,
    score,
    ro: meta?.ro ?? null,
    narrative: (narrativeResult.data?.[0]?.segments as NarrativeSegment[] | undefined) ?? [],
    scoreInputs,
    overlay: overlayMap.get(candidateId) ?? null,
    evaluations,
    interviewEvidence,
    poolLine: poolStats.poolLine,
    workable: workableFromRaw((candidate as CandidateRow).raw),
    application,
  };
}

export { isNewCandidate };
