import { notFound } from "next/navigation";
import Link from "next/link";
import { ComposeClient } from "@/components/invite/compose-client";
import { AppHeader } from "@/components/layout/app-header";
import { getCandidateDetail } from "@/lib/data/board";
import { getJobByShortcode } from "@/lib/jobs/service";
import { candidatePath, jobBoardPath } from "@/lib/routes";
import { wbCandidateEmail } from "@/lib/workable/links";

export default async function ComposePage({
  params,
}: {
  params: Promise<{ shortcode: string; cid: string }>;
}) {
  const { shortcode: jobShortcode, cid: id } = await params;
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
          { label: "Pipeline", href: jobBoardPath(jobShortcode) },
          { label: detail.candidate.name ?? "Candidate", href: candidatePath(jobShortcode, id) },
          { label: "Compose invite" },
        ]}
      />
      <div className="mx-auto max-w-[980px] px-6 pb-24 pt-8">
        <Link
          href={candidatePath(jobShortcode, id)}
          className="text-[13px] text-navy/55 hover:text-orange"
        >
          ← Back to candidate
        </Link>
        <h1 className="mt-4 text-[26px] font-semibold tracking-tight">
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
