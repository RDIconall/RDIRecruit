import { hasWorkable } from "../env";
import { getServiceSupabase } from "../supabase/server";
import { upsertOverlay } from "../data/overlay";
import { buildSeatContext } from "../jobs/seat-context";
import { buildLifeNarrative } from "../narrative/builder";
import { notifyStrongFit } from "../notifications/service";
import {
  experienceFromParsedResume,
  educationFromParsedResume,
} from "../resume/narrative-from-parse";
import { evaluateCandidate } from "./evaluator";
import { getActiveRubric } from "../rubric/service";
import { getCalibrationForJob } from "../calibration/service";
import { getMethodDoc } from "../evaluation/method";
import { getJobRubric } from "../rubric/store";
import { computeReadiness, type GradingInputs } from "../triage/readiness";
import { gradeLog } from "../triage/grade-log";
import type { ParsedResumeReview } from "../resume/types";
import type { CategoryKey } from "../types";

type ExperienceEntry = {
  title: string;
  company: string;
  start?: string;
  end?: string;
  current?: boolean;
  summary?: string;
  resumeLine?: string;
};

/** First 4-digit year found in a loose date string, or null. */
function yearOf(value: string | null | undefined): number | null {
  const m = value?.match(/\b(19|20)\d{2}\b/);
  const y = m ? Number(m[0]) : null;
  return y && y >= 1950 && y <= new Date().getFullYear() ? y : null;
}

/** True when the degree string reads as an undergraduate / bachelor's credential. */
function isUndergrad(degree: string | null | undefined): boolean {
  if (!degree) return false;
  return /\b(bachelor|undergrad|b\.?\s?a\.?|b\.?\s?s\.?|b\.?\s?sc\.?|b\.?eng|bba|ab)\b/i.test(
    degree,
  );
}

/**
 * Career-span signal for the maturation/trajectory read — a LEVEL inference from
 * graduation + first-role dates, never age asked of the candidate and never a gate.
 *
 * We anchor on undergraduate graduation (entry to the workforce) and measure years
 * of career. We also pass a maturation-placement estimate: assuming the standard
 * straight-through path (~22 at undergrad graduation), an approximate current age.
 * The evaluator applies it ONLY when the chronology looks straight-through, and only
 * to place the candidate on the RO maturation band — never as a stated attribute or cutoff.
 */
function deriveCareerContext(
  roles: ExperienceEntry[],
  education: Array<{ degree?: string; start?: string; end?: string }>,
) {
  const undergradYears = education
    .filter((e) => isUndergrad(e.degree))
    .map((e) => yearOf(e.end) ?? yearOf(e.start))
    .filter((y): y is number => y != null);
  const anyGradYears = education
    .map((e) => yearOf(e.end) ?? yearOf(e.start))
    .filter((y): y is number => y != null);
  const roleYears = roles.map((r) => yearOf(r.start)).filter((y): y is number => y != null);

  // Prefer the undergrad year for the age anchor; else the earliest credential.
  const graduationYear = undergradYears.length
    ? Math.min(...undergradYears)
    : anyGradYears.length
      ? Math.min(...anyGradYears)
      : null;
  const firstRoleYear = roleYears.length ? Math.min(...roleYears) : null;

  // Career span anchors on the earliest workforce signal (graduation or first role).
  const anchor = [graduationYear, firstRoleYear].filter((y): y is number => y != null).sort()[0];
  if (!anchor) return null;

  const now = new Date().getFullYear();
  const yearsOfCareer = Math.max(0, now - anchor);

  // Maturation-placement estimate: ~22 at undergrad graduation, straight-through.
  const assumedGradAge = 22;
  const approxCurrentAge = graduationYear ? assumedGradAge + (now - graduationYear) : null;

  return { graduationYear, firstRoleYear, yearsOfCareer, assumedGradAge, approxCurrentAge };
}

