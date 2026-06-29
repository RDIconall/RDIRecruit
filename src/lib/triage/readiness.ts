import "server-only";
import { hasSupabase, hasWorkable } from "../env";
import { getServiceSupabase } from "../supabase/server";
import { getJobRubric } from "../rubric/store";
import { getMethodDoc } from "../evaluation/method";
import { gradeLog } from "./grade-log";
import { MIN_RESUME_TEXT } from "../resume/constants";
import type { CandidateReadiness, ReadinessInput } from "./types";
/** Minimum methodology length that counts as a real "how we hire" doc. */
const MIN_METHOD = 40;

export const READINESS_LABELS: Record<ReadinessInput, string> = {
  answers: "screening answers",
  resume: "parsed résumé",
  jobSpec: "job spec",
  methodology: "how-we-hire methodology",
};

/** Everything the grader needs in one bundle, assembled from real data. */
export interface GradingInputs {
  candidateId: string;
  jobShortcode: string;
  /** Raw screening answers (question → answer). */
  answers: Record<string, string> | null;
  /** Full extracted résumé text (applications.resume_text). */
  resumeText: string | null;
  resumeStoragePath: string | null;
  resumeUrl: string | null;
  /** Cover letter text, when the candidate submitted one. Counts as gradeable material. */
  coverLetter?: string | null;
  /** How many parsed experience entries are on file. Counts as gradeable material. */
  parsedExperienceCount?: number;
  /** Job role spec markdown (after the Workable-description fallback). */
  jobSpec: string;
  /** Job grading rubric markdown. */
  rubric: string;
  /** Global "how we hire" evaluation method doc. */
  methodology: string;
}

/**
 * Whether screening answers are satisfied for grading.
 *
 * Answers are a CONDITIONAL input, not an absolute one: many jobs (and every
 * sourced / directly-imported candidate) carry no screening questions at all,
 * so a candidate must never be permanently "Review blocked" merely for lacking
 * them — a parsed résumé + job spec + methodology is gradeable on its own.
 *
 * We therefore only treat answers as MISSING when the candidate was actually
 * asked screening questions (their application carries answer keys) yet every
 * answer is blank. An empty / absent answers record means the candidate was not
 * screened with questions, which is not a blocker.
 */
function answersReady(answers: Record<string, string> | null): boolean {
  if (!answers || typeof answers !== "object") return true;
  const keys = Object.keys(answers);
  if (keys.length === 0) return true;
  return Object.values(answers).some((v) => typeof v === "string" && v.trim().length > 0);
}

/** Whether the candidate actually submitted non-blank screening answers. */
function hasAnswerContent(answers: Record<string, string> | null): boolean {
  if (!answers || typeof answers !== "object") return false;
  return Object.values(answers).some((v) => typeof v === "string" && v.trim().length > 0);
}

/**
 * Pure readiness check over an assembled input bundle. Never throws.
 *
 * A candidate is gradeable as soon as there is SOMETHING to read — a parsed
 * résumé, non-blank screening answers, a cover letter, or parsed experience —
 * plus the job spec and methodology (both of which self-heal from Workable /
 * seed defaults). A missing parsed résumé ALONE is no longer a hard block: we
 * never want a real applicant frozen on "Review blocked" when they handed us
 * other material to evaluate. The only genuine block is having no candidate
 * material at all (e.g. an empty record orphaned from a deleted Workable entry).
 */
export function computeReadiness(inputs: GradingInputs): CandidateReadiness {
  const detail: Record<ReadinessInput, boolean> = {
    answers: answersReady(inputs.answers),
    resume: Boolean(inputs.resumeText && inputs.resumeText.trim().length >= MIN_RESUME_TEXT),
    jobSpec: Boolean(inputs.jobSpec.trim()),
    methodology: Boolean(inputs.methodology.trim().length >= MIN_METHOD),
  };

  const hasGradableMaterial =
    detail.resume ||
    hasAnswerContent(inputs.answers) ||
    Boolean(inputs.coverLetter && inputs.coverLetter.trim()) ||
    (inputs.parsedExperienceCount ?? 0) > 0;

  // Blockers are: nothing to read at all, or a missing job spec / methodology.
  // When there IS material, a missing résumé is informational, not a block.
  const missing: ReadinessInput[] = [];
  if (!hasGradableMaterial) missing.push("resume");
  if (!detail.jobSpec) missing.push("jobSpec");
  if (!detail.methodology) missing.push("methodology");

  // Is there any résumé source at all to ingest? A signed URL or an already-
  // stored file both mean "a résumé exists, it just isn't parsed yet" (resync /
  // OCR can fix it). Neither present means there is genuinely no résumé on file
  // in Workable — nothing to grade, and a resync will not conjure one.
  const hasResumeSource = Boolean(
    (inputs.resumeUrl && inputs.resumeUrl.trim()) ||
      (inputs.resumeStoragePath && inputs.resumeStoragePath.trim()),
  );
  return {
    ready: missing.length === 0,
    missing,
    detail,
    resumeMissingFromSource: !hasGradableMaterial && !detail.resume && !hasResumeSource,
  };
}

