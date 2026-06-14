"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@clerk/nextjs/server";
import { parseRubricMarkdown } from "@/lib/rubric/parser";
import { getServiceSupabase } from "@/lib/supabase/server";
import { hasSupabase } from "@/lib/env";

export async function saveRubric(input: {
  jobShortcode: string;
  markdown: string;
  name?: string;
}) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");
  if (!hasSupabase()) return { ok: false, error: "Supabase not configured" };

  const parsed = parseRubricMarkdown(input.markdown);
  const supabase = getServiceSupabase();

  const { data: latest } = await supabase
    .from("rubrics")
    .select("version")
    .eq("job_shortcode", input.jobShortcode)
    .order("version", { ascending: false })
    .limit(1);

  const version = (latest?.[0]?.version ?? 0) + 1;

  await supabase
    .from("rubrics")
    .update({ active: false })
    .eq("job_shortcode", input.jobShortcode);

  const { data: row, error } = await supabase
    .from("rubrics")
    .insert({
      job_shortcode: input.jobShortcode,
      version,
      name: input.name ?? `Rubric v${version}`,
      raw_md: input.markdown,
      definition: parsed.definition,
      weights: parsed.weights,
      active: true,
    })
    .select("id, version")
    .single();

  if (error) return { ok: false, error: error.message };

  revalidatePath("/rubrics");
  revalidatePath("/board");
  return { ok: true, version: row?.version, id: row?.id };
}

/** Extract plain text/markdown from an uploaded rubric file (.md/.txt/.pdf/.docx). */
export async function extractRubricFromFile(formData: FormData) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false as const, error: "No file provided" };
  if (file.size > 5_000_000) return { ok: false as const, error: "File too large (max 5MB)" };

  const buffer = Buffer.from(await file.arrayBuffer());
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const { extractTextFromResume } = await import("@/lib/resume/extract-text");

  try {
    const text = await extractTextFromResume(buffer, file.type, ext);
    if (!text.trim()) return { ok: false as const, error: "No text found in file" };
    return { ok: true as const, text };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : "Could not read file",
    };
  }
}

/** Save the global "How We Evaluate" method doc (re-scores all seats via the epoch). */
export async function saveMethod(markdown: string) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");
  const { saveMethodDoc } = await import("@/lib/evaluation/method");
  const result = await saveMethodDoc(markdown);
  revalidatePath("/rubrics");
  revalidatePath("/board");
  return result;
}

/**
 * Markdown to show in the rubric editor: the in-app edit if one exists, else the
 * canonical docs/ seed for this seat. Returns `{ markdown, source }` so the UI can
 * tell the user whether they're editing a saved version or the seed file.
 */
export async function getActiveRubricMarkdown(jobShortcode: string) {
  if (hasSupabase()) {
    const supabase = getServiceSupabase();
    const { data } = await supabase
      .from("rubrics")
      .select("raw_md, version")
      .eq("job_shortcode", jobShortcode)
      .eq("active", true)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data?.raw_md) {
      return {
        markdown: data.raw_md as string,
        source: "saved" as const,
        version: (data.version as number) ?? null,
      };
    }
    const { data: job } = await supabase
      .from("jobs")
      .select("title")
      .eq("shortcode", jobShortcode)
      .maybeSingle();
    const { getSeedRubricForJob } = await import("@/lib/docs/seed");
    const seed = await getSeedRubricForJob(job?.title as string | undefined);
    if (seed) return { markdown: seed, source: "seed" as const, version: null };
  }
  return { markdown: null, source: "none" as const, version: null };
}