export async function scoreCandidate(
  candidateId: string,
  options?: { force?: boolean; replace?: boolean },
) {
  const supabase = getServiceSupabase();

  if (!options?.force && !options?.replace) {
    const { data: existing } = await supabase
      .from("scores")
      .select("id")
      .eq("candidate_id", candidateId)
      .limit(1);
    if (existing?.length) {
      return { skipped: true, reason: "already_scored" as const };
    }
  }

  // NOTE: on replace we do NOT delete the prior score here. Deleting up front means
  // a failed/ rate-limited evaluation (which happens under high concurrency) would
  // wipe the existing score and leave the candidate unscored. We defer the delete to
  // AFTER a successful evaluation (see below) so a failed re-score is a no-op.

  const { data: candidate } = await supabase
    .from("candidates")
    .select("*")
    .eq("workable_id", candidateId)
    .single();

  if (!candidate) throw new Error("Candidate not found");

  const { data: application } = await supabase
    .from("applications")
    .select("*")
    .eq("candidate_id", candidateId)
    .maybeSingle();

  const resumeReview = (application?.resume_parsed ?? null) as ParsedResumeReview | null;

  const experience: ExperienceEntry[] = resumeReview?.roles?.length
    ? (experienceFromParsedResume(resumeReview) as ExperienceEntry[])
    : ((application?.parsed_experience ?? []) as ExperienceEntry[]);

  const resumeText =
    (application?.resume_text as string | undefined) ??
    (resumeReview?.roles
      ?.map((r) => `${r.title} · ${r.company}\n${r.bullets?.join("\n") ?? ""}`)
      .join("\n\n")) ??
    JSON.stringify(application?.parsed_experience ?? []);
  const answers = (application?.answers ?? {}) as Record<string, string>;

  const education = (resumeReview?.education?.length
    ? educationFromParsedResume(resumeReview)
    : (application?.parsed_education ?? [])) as Array<{
    school: string;
    degree?: string;
    start?: string;
    end?: string;
  }>;
  const careerContext = deriveCareerContext(experience, education);

  const { loadInterviewEvidenceText, loadRecruiterCommentsText } = await import("../sync/rescore");
  const interviewEvidence = await loadInterviewEvidenceText(candidateId);
  const recruiterComments = await loadRecruiterCommentsText(candidateId);

  // The two documents the grader reads for this seat: the global "How We
  // Evaluate" method + this job's rubric (weights + prose). Plus learned calibration.
  // jobRubric is the single editable job spec/rubric source of truth (job_rubrics);
  // we read it here too so the scorer's readiness gate agrees with the triage view.
  const [method, rubric, calibration, jobRubric] = await Promise.all([
    getMethodDoc(),
    getActiveRubric(candidate.job_shortcode),
    candidate.job_shortcode
      ? getCalibrationForJob(candidate.job_shortcode)
      : Promise.resolve({ global: "", role: "" }),
    getJobRubric(candidate.job_shortcode ?? ""),
  ]);

  // Readiness gate — never grade on partial data. All four inputs must be present:
  // screening answers, a parsed résumé, the job spec, and the methodology doc. When
  // incomplete we SKIP scoring (we never clobber an existing read); the candidate
  // stays "Review blocked" until the résumé backfill / re-sync fills the gap.
  const readinessInputs: GradingInputs = {
    candidateId,
    jobShortcode: candidate.job_shortcode ?? "",
    answers,
    resumeText: (application?.resume_text as string | null) ?? null,
    resumeStoragePath: (application?.resume_storage_path as string | null) ?? null,
    resumeUrl: (application?.resume_url as string | null) ?? null,
    jobSpec: jobRubric.specMd,
    rubric: jobRubric.rubricMd,
    methodology: method,
  };
  let readiness = computeReadiness(readinessInputs);

  // Self-heal a missing job spec. The most common reason a well-populated new
  // candidate is blocked is that the job was mirrored from Workable's list
  // endpoint (which omits the posting body), so jobs.raw has no full_description
  // and the spec resolves empty. Fetch the full job once, persist it, and re-read
  // the spec before giving up — mirrors the readiness repair on the triage path.
  if (!readiness.ready && !readiness.detail.jobSpec && candidate.job_shortcode && hasWorkable()) {
    try {
      const { getJob } = await import("../workable/client");
      const { upsertJob } = await import("../sync/workable-sync");
      await upsertJob(await getJob(candidate.job_shortcode));
      const refreshed = await getJobRubric(candidate.job_shortcode);
      readinessInputs.jobSpec = refreshed.specMd;
      readinessInputs.rubric = refreshed.rubricMd;
      readiness = computeReadiness(readinessInputs);
      gradeLog("score.jobspec.repaired", {
        candidateId,
        jobShortcode: candidate.job_shortcode,
        ready: readiness.ready,
      });
    } catch (error) {
      gradeLog("score.jobspec.repair.failed", {
        candidateId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!readiness.ready) {
    gradeLog("score.blocked", { candidateId, missing: readiness.missing });
    return { skipped: true as const, reason: "not_ready" as const, missing: readiness.missing };
  }

  // Seat context from the job (frames the §2 evaluation).
  const { data: jobRow } = candidate.job_shortcode
    ? await supabase
        .from("jobs")
        .select("title, department, location, raw")
        .eq("shortcode", candidate.job_shortcode)
        .maybeSingle()
    : { data: null };
  const seat = buildSeatContext({
    title: jobRow?.title ?? "the open seat",
    department: jobRow?.department,
    location: jobRow?.location,
    raw: jobRow?.raw as Record<string, unknown> | null,
  });

  const evaluation = await evaluateCandidate({
    name: candidate.name ?? "Candidate",
    resumeText,
    roles: experience,
    answers,
    coverLetter: application?.cover_letter,
    interviewEvidence,
    recruiterComments,
    publicProfile: null,
    seat,
    weights: rubric.weights,
    method,
    rubricGuidance: rubric.rawMd,
    globalCalibration: calibration.global,
    roleCalibration: calibration.role,
    careerContext,
  });

  // Evaluation succeeded — now it is safe to clear the prior read for a replace.
  // (ro_assessments and narratives are deleted-then-inserted in place further down.)
  if (options?.replace) {
    const { data: priorScores } = await supabase
      .from("scores")
      .select("id")
      .eq("candidate_id", candidateId);
    const scoreIds = (priorScores ?? []).map((s) => s.id as string);
    if (scoreIds.length) {
      await supabase.from("score_inputs").delete().in("score_id", scoreIds);
      await supabase.from("scores").delete().in("id", scoreIds);
    }
    await supabase.from("evaluations").delete().eq("candidate_id", candidateId);
  }

  const { data: scoreRow, error: scoreError } = await supabase
    .from("scores")
    .insert({
      candidate_id: candidateId,
      rubric_version: rubric.version,
      category_scores: evaluation.categoryScores,
      total: evaluation.total,
      salary_value: evaluation.salaryValue,
      model_version: "claude-sonnet-4-6",
      confidence: evaluation.confidence,
    })
    .select("*")
    .single();

  if (scoreError || !scoreRow) {
    throw scoreError ?? new Error("Failed to write score");
  }

  if (evaluation.claims.length > 0) {
    await supabase.from("score_inputs").insert(
      evaluation.claims.map((claim) => ({
        score_id: scoreRow.id,
        category: claim.category,
        claim: claim.claim,
        source_type: claim.sourceType,
        source_ref: claim.sourceRef,
        quote: claim.quote,
        capture_kind: "text_card",
        capture_status: "ready",
      })),
    );
  }

  // RO assessment — per-role reads embedded, validation-gate confidence + basis.
  await supabase.from("ro_assessments").delete().eq("candidate_id", candidateId);
  await supabase.from("ro_assessments").insert({
    candidate_id: candidateId,
    per_role: evaluation.roReads.map((r) => ({
      role: r.role,
      company: r.company,
      years: r.years,
      stratum: r.stratum,
      stratum_range: r.stratumRange,
      verbs: r.verbs,
    })),
    seat_stratum: evaluation.seatStratum,
    current_capability: evaluation.currentCapability,
    trajectory: evaluation.trajectory,
    text_confidence: evaluation.textConfidence,
    basis: evaluation.basis,
  });

  // Life narrative (gap-free chronology).
  const narrative = buildLifeNarrative({
    experience: experience as Array<{
      title: string;
      company: string;
      start?: string;
      end?: string;
      current?: boolean;
    }>,
    education,
  });
  await supabase.from("narratives").delete().eq("candidate_id", candidateId);
  if (narrative.length) {
    await supabase.from("narratives").insert({ candidate_id: candidateId, segments: narrative });
  }

  // §2 complement read → overlay.
  await upsertOverlay(candidateId, {
    status: "active",
    complement: evaluation.complement,
    complement_removes: evaluation.complementRemoves,
    salary_vector: evaluation.salaryVector,
  });

  // All qualitative reads → evaluations.
  const evalRows: Array<{ kind: string; ref: string | null; payload: Record<string, unknown> }> = [
    {
      kind: "invest_head",
      ref: null,
      payload: {
        complement: evaluation.complement,
        head: evaluation.investHead,
        removes: evaluation.complementRemoves,
        vector: evaluation.salaryVector,
        summary: evaluation.summary,
        ask: evaluation.salaryAsk,
      },
    },
    { kind: "dig_in", ref: null, payload: { ...evaluation.digIn } },
    { kind: "verification", ref: "profile", payload: { ...evaluation.verification } },
    { kind: "compose_questions", ref: null, payload: { questions: evaluation.composeQuestions } },
  ];

  for (const role of evaluation.roReads) {
    evalRows.push({
      kind: "role_read",
      ref: `${role.role} · ${role.company}`,
      payload: {
        role: role.role,
        company: role.company,
        read: role.read,
        level: role.level,
        burden: role.burden,
        stratum: role.stratum,
        quote: role.quote,
      },
    });
  }

  for (const ans of evaluation.answerGrades) {
    evalRows.push({
      kind: "answer_grade",
      ref: ans.question.slice(0, 120),
      payload: { ...ans },
    });
  }

  await supabase.from("evaluations").insert(
    evalRows.map((row) => ({
      candidate_id: candidateId,
      kind: row.kind,
      ref: row.ref,
      payload: row.payload,
      model_version: "claude-sonnet-4-6",
      rubric_version: rubric.version,
    })),
  );

  await notifyStrongFit({
    candidateId,
    candidateName: candidate.name ?? "Candidate",
    total: evaluation.total,
    jobShortcode: candidate.job_shortcode ?? "",
  });

  return { score: scoreRow, total: evaluation.total };
}

// Re-export so callers depending on these keep working.
export type { CategoryKey };
