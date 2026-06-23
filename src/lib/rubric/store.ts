import "server-only";
import { hasSupabase } from "../env";
import { getServiceSupabase } from "../supabase/server";
import type { JobRubric } from "../triage/types";
import { EA_RUBRIC_TEMPLATE } from "./ea-template";

/** Very small HTML → text reducer for Workable job descriptions (which arrive as HTML). */
function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<\s*li\s*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** True when a job title reads as an Executive Assistant role (seeds the EA rubric). */
function isExecutiveAssistant(title: string | null | undefined): boolean {
  return /executive\s+assistant|\bEA\b/i.test(title ?? "");
}

interface JobRow {
  title?: string | null;
  raw?: { full_description?: string; description?: string; requirements?: string } | null;
}

function specFromJob(row: JobRow | null): string {
  const raw = row?.raw ?? null;
  if (!raw) return "";
  // Workable's single-job endpoint returns the entire posting (intro +
  // description + requirements + benefits) under `full_description`. Prefer it.
  // Fall back to the legacy `description` / `requirements` split for jobs synced
  // before full descriptions were fetched. The list endpoint carries none of
  // these, which is why a job-only sync leaves the spec empty until the full job
  // is fetched (see syncJobsFromWorkable / the run-score job-spec repair).
  const full = htmlToText(raw.full_description);
  if (full) return full;
  const desc = htmlToText(raw.description);
  const reqs = htmlToText(raw.requirements);
  if (!desc && !reqs) return "";
  return [desc, reqs ? `## Requirements\n\n${reqs}` : ""].filter(Boolean).join("\n\n");
}

/**
 * Read the editable rubric + role spec for a job. Falls back to:
 *  - the seeded EA rubric template when no rubric is saved and the job is an EA role,
 *  - the synced Workable job description/requirements when no spec is saved.
 * Always returns strings (never throws) so the page degrades gracefully.
 */
export async function getJobRubric(jobShortcode: string): Promise<JobRubric> {
  if (!hasSupabase()) {
    return {
      rubricMd: isExecutiveAssistant(jobShortcode) ? EA_RUBRIC_TEMPLATE : "",
      specMd: "",
    };
  }
  const supabase = getServiceSupabase();

  const [{ data: rubricRow }, { data: jobRow }] = await Promise.all([
    supabase
      .from("job_rubrics")
      .select("rubric_md, spec_md")
      .eq("job_shortcode", jobShortcode)
      .maybeSingle(),
    supabase.from("jobs").select("title, raw").eq("shortcode", jobShortcode).maybeSingle(),
  ]);

  const job = (jobRow as JobRow | null) ?? null;
  const storedRubric = (rubricRow?.rubric_md as string | null) ?? "";
  const storedSpec = (rubricRow?.spec_md as string | null) ?? "";

  const rubricMd = storedRubric || (isExecutiveAssistant(job?.title) ? EA_RUBRIC_TEMPLATE : "");
  const specMd = storedSpec || specFromJob(job);

  return { rubricMd, specMd };
}

/** Persist a per-job rubric / spec override. Only provided fields are written. */
export async function upsertJobRubric(
  jobShortcode: string,
  patch: { rubricMd?: string; specMd?: string },
  updatedBy?: string,
): Promise<void> {
  if (!hasSupabase()) return;
  const supabase = getServiceSupabase();

  const { data: existing } = await supabase
    .from("job_rubrics")
    .select("rubric_md, spec_md")
    .eq("job_shortcode", jobShortcode)
    .maybeSingle();

  await supabase.from("job_rubrics").upsert(
    {
      job_shortcode: jobShortcode,
      rubric_md: patch.rubricMd !== undefined ? patch.rubricMd : existing?.rubric_md ?? null,
      spec_md: patch.specMd !== undefined ? patch.specMd : existing?.spec_md ?? null,
      updated_at: new Date().toISOString(),
      updated_by: updatedBy ?? null,
    },
    { onConflict: "job_shortcode" },
  );
}
