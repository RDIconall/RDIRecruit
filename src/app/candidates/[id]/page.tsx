import { notFound } from "next/navigation";
import { getBoardCandidates, getCandidateDetail } from "@/lib/data/board";
import { getJobByShortcode, resolveActiveJobShortcode } from "@/lib/jobs/service";
import { ApplicationSection, VerificationSection } from "@/components/candidate/application-sections";
import { CandidateActionBar } from "@/components/candidate/candidate-action-bar";
import { CandidateIdentity, InvestmentPanel } from "@/components/candidate/candidate-identity";
import { CareerSection } from "@/components/candidate/career-section";
import { InterviewEvidence } from "@/components/candidate/interview-evidence";
import { ReadAdjuster } from "@/components/candidate/read-adjuster";
import { RoPanel } from "@/components/candidate/ro-panel";
import { SocialLinks } from "@/components/candidate/social-links";
import { AppHeader } from "@/components/layout/app-header";
import { experienceFromRawOrApplication } from "@/lib/data/workable-cache";
import { getUnreadNotificationCount } from "@/lib/notifications/service";

export default async function CandidatePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ job?: string }>;
}) {
  const { id } = await params;
  const { job: jobParam } = await searchParams;
  const jobShortcode = (await resolveActiveJobShortcode(jobParam)) ?? "EA-001";
  const detail = await getCandidateDetail(id, jobShortcode);
  if (!detail) notFound();

  const {
    candidate,
    score,
    ro,
    narrative,
    scoreInputs,
    overlay,
    evaluations,
    interviewEvidence,
    poolLine,
    application,
  } = detail;
  const job = await getJobByShortcode(candidate.job_shortcode ?? jobShortcode);
  const board = await getBoardCandidates(candidate.job_shortcode ?? jobShortcode);
  const rank = board.findIndex((b) => b.candidate.workable_id === id) + 1;
  const alertCount = await getUnreadNotificationCount();

  const activeBoard = board.filter(
    (b) =>
      b.overlay?.status !== "withdrawn" &&
      b.overlay?.status !== "disqualified" &&
      !b.candidate.disqualified,
  );
  const poolStats = {
    active: activeBoard.length,
    owners: activeBoard.filter((b) => b.overlay?.complement === "owner").length,
  };

  const experience = experienceFromRawOrApplication(
    candidate.raw,
    application?.parsed_experience as unknown[] | undefined,
  );
  const currentRole = experience.find((e) => e.current) ?? experience[0];
  const roleLine = currentRole?.title ?? job?.title ?? "Candidate";
  const companyLine = currentRole?.company ?? "—";

  const resumeReview = application?.resume_parsed ?? null;
  const coverLetter = application?.cover_letter ?? detail.workable?.cover_letter ?? null;
  const fallbackResumeUrl = application?.resume_url ?? detail.workable?.resume_url ?? null;

  const investPayload = evaluations.find((e) => e.kind === "invest_head")?.payload as unknown as
    | { summary?: string; ask?: string | null }
    | undefined;
  const answerSalaryHint = evaluations
    .filter((e) => e.kind === "answer_grade")
    .map((e) => (e.payload as { answer?: string }).answer ?? "")
    .join("\n");
  const salaryHint = investPayload?.ask ?? answerSalaryHint;

  const status = overlay?.status ?? (candidate.disqualified ? "disqualified" : "active");
  const isActive = status === "active";
  const statusLabel = status === "withdrawn" ? "Withdrew" : status === "disqualified" ? "Disqualified" : "";

  return (
    <div className="min-h-screen bg-cream">
      <AppHeader
        activeJob={candidate.job_shortcode ?? jobShortcode}
        alertCount={alertCount}
        crumbs={[
          { label: "Pipeline", href: `/board?job=${candidate.job_shortcode ?? jobShortcode}` },
          { label: candidate.name ?? "Candidate" },
        ]}
      />
      <div className="mx-auto max-w-[1180px] px-6 pb-28 pt-7">
        <CandidateIdentity
          name={candidate.name ?? "Candidate"}
          roleLine={roleLine}
          companyLine={companyLine}
          location={candidate.location}
          score={score}
          ro={ro}
          seatStratum={ro?.seat_stratum ?? "IIb–IIa"}
          ask={investPayload?.ask ?? null}
        />

        <CandidateActionBar
          candidateId={candidate.workable_id}
          jobShortcode={candidate.job_shortcode ?? jobShortcode}
          candidateName={candidate.name ?? "Candidate"}
          stage={candidate.stage}
          overlay={overlay}
        />

        <InvestmentPanel
          score={score}
          overlay={overlay}
          rank={rank > 0 ? rank : 1}
          poolLine={poolLine}
          poolStats={poolStats}
          salaryHint={salaryHint}
          candidateName={candidate.name}
          summary={investPayload?.summary}
          active={isActive}
          statusLabel={statusLabel}
        />

        <ReadAdjuster
          candidateId={candidate.workable_id}
          jobShortcode={candidate.job_shortcode ?? jobShortcode}
          candidateName={candidate.name ?? "Candidate"}
          aiTotal={score?.total ?? null}
          isOverridden={score?.model_version === "reviewer-override"}
        />

        <CareerSection
          narrative={narrative}
          ro={ro}
          scoreInputs={scoreInputs}
          evaluations={evaluations}
          chronologySummary={resumeReview?.chronologySummary}
        />

        {ro ? (
          <div className="mt-10">
            <RoPanel ro={ro} />
          </div>
        ) : null}

        <InterviewEvidence
          candidateId={candidate.workable_id}
          jobShortcode={candidate.job_shortcode ?? jobShortcode}
          evidence={interviewEvidence}
        />

        <SocialLinks
          name={candidate.name}
          location={candidate.location}
          company={currentRole?.company ?? null}
          raw={candidate.raw}
        />

        <VerificationSection evaluations={evaluations} />
        <ApplicationSection
          candidateId={candidate.workable_id}
          evaluations={evaluations}
          coverLetter={coverLetter}
          fallbackResumeUrl={fallbackResumeUrl}
          scoreInputs={scoreInputs}
          resumeReview={resumeReview}
        />
      </div>
    </div>
  );
}
