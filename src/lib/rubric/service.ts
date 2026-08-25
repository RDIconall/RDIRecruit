import { hasSupabase } from "../env";
import { getServiceSupabase } from "../supabase/server";
import { DEFAULT_RUBRIC_MD, parseRubricMarkdown, type ParsedRubric } from "./parser";
import { getBuiltinSeatRubric, seatRubricMarkdown } from "./seat-rubrics";

/**
 * Active rubric for a job — the one the evaluator actually scores against.
 * Falls back to the default rubric when none is saved.
 */
export async function getActiveRubric(jobShortcode: string | null | undefined): Promise<ParsedRubric> {
  if (!jobShortcode || !hasSupabase()) {
    const builtin = getBuiltinSeatRubric({ shortcode: jobShortcode });
    return parseRubricMarkdown(builtin ? seatRubricMarkdown(builtin) : DEFAULT_RUBRIC_MD);
  }
  const supabase = getServiceSupabase();
  const { data } = await supabase
    .from("rubrics")
    .select("raw_md, version, name")
    .eq("job_shortcode", jobShortcode)
    .eq("active", true)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (data?.raw_md) {
    const parsed = parseRubricMarkdown(data.raw_md as string, (data.name as string) ?? "Rubric");
    return { ...parsed, version: (data.version as number) ?? parsed.version };
  }

  // No in-app rubric saved yet — seed from the canonical docs/ file by job title.
  const { data: job } = await supabase
    .from("jobs")
    .select("title")
    .eq("shortcode", jobShortcode)
    .maybeSingle();
  const builtin = getBuiltinSeatRubric({
    shortcode: jobShortcode,
    title: job?.title as string | undefined,
  });
  if (builtin) return parseRubricMarkdown(seatRubricMarkdown(builtin), builtin.title);

  const { getSeedRubricForJob } = await import("../docs/seed");
  const seed = await getSeedRubricForJob(job?.title as string | undefined, jobShortcode);
  return parseRubricMarkdown(seed ?? DEFAULT_RUBRIC_MD);
}