/**
 * Assemble the four grading inputs for a candidate from live data. Resilient:
 * returns a bundle (with empty strings / nulls for anything unavailable) rather
 * than throwing, so the readiness check can report exactly what is missing.
 */
export async function assembleGradingInputs(
  candidateId: string,
  jobShortcode: string,
): Promise<GradingInputs> {
  const base: GradingInputs = {
    candidateId,
    jobShortcode,
    answers: null,
    resumeText: null,
    resumeStoragePath: null,
    resumeUrl: null,
    coverLetter: null,
    parsedExperienceCount: 0,
    jobSpec: "",
    rubric: "",
    methodology: "",
  };

  if (!hasSupabase()) return base;
  const supabase = getServiceSupabase();

  const [appRes, rubric, methodology] = await Promise.all([
    supabase
      .from("applications")
      .select("answers, resume_text, resume_storage_path, resume_url, cover_letter, parsed_experience")
      .eq("candidate_id", candidateId)
      .maybeSingle(),
    getJobRubric(jobShortcode),
    getMethodDoc(),
  ]);

  const app = appRes.data as
    | {
        answers: Record<string, string> | null;
        resume_text: string | null;
        resume_storage_path: string | null;
        resume_url: string | null;
        cover_letter: string | null;
        parsed_experience: unknown[] | null;
      }
    | null;

  return {
    ...base,
    answers: app?.answers ?? null,
    resumeText: app?.resume_text ?? null,
    resumeStoragePath: app?.resume_storage_path ?? null,
    resumeUrl: app?.resume_url ?? null,
    coverLetter: app?.cover_letter ?? null,
    parsedExperienceCount: Array.isArray(app?.parsed_experience) ? app!.parsed_experience.length : 0,
    jobSpec: rubric.specMd ?? "",
    rubric: rubric.rubricMd ?? "",
    methodology: methodology ?? "",
  };
}

/**
 * Best-effort repair of missing grading inputs, then re-assemble. Pulls fresh data
 * from Workable rather than grading on a partial record:
 *  - missing answers / résumé → re-sync the candidate from Workable (forces a fresh
 *    résumé ingest, which also refreshes the application answers + cover letter)
 *  - missing job spec → re-sync the job so jobs.raw (description/requirements) is
 *    populated, which the spec falls back to
 * Methodology always resolves through getMethodDoc()'s seed/default fallback, so
 * there is nothing to fetch for it. Never throws.
 */
export async function repairGradingInputs(
  inputs: GradingInputs,
): Promise<{ inputs: GradingInputs; readiness: CandidateReadiness; repaired: ReadinessInput[] }> {
  const before = computeReadiness(inputs);
  if (before.ready || !hasWorkable()) {
    return { inputs, readiness: before, repaired: [] };
  }

  const repaired: ReadinessInput[] = [];
  const needsCandidate = before.missing.includes("answers") || before.missing.includes("resume");
  const needsJob = before.missing.includes("jobSpec");

  try {
    const { upsertCandidateFromWorkable, upsertJob } = await import("../sync/workable-sync");

    if (needsCandidate) {
      gradeLog("readiness.repair.candidate", { candidateId: inputs.candidateId, missing: before.missing });
      const { getCandidate } = await import("../workable/client");
      const candidate = await getCandidate(inputs.jobShortcode, inputs.candidateId);
      const result = await upsertCandidateFromWorkable(candidate, inputs.jobShortcode, {
        analyze: true,
        forceAnalyze: true,
        syncComments: false,
      });
      if (result.applicationIngested) repaired.push("resume");
      if (result.resumeError) {
        gradeLog("readiness.repair.resumeError", {
          candidateId: inputs.candidateId,
          error: result.resumeError,
        });
      }
    }

    if (needsJob) {
      gradeLog("readiness.repair.job", { jobShortcode: inputs.jobShortcode });
      const { getJob } = await import("../workable/client");
      const job = await getJob(inputs.jobShortcode);
      await upsertJob(job);
      repaired.push("jobSpec");
    }
  } catch (error) {
    gradeLog("readiness.repair.failed", {
      candidateId: inputs.candidateId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const next = await assembleGradingInputs(inputs.candidateId, inputs.jobShortcode);
  const readiness = computeReadiness(next);
  return { inputs: next, readiness, repaired };
}

/**
 * Assemble inputs, and if anything required is missing, attempt one repair pass.
 * Returns the (possibly repaired) inputs and the final readiness verdict.
 */
export async function prepareGradingInputs(
  candidateId: string,
  jobShortcode: string,
): Promise<{ inputs: GradingInputs; readiness: CandidateReadiness }> {
  const inputs = await assembleGradingInputs(candidateId, jobShortcode);
  const readiness = computeReadiness(inputs);
  if (readiness.ready) return { inputs, readiness };

  const repaired = await repairGradingInputs(inputs);
  return { inputs: repaired.inputs, readiness: repaired.readiness };
}

/** Human-readable list of what's still missing, e.g. "parsed résumé, job spec". */
export function describeMissing(missing: ReadinessInput[]): string {
  return missing.map((m) => READINESS_LABELS[m]).join(", ");
}
