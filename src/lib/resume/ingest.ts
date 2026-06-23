import { getServiceSupabase } from "../supabase/server";
import { hasSupabase } from "../env";
import { downloadResumeFile, hashResumeSource } from "./download";
import { extractTextFromResume } from "./extract-text";
import { narrativeFromParsedResume, experienceFromParsedResume, educationFromParsedResume } from "./narrative-from-parse";
import { parseResumeIntelligently } from "./parse-resume";
import type { ResumeIngestResult } from "./types";

export async function ingestResumeForCandidate(input: {
  candidateId: string;
  candidateName: string;
  resumeUrl: string | null | undefined;
  workableUpdatedAt?: string;
  parsedExperience?: unknown[];
  parsedEducation?: unknown[];
  force?: boolean;
}): Promise<ResumeIngestResult | null> {
  if (!hasSupabase() || !input.resumeUrl) return null;

  const supabase = getServiceSupabase();
  const sourceHash = hashResumeSource(input.resumeUrl, input.workableUpdatedAt);

  const { data: existing } = await supabase
    .from("applications")
    .select("resume_source_hash, resume_storage_path")
    .eq("candidate_id", input.candidateId)
    .maybeSingle();

  if (!input.force && existing?.resume_source_hash === sourceHash && existing?.resume_storage_path) {
    return null;
  }

  const { buffer, mime, extension } = await downloadResumeFile(input.resumeUrl);
  const text = await extractTextFromResume(buffer, mime, extension);
  const parsed = await parseResumeIntelligently({
    candidateName: input.candidateName,
    resumeText: text,
    workableExperience: input.parsedExperience,
    workableEducation: input.parsedEducation,
  });

  const storagePath = `${input.candidateId}/resume.${extension}`;
  const { error: uploadError } = await supabase.storage
    .from("captures")
    .upload(storagePath, buffer, { upsert: true, contentType: mime });

  if (uploadError) {
    throw new Error(`Storage upload failed: ${uploadError.message}`);
  }

  const narrative = narrativeFromParsedResume(parsed);
  const parsedExperience = experienceFromParsedResume(parsed);
  const parsedEducation = educationFromParsedResume(parsed);

  const { error: appUpdateError } = await supabase
    .from("applications")
    .update({
      resume_storage_path: storagePath,
      resume_mime: mime,
      resume_text: text,
      resume_parsed: parsed,
      resume_ingested_at: new Date().toISOString(),
      resume_source_hash: sourceHash,
      parsed_experience: parsedExperience.length ? parsedExperience : input.parsedExperience,
      parsed_education: parsedEducation.length ? parsedEducation : input.parsedEducation,
    })
    .eq("candidate_id", input.candidateId);

  // Surface (don't swallow) a failed write — otherwise the upload "succeeds" and
  // callers count a false ingest while resume_storage_path/resume_text stay null.
  if (appUpdateError) {
    throw new Error(`Application résumé update failed: ${appUpdateError.message}`);
  }

  await supabase.from("evidence").delete().eq("candidate_id", input.candidateId).eq("source_type", "resume");

  await supabase.from("evidence").insert({
    candidate_id: input.candidateId,
    source_type: "resume",
    raw_ref: storagePath,
    extracted: {
      chronologySummary: parsed.chronologySummary,
      dateFlags: parsed.dateFlags,
      modelVersion: parsed.modelVersion,
    },
    captured_at: new Date().toISOString(),
  });

  const { data: existingNarrative } = await supabase
    .from("narratives")
    .select("id")
    .eq("candidate_id", input.candidateId)
    .limit(1);

  if (!existingNarrative?.length) {
    await supabase.from("narratives").insert({
      candidate_id: input.candidateId,
      segments: narrative,
    });
  } else {
    await supabase
      .from("narratives")
      .update({ segments: narrative, generated_at: new Date().toISOString() })
      .eq("candidate_id", input.candidateId);
  }

  await supabase
    .from("evaluations")
    .delete()
    .eq("candidate_id", input.candidateId)
    .eq("ref", "resume-chronology");

  await supabase.from("evaluations").insert({
    candidate_id: input.candidateId,
    kind: "verification",
    ref: "resume-chronology",
    payload: {
      verdict: parsed.dateFlags.length ? "WATCH" : "CLEAN",
      category: "Résumé chronology",
      explanation: parsed.chronologySummary,
      flags: parsed.dateFlags,
    },
    model_version: parsed.modelVersion,
  });

  await supabase.from("audit_log").insert({
    actor: "system",
    action: "resume_ingest",
    entity: "candidate",
    entity_id: input.candidateId,
    detail: { storagePath, bytes: buffer.length, mime },
  });

  return { storagePath, mime, text, parsed };
}

export async function getSignedResumeUrl(
  candidateId: string,
  actor = "system",
): Promise<{ url: string; mime: string } | null> {
  if (!hasSupabase()) return null;
  const supabase = getServiceSupabase();

  const { data: app } = await supabase
    .from("applications")
    .select("resume_storage_path, resume_mime")
    .eq("candidate_id", candidateId)
    .maybeSingle();

  if (!app?.resume_storage_path) return null;

  const { data, error } = await supabase.storage
    .from("captures")
    .createSignedUrl(app.resume_storage_path, 3600);

  if (error || !data?.signedUrl) return null;

  await supabase.from("audit_log").insert({
    actor,
    action: "resume_view",
    entity: "candidate",
    entity_id: candidateId,
    detail: { path: app.resume_storage_path },
  });

  return { url: data.signedUrl, mime: app.resume_mime ?? "application/pdf" };
}
