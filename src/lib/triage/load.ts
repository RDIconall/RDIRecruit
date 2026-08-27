import "server-only";
import { hasSupabase, hasWorkable } from "../env";
import { getServiceSupabase } from "../supabase/server";
import { getBoardFromSupabase, getBoardFromSupabaseForJobs } from "../data/board-queries";
import { RECENT_MINIMUM, RECENT_WINDOW_DAYS, selectRecentApplicants } from "../data/recent";
import { chunkIds } from "../data/chunk";
import { getPublishedJobs, getJobByShortcode } from "../jobs/service";
import { wbJob } from "../workable/links";
import { getJobRubric } from "../rubric/store";
import type { WorkspaceSlice } from "./types";
import { INTERVIEW_EVIDENCE_TYPES } from "../sync/candidate-hash";
import type {
  AnswerGradePayload,
  BoardCandidate,
  DigInPayload,
  EvidenceRow,
  InvestPayload,
  NarrativeSegment,
  RoleReadPayload,
  VerificationPayload,
} from "../types";
import type { ActivityEntry, Candidate, DecisionRead, JobOption, PoolMeta, Workspace } from "./types";
import { mapCandidate, type ApplicationLite, type CandidateEvaluations, type ParsedExperienceEntry } from "./from-supabase";
import { getWorkingFiles } from "./store";
import { assignPoolStanding } from "./ranking";
import { computeReadiness, type GradingInputs } from "./readiness";
import { getMethodDoc } from "../evaluation/method";
import type { Decision } from "./types";
import { buildStageColumns, FALLBACK_STAGES, type StageColumn } from "./stages";

export const DEFAULT_JOB_SHORTCODE = "379AA16E8F"; // Clinical Data Manager — Data Integrity & Investigation
/** Pseudo-shortcode: load inbox candidates across every published job. */
export const CROSS_ROLE_SHORTCODE = "all";

export interface TriagePool {
  candidates: Candidate[];
  workspace: Workspace;
  meta: PoolMeta;
  jobs: JobOption[];
  configured: boolean;
  /** The job's editable grading rubric (markdown) — empty when none is set. */
  rubricMd: string;
  /** The job's role spec / description (markdown) — seeded from Workable when empty. */
  specMd: string;
  /** Workable pipeline stages for this job (kanban columns). */
  stages: StageColumn[];
  /** True when this pool spans every published job (cross-role inbox). */
  crossRole?: boolean;
}

function emptyWorkspace(): Workspace {
  return { dq: {}, ovr: {}, replies: {}, corrections: {}, transcripts: {}, deep: {}, chat: {}, activity: {}, regen: {}, process: {} };
}

type ActivityRow = { id: string; candidate_id: string; type: string | null; author: string | null; body: string; created_at: string };

function toActivityEntry(r: ActivityRow): ActivityEntry {
  const type = r.type === "interview" || r.type === "comment" ? r.type : "note";
  return { id: r.id, type, author: r.author || "—", body: r.body, at: r.created_at };
}

async function loadJobStages(jobShortcode: string): Promise<StageColumn[]> {
  if (!hasWorkable()) return FALLBACK_STAGES;
  try {
    const { listStages } = await import("../workable/client");
    const stages = await listStages(jobShortcode);
    if (!stages?.length) return FALLBACK_STAGES;
    return buildStageColumns(stages);
  } catch (error) {
    console.warn(`Failed to load Workable stages for ${jobShortcode}`, error);
    return FALLBACK_STAGES;
  }
}

function emptyPool(
  jobShortcode: string,
  jobs: JobOption[],
  title: string,
  rubric: { rubricMd: string; specMd: string } = { rubricMd: "", specMd: "" },
  stages: StageColumn[] = FALLBACK_STAGES,
): TriagePool {
  return {
    candidates: [],
    workspace: emptyWorkspace(),
    jobs,
    configured: hasSupabase(),
    rubricMd: rubric.rubricMd,
    specMd: rubric.specMd,
    stages,
    meta: {
      title,
      jobShortcode,
      jobUrl: wbJob(jobShortcode),
      healthState: hasSupabase() ? "No candidates" : "Not connected",
      healthRead: hasSupabase()
        ? "No candidates synced for this job yet."
        : "Supabase is not configured in this environment, so no live candidates can load.",
      total: 0,
    },
  };
}

