"use client";

import { useRouter, useSearchParams } from "next/navigation";
import type { JobSummary } from "@/lib/jobs/service";

export function JobSwitcher({
  jobs,
  activeShortcode,
}: {
  jobs: JobSummary[];
  activeShortcode: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function onChange(shortcode: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("job", shortcode);
    params.delete("tier");
    router.push(`/board?${params.toString()}`);
  }

  return (
    <select
      id="job-switcher"
      value={activeShortcode}
      onChange={(e) => onChange(e.target.value)}
      className="max-w-[220px] rounded-md border border-navy/18 bg-white px-2.5 py-1.5 text-xs text-navy focus:border-orange focus:outline-none"
    >
      {jobs.map((job) => (
        <option key={job.shortcode} value={job.shortcode}>
          {job.title}
        </option>
      ))}
    </select>
  );
}
