import { redirect } from "next/navigation";
import { getPublishedJobs, resolveActiveJobShortcode } from "@/lib/jobs/service";
import { jobBoardPath } from "@/lib/routes";

export default async function BoardRedirectPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string; tier?: string }>;
}) {
  const params = await searchParams;
  const jobs = await getPublishedJobs();
  const activeJob = await resolveActiveJobShortcode(params.job);

  if (!activeJob && jobs[0]) {
    redirect(jobBoardPath(jobs[0].shortcode, params.tier));
  }

  if (activeJob) {
    redirect(jobBoardPath(activeJob, params.tier));
  }

  redirect("/jobs/EA-001");
}
