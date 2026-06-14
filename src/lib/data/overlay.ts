import { hasSupabase } from "../env";
import { getServiceSupabase } from "../supabase/server";
import type { BoardCandidate } from "../types";

export type OverlayStatus = "active" | "disqualified" | "withdrawn";

export interface CandidateOverlayRow {
  candidate_id: string;
  status: OverlayStatus;
  status_reason: string | null;
  complement: "owner" | "technician" | null;
  complement_removes: string | null;
  salary_vector: string | null;
  updated_by: string | null;
  updated_at: string;
}

export interface EvaluationRow {
  id: string;
  candidate_id: string;
  kind: string;
  ref: string | null;
  payload: Record<string, unknown>;
  model_version: string | null;
  rubric_version: number | null;
  created_at: string;
}

export async function fetchOverlays(
  candidateIds: string[],
): Promise<Map<string, CandidateOverlayRow>> {
  const map = new Map<string, CandidateOverlayRow>();
  if (!hasSupabase() || !candidateIds.length) return map;

  const supabase = getServiceSupabase();
  const { data } = await supabase
    .from("candidate_overlay")
    .select("*")
    .in("candidate_id", candidateIds);

  for (const row of (data ?? []) as CandidateOverlayRow[]) {
    map.set(row.candidate_id, row);
  }
  return map;
}

export async function fetchEvaluations(candidateId: string): Promise<EvaluationRow[]> {
  if (!hasSupabase()) return [];
  const supabase = getServiceSupabase();
  const { data } = await supabase
    .from("evaluations")
    .select("*")
    .eq("candidate_id", candidateId)
    .order("created_at", { ascending: false });
  return (data ?? []) as EvaluationRow[];
}

export function poolLineFromBoard(items: BoardCandidate[], overlays: Map<string, CandidateOverlayRow>) {
  let active = 0;
  let disqualified = 0;
  let withdrawn = 0;

  for (const item of items) {
    const overlay = overlays.get(item.candidate.workable_id);
    const status = overlay?.status ?? (item.candidate.disqualified ? "disqualified" : "active");
    if (status === "active") active += 1;
    else if (status === "withdrawn") withdrawn += 1;
    else disqualified += 1;
  }

  return `${active} active · ${disqualified} disqualified · ${withdrawn} withdrawn`;
}

export async function upsertOverlay(
  candidateId: string,
  patch: Partial<Omit<CandidateOverlayRow, "candidate_id" | "updated_at">>,
  updatedBy?: string,
) {
  if (!hasSupabase()) return;
  const supabase = getServiceSupabase();
  await supabase.from("candidate_overlay").upsert({
    candidate_id: candidateId,
    ...patch,
    updated_by: updatedBy ?? null,
    updated_at: new Date().toISOString(),
  });
}