type EvalRow = { candidate_id: string; kind: string; payload: Record<string, unknown>; created_at: string };

/**
 * Fetch ALL evaluation rows for a set of candidates, paging past PostgREST's
 * default 1000-row response cap. A busy job (100+ candidates × ~12 eval rows
 * each) easily exceeds 1000 rows; a single `.in(...)` select silently truncates,
 * which drops some candidates' invest_head entirely and makes them render
 * "Review blocked" even though they have a full score + evaluation on file.
 * Stable ordering (candidate_id, created_at, id) keeps the pages non-overlapping.
 */
async function fetchEvaluationsPaged(
  supabase: ReturnType<typeof getServiceSupabase>,
  ids: string[],
): Promise<EvalRow[]> {
  const PAGE = 1000;
  const out: EvalRow[] = [];
  for (const batch of chunkIds(ids)) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("evaluations")
        .select("candidate_id, kind, payload, created_at, id")
        .in("candidate_id", batch)
        .order("candidate_id", { ascending: true })
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) {
        // Degrade: a candidate with no evaluations renders as "Review blocked",
        // which is far better than failing the whole pool page.
        console.error("Failed to load evaluations batch", error);
        break;
      }
      const rows = (data ?? []) as EvalRow[];
      out.push(...rows);
      if (rows.length < PAGE) break;
    }
  }
  return out;
}

/**
 * Same paging guard as fetchEvaluationsPaged, for the other per-candidate tables.
 * Without it a large pool silently loses the newest candidates' answers, résumé
 * text, and activity, so they render as "Review blocked" with nothing to read.
 */
async function fetchByCandidatePaged<T>(
  supabase: ReturnType<typeof getServiceSupabase>,
  table: string,
  columns: string,
  ids: string[],
  tieBreaker: string,
): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (const batch of chunkIds(ids)) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from(table)
        .select(columns)
        .in("candidate_id", batch)
        .order(tieBreaker, { ascending: false })
        .range(from, from + PAGE - 1);
      if (error) {
        console.error(`Failed to load ${table} batch`, error);
        break;
      }
      const rows = (data ?? []) as T[];
      out.push(...rows);
      if (rows.length < PAGE) break;
    }
  }
  return out;
}

function groupEvaluations(rows: EvalRow[]): Map<string, CandidateEvaluations> {
  const byCandidate = new Map<string, EvalRow[]>();
  for (const row of rows) {
    const list = byCandidate.get(row.candidate_id) ?? [];
    list.push(row);
    byCandidate.set(row.candidate_id, list);
  }

  const result = new Map<string, CandidateEvaluations>();
  for (const [id, list] of byCandidate) {
    const latest = (kind: string) =>
      list
        .filter((r) => r.kind === kind)
        .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))[0]?.payload ?? null;
    // Multi-row kinds (role_read, answer_grade) are inserted as one batch per
    // scoring run, so every row in a run shares a single created_at. Overlapping
    // runs can leave several batches behind; concatenating them repeats every
    // question/role in the UI. Keep only the newest batch.
    const latestBatch = (kind: string) => {
      const rows = list.filter((r) => r.kind === kind);
      if (!rows.length) return [];
      const newest = rows.reduce(
        (max, r) => ((r.created_at ?? "") > max ? (r.created_at ?? "") : max),
        "",
      );
      return rows.filter((r) => (r.created_at ?? "") === newest).map((r) => r.payload);
    };

    result.set(id, {
      invest: latest("invest_head") as unknown as InvestPayload | null,
      dig: latest("dig_in") as unknown as DigInPayload | null,
      verification: latest("verification") as unknown as VerificationPayload | null,
      roleReads: latestBatch("role_read") as unknown as RoleReadPayload[],
      answerGrades: latestBatch("answer_grade") as unknown as AnswerGradePayload[],
    });
  }
  return result;
}

