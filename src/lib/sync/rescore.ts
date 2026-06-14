import { hasAnthropic, hasSupabase } from "../env";
import { getServiceSupabase } from "../supabase/server";
import { INTERVIEW_EVIDENCE_TYPES } from "./candidate-hash";

export type RescoreReason =
  | "new_evidence"
  | "async_video"
  | "interview"
  | "fireflies"
  | "manual";

/** Re-score only when new interview evidence arrives — not on status or comment changes. */
export async function rescoreCandidateOnNewEvidence(
  candidateId: string,
  reason: RescoreReason = "new_evidence",
) {
  if (!hasSupabase() || !hasAnthropic()) {
    return { scored: false, reason: "not_configured" as const };
  }

  const { scoreCandidate } = await import("../scoring/run-score");
  const result = await scoreCandidate(candidateId, { force: true, replace: true });

  const supabase = getServiceSupabase();
  await supabase.from("audit_log").insert({
    actor: "system",
    action: "rescore",
    entity: "candidate",
    entity_id: candidateId,
    detail: { reason },
  });

  return { scored: true, result };
}

export async function loadInterviewEvidenceText(candidateId: string): Promise<string> {
  if (!hasSupabase()) return "";
  const supabase = getServiceSupabase();
  const { data } = await supabase
    .from("evidence")
    .select("source_type, label, transcript, extracted, captured_at")
    .eq("candidate_id", candidateId)
    .in("source_type", [...INTERVIEW_EVIDENCE_TYPES])
    .order("captured_at", { ascending: true });

  if (!data?.length) return "";

  return data
    .map((row) => {
      const kind = row.source_type as string;
      const round = (row.label as string | null) ?? null;
      const label = round ? `${kind} · ${round}` : kind;
      const transcript = (row.transcript as string | null) ?? "";
      const summary =
        (row.extracted as { summary?: string } | null)?.summary ??
        (row.extracted as { chronologySummary?: string } | null)?.chronologySummary ??
        "";
      return [`[${label}]`, transcript, summary].filter(Boolean).join("\n");
    })
    .join("\n\n---\n\n");
}

export async function loadRecruiterCommentsText(candidateId: string): Promise<string> {
  if (!hasSupabase()) return "";
  const supabase = getServiceSupabase();
  const { data } = await supabase
    .from("evidence")
    .select("author, transcript, captured_at")
    .eq("candidate_id", candidateId)
    .eq("source_type", "workable_comment")
    .order("captured_at", { ascending: true });

  if (!data?.length) return "";
  return data
    .map((row) => {
      const author = (row.author as string | null) ?? "recruiter";
      const body = (row.transcript as string | null) ?? "";
      return `${author}: ${body}`;
    })
    .join("\n");
}
