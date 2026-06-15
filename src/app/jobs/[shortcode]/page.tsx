import { redirect } from "next/navigation";
import { Suspense } from "react";
import { BoardClient } from "@/components/board/board-client";
import { AppHeader } from "@/components/layout/app-header";
import { getBoardCandidates } from "@/lib/data/board";
import { getJobByShortcode, getPublishedJobs } from "@/lib/jobs/service";
import { getUnreadNotificationCount } from "@/lib/notifications/service";
import { jobBoardPath } from "@/lib/routes";
import { getActiveRubric } from "@/lib/rubric/service";

export const maxDuration = 60;

export default async function JobBoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ shortcode: string }>;
  searchParams: Promise<{ tier?: string }>;
}) {
  const { shortcode } = await params;
  const { tier } = await searchParams;
  const jobs = await getPublishedJobs();
  const job = await getJobByShortcode(shortcode);

  if (!job && jobs[0] && shortcode !== jobs[0].shortcode) {
    redirect(jobBoardPath(jobs[0].shortcode, tier));
  }

  if (!job && !jobs.length) {
    return (
      <div className="min-h-screen bg-cream">
        <AppHeader />
        <div className="mx-auto max-w-[1320px] px-6 py-16">
          <h1 className="text-2xl font-semibold">No live requisitions</h1>
          <p className="mt-2 text-sm text-navy/60">
            Connect Workable or run sync to load published jobs.
          </p>
        </div>
      </div>
    );
  }

  const activeJob = shortcode;
  const { getBoardSummary } = await import("@/lib/board/summary");
  const [board, alertCount, summary, rubric] = await Promise.all([
    getBoardCandidates(activeJob),
    getUnreadNotificationCount(),
    getBoardSummary(activeJob),
    getActiveRubric(activeJob),
  ]);

  const { buildSeatContext } = await import("@/lib/jobs/seat-context");
  const seat = buildSeatContext({
    title: job?.title ?? activeJob,
    department: job?.department,
    location: job?.location,
  });

  return (
    <div className="min-h-screen bg-cream">
      <AppHeader
        activeJob={activeJob}
        alertCount={alertCount}
        crumbs={[{ label: "Pipeline", href: jobBoardPath(activeJob) }]}
      />
      <Suspense fallback={<p className="px-6 py-8 text-sm text-navy/60">Loading pipeline…</p>}>
        <BoardClient
          items={board}
          jobs={jobs}
          jobShortcode={activeJob}
          jobTitle={job?.title ?? activeJob}
          seatStratum={seat.seatStratum}
          boardSummary={summary}
          initialTier={tier}
          rubricWeights={rubric.weights}
        />
      </Suspense>
    </div>
  );
}