function deriveMeta(candidates: Candidate[], jobShortcode: string, title: string): PoolMeta {
  const n = (d: Candidate["decision"]) => candidates.filter((c) => c.decision === d).length;
  const interview = n("interview");
  const backup = n("backup");
  const reject = n("reject");

  let healthState: string;
  if (interview > 0) healthState = "Has people to interview";
  else if (backup > 0) healthState = "Backups only, no clear interview";
  else healthState = "No one to interview yet";

  const healthRead =
    candidates.length === 0
      ? "No candidates synced for this job yet."
      : `${candidates.length} in pool · ${interview} to interview, ${backup} backup, ${reject} to reject. ` +
        (interview > 0
          ? `Work the interview list top-down (it's ranked), then clear the do-not-interview list.`
          : `No file clears the bar for a first interview yet — review the backups and keep recruiting.`);

  return {
    title,
    jobShortcode,
    jobUrl: wbJob(jobShortcode),
    healthState,
    healthRead,
    total: candidates.length,
  };
}

export interface OneCandidate {
  candidate: Candidate;
  slice: WorkspaceSlice;
  disqualified: boolean;
  workableUrl: string;
  jobShortcode: string;
}

/** Targeted load of a single candidate's mapped view model + persisted edits. */
export async function loadOneCandidate(candidateId: string): Promise<OneCandidate | null> {
  if (!hasSupabase()) return null;
  const supabase = getServiceSupabase();

  const { data: candidate } = await supabase
    .from("candidates")
    .select("*")
    .eq("workable_id", candidateId)
    .maybeSingle();
  if (!candidate) return null;

  const jobShortcode = (candidate.job_shortcode as string) ?? DEFAULT_JOB_SHORTCODE;

  const [scoreRes, roRes, overlayRes, appRes, narrRes, evalRes, evidenceRes, wfMap] = await Promise.all([
    supabase.from("scores").select("*").eq("candidate_id", candidateId).order("created_at", { ascending: false }).limit(1),
    supabase.from("ro_assessments").select("*").eq("candidate_id", candidateId).order("created_at", { ascending: false }).limit(1),
    supabase.from("candidate_overlay").select("*").eq("candidate_id", candidateId).maybeSingle(),
    supabase.from("applications").select("candidate_id, answers, cover_letter, parsed_experience, resume_text, resume_url").eq("candidate_id", candidateId).maybeSingle(),
    supabase.from("narratives").select("segments").eq("candidate_id", candidateId).order("generated_at", { ascending: false }).limit(1),
    supabase.from("evaluations").select("candidate_id, kind, payload, created_at").eq("candidate_id", candidateId),
    supabase.from("evidence").select("*").eq("candidate_id", candidateId).in("source_type", [...INTERVIEW_EVIDENCE_TYPES]),
    getWorkingFiles([candidateId]),
  ]);

  const overlay = (overlayRes.data as { status?: string; status_reason?: string | null; complement?: string | null; complement_removes?: string | null; salary_vector?: string | null } | null) ?? null;
  const evals = groupEvaluations((evalRes.data ?? []) as EvalRow[]).get(candidateId) ?? {
    invest: null,
    dig: null,
    verification: null,
    roleReads: [],
    answerGrades: [],
  };
  const wf = wfMap.get(candidateId);

  const candidateView = mapCandidate({
    candidate: candidate as Parameters<typeof mapCandidate>[0]["candidate"],
    score: (scoreRes.data?.[0] as Parameters<typeof mapCandidate>[0]["score"]) ?? null,
    ro: (roRes.data?.[0] as Parameters<typeof mapCandidate>[0]["ro"]) ?? null,
    overlay: overlay as Parameters<typeof mapCandidate>[0]["overlay"],
    application: (appRes.data as ApplicationLite | null) ?? null,
    narrative: ((narrRes.data?.[0]?.segments as NarrativeSegment[] | undefined) ?? []),
    evals,
    interviewEvidence: (evidenceRes.data ?? []) as EvidenceRow[],
    read: (wf?.read as DecisionRead | null) ?? null,
    corrections: wf?.workspace?.corrections ?? [],
    decisionOverride: wf?.workspace?.decisionOverride ?? null,
    processStatus: wf?.workspace?.processStatus ?? null,
    rank: 0,
    jobLocation: "Van Nuys, CA",
    jobShortcode,
  });

  const disqualified = overlay?.status === "disqualified" || Boolean((candidate as { disqualified?: boolean }).disqualified);

  return {
    candidate: candidateView,
    slice: wf?.workspace ?? {},
    disqualified,
    workableUrl: candidateView.workableUrl,
    jobShortcode,
  };
}

