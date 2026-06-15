import { notFound } from "next/navigation";
import { ComposeClient } from "@/components/invite/compose-client";
import { AppHeader } from "@/components/layout/app-header";
import { getCandidateDetail } from "@/lib/data/board";
import { getJobByShortcode, resolveActiveJobShortcode } from "@/lib/jobs/service";
import { wbCandidateEmail } from "@/lib/workable/links";

export default async function InvitePage({
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

  const job = await getJobByShortcode(jobShortcode);

  const suggestedQuestions =
    (detail.evaluations.find((e) => e.kind === "compose_questions")?.payload as unknown as
      | { questions?: Array<{ q: string; why: string }> }
      | undefined)?.questions ?? [];

  return (
    <div className="min-h-screen bg-cream">
      <AppHeader
        activeJob={jobShortcode}
        crumbs={[
          { label: "Pipeline", href: `/board?job=${jobShortcode}` },
          { label: detail.candidate.name ?? "Candidate", href: `/candidates/${id}?job=${jobShortcode}` },
          { label: "Compose" },
        ]}
      />
      <div className="mx-auto max-w-[980px] px-6 pb-24 pt-8">
        <h1 className="text-[26px] font-semibold tracking-tight">
          Compose invite{" "}
          <span className="font-serif italic font-normal text-orange">for {detail.candidate.name}.</span>
        </h1>
        <p className="mt-2 text-sm text-navy/65">
          {job?.title ?? jobShortcode} · stage-bound templates fire from Workable when you advance.
        </p>
        <ComposeClient
          candidateId={id}
          jobShortcode={jobShortcode}
          candidateName={detail.candidate.name ?? "Candidate"}
          workableEmailUrl={wbCandidateEmail(jobShortcode, id)}
          suggestedQuestions={suggestedQuestions}
        />
      </div>
    </div>
  );
}
