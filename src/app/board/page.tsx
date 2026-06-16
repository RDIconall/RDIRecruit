import { redirect } from "next/navigation";
import { Suspense } from "react";
import { BoardClient } from "@/components/board/board-client";
import { AppHeader } from "@/components/layout/app-header";
import { getBoardCandidates } from "@/lib/data/board";
import { getJobByShortcode, getPublishedJobs, resolveActiveJobShortcode } from "@/lib/jobs/service";
import { getUnreadNotificationCount } from "@/lib/notifications/service";
import { getPipelineStatus } from "@/lib/status/pipeline-status";

export const maxDuration = 60;

export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string; tier?: string }>;
}) {
  const params = await searchParams;
  const jobs = await getPublishedJobs();
  const activeJob = await resolveActiveJobShortcode(params.job);

  if (!activeJob && jobs[0]) {
    redirect(`/board?job=${jobs[0].shortcode}`);
  }

  if (!activeJob) {
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

  const job = await getJobByShortcode(activeJob);
  const { getBoardSummary } = await import("@/lib/board/summary");
  const [board, alertCount, summary, status] = await Promise.all([
    getBoardCandidates(activeJob),
    getUnreadNotificationCount(),
    getBoardSummary(activeJob),
    getPipelineStatus(activeJob),
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
        crumbs={[{ label: "Pipeline", href: `/board?job=${activeJob}` }]}
      />
      <Suspense fallback={<p className="px-6 py-8 text-sm text-navy/60">Loading pipeline…</p>}>
        <BoardClient
          items={board}
          jobs={jobs}
          jobShortcode={activeJob}
          jobTitle={job?.title ?? activeJob}
          seatStratum={seat.seatStratum}
          boardSummary={summary}
          status={status}
          initialTier={params.tier}
        />
      </Suspense>
    </div>
  );
}