/** A compact, decision-vocabulary-safe summary of one pool candidate. */
export interface RosterEntry {
  id: string;
  name: string;
  role: string;
  company: string;
  decision: Decision;
  experience: string;
  roLevel: string;
  why: string;
}

/**
 * Load a lightweight roster of EVERY candidate in a job's pool so the war-room
 * chat can be aware of the rest of the pool (and Claude can then pull a fuller
 * record on demand). Reuses the board + mapCandidate so each entry's decision is
 * exactly what the board shows, but fetches only what the compact view needs
 * (no résumé text / cover letters / transcripts) and skips the Workable
 * job-metadata round-trips that loadTriagePool does. Returns [] when Supabase is
 * not configured or the pool is empty. Optionally excludes one candidate id.
 */
export async function loadPoolRoster(jobShortcode: string, excludeId?: string): Promise<RosterEntry[]> {
  if (!hasSupabase()) return [];
  const board = await getBoardFromSupabase(jobShortcode);
  if (!board?.length) return [];

  const ids = board.map((b) => b.candidate.workable_id);
  const supabase = getServiceSupabase();

  const [appsRes, evalRows, workingFiles] = await Promise.all([
    supabase.from("applications").select("candidate_id, parsed_experience").in("candidate_id", ids),
    fetchEvaluationsPaged(supabase, ids),
    getWorkingFiles(ids),
  ]);

  const appsByCandidate = new Map<string, ApplicationLite>();
  for (const a of (appsRes.data ?? []) as Array<{ candidate_id: string; parsed_experience?: ParsedExperienceEntry[] | null }>) {
    if (!appsByCandidate.has(a.candidate_id))
      appsByCandidate.set(a.candidate_id, {
        answers: null,
        cover_letter: null,
        parsed_experience: a.parsed_experience ?? null,
      });
  }

  const evalsByCandidate = groupEvaluations(evalRows);

  const roster: RosterEntry[] = [];
  for (const item of board) {
    const id = item.candidate.workable_id;
    if (excludeId && id === excludeId) continue;
    const wf = workingFiles.get(id);
    const read = (wf?.read as DecisionRead | null) ?? null;

    const candidate = mapCandidate({
      candidate: item.candidate,
      score: item.score ?? null,
      ro: item.ro ?? null,
      overlay: item.overlay ?? null,
      application: appsByCandidate.get(id) ?? null,
      narrative: [],
      evals: evalsByCandidate.get(id) ?? { invest: null, dig: null, verification: null, roleReads: [], answerGrades: [] },
      interviewEvidence: [],
      read,
      corrections: wf?.workspace?.corrections ?? [],
      decisionOverride: wf?.workspace?.decisionOverride ?? null,
      processStatus: wf?.workspace?.processStatus ?? null,
      rank: 0,
      jobLocation: "Van Nuys, CA",
      jobShortcode,
    });

    roster.push({
      id: candidate.id,
      name: candidate.name,
      role: candidate.role,
      company: candidate.company,
      decision: candidate.decision,
      experience: candidate.experience,
      roLevel: candidate.roLevel,
      why: candidate.why,
    });
  }
  return roster;
}

function withCrossRoleOption(jobs: JobOption[]): JobOption[] {
  if (jobs.some((j) => j.shortcode === CROSS_ROLE_SHORTCODE)) return jobs;
  return [{ shortcode: CROSS_ROLE_SHORTCODE, title: "New across roles" }, ...jobs];
}

