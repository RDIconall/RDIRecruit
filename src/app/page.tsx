import { redirect } from "next/navigation";
import { getPublishedJobs } from "@/lib/jobs/service";
import { jobBoardPath } from "@/lib/routes";

export default async function HomePage() {
  const jobs = await getPublishedJobs();
  redirect(jobBoardPath(jobs[0]?.shortcode ?? "EA-001"));
}
