import { cache } from "react";
import { hasSupabase, hasWorkable } from "../env";
import { getServiceSupabase } from "../supabase/server";
import type { WorkableJob } from "../workable/client";
import { getJob } from "../workable/client";

export interface JobSummary {
  shortcode: string;
  title: string;
  status: string;
  department?: string;
  location?: string;
  candidateCount?: number;
}

const DEMO_JOBS: JobSummary[] = [
  { shortcode: "EA-001", title: "Executive Assistant", status: "published", department: "Operations" },
  { shortcode: "CTRL-002", title: "Controller", status: "published", department: "Finance" },
];

async function jobsFromSupabase(): Promise<JobSummary[]> {
  if (!hasSupabase()) return [];
  const supabase = getServiceSupabase();
  const { data } = await supabase
    .from("jobs")
    .select("shortcode, title, status, department, location")
    .eq("status", "published")
    .order("title");
  return (data ?? []).map((row) => ({
    shortcode: row.shortcode,
    title: row.title,
    status: row.status ?? "published",
    department: row.department ?? undefined,
    location: row.location ?? undefined,
  }));
}

/** Read path: Supabase cache only. Workable fills cache via sync, not page loads. */
export const getPublishedJobs = cache(async (): Promise<JobSummary[]> => {
  const cached = await jobsFromSupabase();
  if (cached.length) return cached;

  if (hasWorkable()) {
    try {
      const { syncJobsFromWorkable } = await import("../sync/workable-sync");
      await syncJobsFromWorkable();
      const refreshed = await jobsFromSupabase();
      if (refreshed.length) return refreshed;
    } catch (error) {
      console.error("Failed to bootstrap jobs from Workable", error);
    }
  }

  return DEMO_JOBS;
});

export async function getJobByShortcode(shortcode: string): Promise<JobSummary | null> {
  if (hasSupabase()) {
    const supabase = getServiceSupabase();
    const { data } = await supabase
      .from("jobs")
      .select("shortcode, title, status, department, location")
      .eq("shortcode", shortcode)
      .maybeSingle();
    if (data) {
      return {
        shortcode: data.shortcode,
        title: data.title,
        status: data.status ?? "published",
        department: data.department ?? undefined,
        location: data.location ?? undefined,
      };
    }
  }

  const jobs = await getPublishedJobs();
  const found = jobs.find((job) => job.shortcode === shortcode);
  if (found) return found;

  if (hasWorkable()) {
    try {
      const job = await getJob(shortcode);
      const { upsertJob } = await import("../sync/workable-sync");
      await upsertJob(job);
      return mapWorkableJob(job);
    } catch {
      return null;
    }
  }

  return null;
}

export async function resolveActiveJobShortcode(
  requested?: string | null,
): Promise<string | null> {
  const jobs = await getPublishedJobs();
  if (!jobs.length) return null;
  if (requested && jobs.some((job) => job.shortcode === requested)) {
    return requested;
  }
  return jobs[0]!.shortcode;
}

function mapWorkableJob(job: WorkableJob): JobSummary {
  return {
    shortcode: job.shortcode,
    title: job.title,
    status: job.state,
    department: job.department,
    location: job.location?.location_str,
  };
}