/**
 * Cross-role pool: the recent applications across every published job in one
 * ranked inbox, so you can answer "who's the best new applicant?" without
 * switching jobs. Scoped to RECENT_WINDOW_DAYS — loading the whole historical
 * pool let old high-scoring candidates hold the top of the list permanently.
 */
async function loadCrossRolePool(): Promise<TriagePool> {
  const jobSummaries = await getPublishedJobs();
  const jobs = withCrossRoleOption(jobSummaries.map((j) => ({ shortcode: j.shortcode, title: j.title })));
  const titleByShortcode = new Map(jobSummaries.map((j) => [j.shortcode, j.title]));
  const shortcodes = jobSummaries.map((j) => j.shortcode);
  const methodology = await getMethodDoc();
  const emptyRubric = { rubricMd: "", specMd: "" };

  if (!hasSupabase() || !shortcodes.length) {
    return {
      ...emptyPool(CROSS_ROLE_SHORTCODE, jobs, "New across roles", emptyRubric, FALLBACK_STAGES),
      crossRole: true,
    };
  }

  const fullBoard = await getBoardFromSupabaseForJobs(shortcodes, {
    since: new Date(Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000),
  });
  if (!fullBoard?.length) {
    // Nothing recent: fall back to the newest applications so the inbox still
    // works on a quiet pool instead of rendering empty.
    const recentFallback = await getBoardFromSupabaseForJobs(shortcodes, { max: RECENT_MINIMUM });
    if (!recentFallback?.length) {
      return {
        ...emptyPool(CROSS_ROLE_SHORTCODE, jobs, "New across roles", emptyRubric, FALLBACK_STAGES),
        crossRole: true,
        meta: {
          title: "New across roles",
          jobShortcode: CROSS_ROLE_SHORTCODE,
          jobUrl: "",
          healthState: "No candidates",
          healthRead: "No candidates synced across published jobs yet.",
          total: 0,
        },
      };
    }
    return buildCrossRolePool(recentFallback, { jobs, titleByShortcode, shortcodes, methodology });
  }
  return buildCrossRolePool(selectRecentApplicants(fullBoard), {
    jobs,
    titleByShortcode,
    shortcodes,
    methodology,
  });
}

async function buildCrossRolePool(
  board: BoardCandidate[],
  ctx: {
    jobs: JobOption[];
    titleByShortcode: Map<string, string>;
    shortcodes: string[];
    methodology: string;
  },
): Promise<TriagePool> {
  const { jobs, titleByShortcode, shortcodes, methodology } = ctx;

  const ids = board.map((b) => b.candidate.workable_id);
  const supabase = getServiceSupabase();

  const [appsRows, evalRows, narrRows, evidenceRows, activityRows, workingFiles] = await Promise.all([
    fetchByCandidatePaged<{ candidate_id: string } & ApplicationLite>(
      supabase,
      "applications",
      "candidate_id, answers, cover_letter, parsed_experience, resume_text, resume_url",
      ids,
      "candidate_id",
    ),
    fetchEvaluationsPaged(supabase, ids),
    fetchByCandidatePaged<{ candidate_id: string; segments: NarrativeSegment[] }>(
      supabase,
      "narratives",
      "candidate_id, segments, generated_at",
      ids,
      "generated_at",
    ),
    fetchByCandidatePaged<EvidenceRow>(supabase, "evidence", "*", ids, "created_at"),
    fetchByCandidatePaged<ActivityRow>(
      supabase,
      "activity",
      "id, candidate_id, type, author, body, created_at",
      ids,
      "created_at",
    ),
    getWorkingFiles(ids),
  ]);

  const activityByCandidate = new Map<string, ActivityEntry[]>();
  for (const r of [...activityRows].reverse()) {
    const list = activityByCandidate.get(r.candidate_id) ?? [];
    list.push(toActivityEntry(r));
    activityByCandidate.set(r.candidate_id, list);
  }

  const appsByCandidate = new Map<string, ApplicationLite>();
  for (const a of appsRows) {
    if (!appsByCandidate.has(a.candidate_id)) {
      appsByCandidate.set(a.candidate_id, {
        answers: a.answers ?? null,
        cover_letter: a.cover_letter ?? null,
        parsed_experience: a.parsed_experience ?? null,
        resume_text: a.resume_text ?? null,
        resume_url: a.resume_url ?? null,
      });
    }
  }

  const evalsByCandidate = groupEvaluations(evalRows);
  const narrByCandidate = new Map<string, NarrativeSegment[]>();
  for (const n of narrRows) {
    if (!narrByCandidate.has(n.candidate_id)) narrByCandidate.set(n.candidate_id, (n.segments ?? []) as NarrativeSegment[]);
  }
  const evidenceByCandidate = new Map<string, EvidenceRow[]>();
  for (const e of evidenceRows.filter((r) => INTERVIEW_EVIDENCE_TYPES.has(r.source_type as string))) {
    const list = evidenceByCandidate.get(e.candidate_id) ?? [];
    list.push(e);
    evidenceByCandidate.set(e.candidate_id, list);
  }

  const workspace = emptyWorkspace();
  const candidates: Candidate[] = board.map((item, index) => {
    const id = item.candidate.workable_id;
    const jobShortcode = item.candidate.job_shortcode || "";
    const wf = workingFiles.get(id);
    const read = (wf?.read as DecisionRead | null) ?? null;

    const candidate = mapCandidate({
      candidate: item.candidate,
      score: item.score ?? null,
      ro: item.ro ?? null,
      overlay: item.overlay ?? null,
      application: appsByCandidate.get(id) ?? null,
      narrative: narrByCandidate.get(id) ?? [],
      evals: evalsByCandidate.get(id) ?? { invest: null, dig: null, verification: null, roleReads: [], answerGrades: [] },
      interviewEvidence: evidenceByCandidate.get(id) ?? [],
      read,
      corrections: wf?.workspace?.corrections ?? [],
      decisionOverride: wf?.workspace?.decisionOverride ?? null,
      processStatus: wf?.workspace?.processStatus ?? null,
      rank: index + 1,
      jobLocation: "Van Nuys, CA",
      jobShortcode,
      jobTitle: titleByShortcode.get(jobShortcode) ?? jobShortcode,
    });

    const dq = item.overlay?.status === "disqualified" || Boolean(item.candidate.disqualified);
    if (dq) workspace.dq[id] = true;
    const slice = wf?.workspace ?? {};
    if (slice.ovr) workspace.ovr[id] = slice.ovr;
    if (slice.replies) workspace.replies[id] = slice.replies;
    if (slice.corrections) workspace.corrections[id] = slice.corrections;
    if (slice.transcript) workspace.transcripts[id] = slice.transcript;
    if (slice.deep) workspace.deep[id] = true;
    if (slice.processStatus) workspace.process[id] = slice.processStatus;
    if (slice.chat?.length) workspace.chat[id] = slice.chat;
    const acts = activityByCandidate.get(id);
    if (acts?.length) workspace.activity[id] = acts;

    return candidate;
  });

  // Readiness must be computed against each candidate's OWN job spec. This used
  // to pass empty strings, so every blocked candidate in the cross-role view
  // reported "waiting on job spec" even when the spec was present — a fake
  // diagnosis that hid the real reason (usually: never analysed).
  const blocked = candidates.filter((c) => c.decision === "blocked");
  if (blocked.length) {
    const rubricByJob = new Map<string, { specMd: string; rubricMd: string }>();
    for (const shortcode of new Set(blocked.map((c) => c.jobShortcode || ""))) {
      if (!shortcode) continue;
      try {
        rubricByJob.set(shortcode, await getJobRubric(shortcode));
      } catch (error) {
        console.error(`Failed to load rubric for ${shortcode}`, error);
      }
    }
    for (const c of blocked) {
      const app = appsByCandidate.get(c.id);
      const jobRubric = rubricByJob.get(c.jobShortcode || "");
      const inputs: GradingInputs = {
        candidateId: c.id,
        jobShortcode: c.jobShortcode || "",
        answers: (app?.answers as Record<string, string> | null) ?? null,
        resumeText: (app?.resume_text as string | null) ?? null,
        resumeStoragePath: null,
        resumeUrl: (app?.resume_url as string | null) ?? null,
        coverLetter: (app?.cover_letter as string | null) ?? null,
        parsedExperienceCount: Array.isArray(app?.parsed_experience) ? app!.parsed_experience.length : 0,
        jobSpec: jobRubric?.specMd ?? "",
        rubric: jobRubric?.rubricMd ?? "",
        methodology,
      };
      c.readiness = computeReadiness(inputs);
    }
  }
  assignPoolStanding(candidates, (id) => Boolean(workspace.dq[id]));

  const interviewCount = candidates.filter((c) => c.decision === "interview" && !workspace.dq[c.id]).length;

  return {
    candidates,
    workspace,
    jobs,
    configured: true,
    rubricMd: "",
    specMd: "",
    stages: FALLBACK_STAGES,
    crossRole: true,
    meta: {
      title: "New across roles",
      jobShortcode: CROSS_ROLE_SHORTCODE,
      jobUrl: "",
      healthState: `${candidates.length} across ${shortcodes.length} open jobs`,
      healthRead: `Applications from the last ${RECENT_WINDOW_DAYS} days across ${shortcodes.length} open jobs · ${interviewCount} interview-ready — ranked by job match, then problem complexity.`,
      total: candidates.length,
    },
  };
}

export async function loadTriagePool(jobShortcode: string): Promise<TriagePool> {
  if (jobShortcode === CROSS_ROLE_SHORTCODE) return loadCrossRolePool();

  const jobSummaries = await getPublishedJobs();
  const jobs = withCrossRoleOption(jobSummaries.map((j) => ({ shortcode: j.shortcode, title: j.title })));
  const jobMeta = await getJobByShortcode(jobShortcode);
  const title = jobMeta?.title ?? jobShortcode;
  const [rubric, methodology, stages] = await Promise.all([
    getJobRubric(jobShortcode),
    getMethodDoc(),
    loadJobStages(jobShortcode),
  ]);

  if (!hasSupabase()) return emptyPool(jobShortcode, jobs, title, rubric, stages);

  const board = await getBoardFromSupabase(jobShortcode);
  if (!board?.length) return emptyPool(jobShortcode, jobs, title, rubric, stages);

  const ids = board.map((b) => b.candidate.workable_id);
  const supabase = getServiceSupabase();

  const [appsRows, evalRows, narrRows, evidenceRows, activityRows, workingFiles] = await Promise.all([
    fetchByCandidatePaged<{ candidate_id: string } & ApplicationLite>(
      supabase,
      "applications",
      "candidate_id, answers, cover_letter, parsed_experience, resume_text, resume_url",
      ids,
      "candidate_id",
    ),
    fetchEvaluationsPaged(supabase, ids),
    fetchByCandidatePaged<{ candidate_id: string; segments: NarrativeSegment[] }>(
      supabase,
      "narratives",
      "candidate_id, segments, generated_at",
      ids,
      "generated_at",
    ),
    fetchByCandidatePaged<EvidenceRow>(supabase, "evidence", "*", ids, "created_at"),
    fetchByCandidatePaged<ActivityRow>(
      supabase,
      "activity",
      "id, candidate_id, type, author, body, created_at",
      ids,
      "created_at",
    ),
    getWorkingFiles(ids),
  ]);

  const activityByCandidate = new Map<string, ActivityEntry[]>();
  for (const r of [...activityRows].reverse()) {
    const list = activityByCandidate.get(r.candidate_id) ?? [];
    list.push(toActivityEntry(r));
    activityByCandidate.set(r.candidate_id, list);
  }

  const appsByCandidate = new Map<string, ApplicationLite>();
  for (const a of appsRows) {
    if (!appsByCandidate.has(a.candidate_id))
      appsByCandidate.set(a.candidate_id, {
        answers: a.answers,
        cover_letter: a.cover_letter,
        parsed_experience: a.parsed_experience,
        resume_text: a.resume_text,
        resume_url: a.resume_url,
      });
  }

  const evalsByCandidate = groupEvaluations(evalRows);

  const narrByCandidate = new Map<string, NarrativeSegment[]>();
  for (const n of narrRows) {
    if (!narrByCandidate.has(n.candidate_id)) narrByCandidate.set(n.candidate_id, (n.segments ?? []) as NarrativeSegment[]);
  }

  const evidenceByCandidate = new Map<string, EvidenceRow[]>();
  for (const e of evidenceRows.filter((r) => INTERVIEW_EVIDENCE_TYPES.has(r.source_type as string))) {
    const list = evidenceByCandidate.get(e.candidate_id) ?? [];
    list.push(e);
    evidenceByCandidate.set(e.candidate_id, list);
  }

  const workspace = emptyWorkspace();
  const candidates: Candidate[] = board.map((item, index) => {
    const id = item.candidate.workable_id;
    const wf = workingFiles.get(id);
    const read = (wf?.read as DecisionRead | null) ?? null;

    const candidate = mapCandidate({
      candidate: item.candidate,
      score: item.score ?? null,
      ro: item.ro ?? null,
      overlay: item.overlay ?? null,
      application: appsByCandidate.get(id) ?? null,
      narrative: narrByCandidate.get(id) ?? [],
      evals: evalsByCandidate.get(id) ?? { invest: null, dig: null, verification: null, roleReads: [], answerGrades: [] },
      interviewEvidence: evidenceByCandidate.get(id) ?? [],
      read,
      corrections: wf?.workspace?.corrections ?? [],
      decisionOverride: wf?.workspace?.decisionOverride ?? null,
      processStatus: wf?.workspace?.processStatus ?? null,
      rank: index + 1,
      jobLocation: "Van Nuys, CA",
      jobShortcode,
      jobTitle: title,
    });

    // Hydrate the client workspace from persisted state.
    const dq = item.overlay?.status === "disqualified" || Boolean(item.candidate.disqualified);
    if (dq) workspace.dq[id] = true;
    const slice = wf?.workspace ?? {};
    if (slice.ovr) workspace.ovr[id] = slice.ovr;
    if (slice.replies) workspace.replies[id] = slice.replies;
    if (slice.corrections) workspace.corrections[id] = slice.corrections;
    if (slice.transcript) workspace.transcripts[id] = slice.transcript;
    if (slice.deep) workspace.deep[id] = true;
    if (slice.processStatus) workspace.process[id] = slice.processStatus;
    if (slice.chat?.length) workspace.chat[id] = slice.chat;
    const acts = activityByCandidate.get(id);
    if (acts?.length) workspace.activity[id] = acts;

    return candidate;
  });

  // Attach grading readiness to blocked candidates (so the UI can say exactly what
  // it is waiting on) and assign each active candidate an ordinal pool standing.
  for (const c of candidates) {
    if (c.decision !== "blocked") continue;
    const app = appsByCandidate.get(c.id);
    const inputs: GradingInputs = {
      candidateId: c.id,
      jobShortcode,
      answers: (app?.answers as Record<string, string> | null) ?? null,
      resumeText: (app?.resume_text as string | null) ?? null,
      resumeStoragePath: null,
      resumeUrl: (app?.resume_url as string | null) ?? null,
      coverLetter: (app?.cover_letter as string | null) ?? null,
      parsedExperienceCount: Array.isArray(app?.parsed_experience) ? app!.parsed_experience.length : 0,
      jobSpec: rubric.specMd ?? "",
      rubric: rubric.rubricMd ?? "",
      methodology,
    };
    c.readiness = computeReadiness(inputs);
  }
  assignPoolStanding(candidates, (id) => Boolean(workspace.dq[id]));

  return {
    candidates,
    workspace,
    jobs,
    configured: true,
    rubricMd: rubric.rubricMd,
    specMd: rubric.specMd,
    stages,
    meta: deriveMeta(candidates, jobShortcode, title),
  };
}
