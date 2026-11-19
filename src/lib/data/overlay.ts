import { hasSupabase } from "../env";
import { getServiceSupabase } from "../supabase/server";
import { chunkIds } from "./chunk";
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
  for (const batch of chunkIds(candidateIds)) {
    const { data, error } = await supabase
      .from("candidate_overlay")
      .select("*")
      .in("candidate_id", batch);
    if (error) console.error("Failed to load overlay batch", error);
    for (const row of (data ?? []) as CandidateOverlayRow[]) {
      map.set(row.candidate_id, row);
    }
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

/** A human or sync cut takes the person out of the pool; scoring never undoes it. */
export function isCutOverlayStatus(status: string | null | undefined): boolean {
  return status === "disqualified" || status === "withdrawn";
}

export async function fetchOverlayStatus(candidateId: string): Promise<OverlayStatus | null> {
  if (!hasSupabase()) return null;
  const supabase = getServiceSupabase();
  const { data, error } = await supabase
    .from("candidate_overlay")
    .select("status")
    .eq("candidate_id", candidateId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load overlay status: ${error.message}`);
  return ((data as { status?: OverlayStatus } | null)?.status ?? null) as OverlayStatus | null;
}

/**
 * Write only the scorer-owned complement columns. Status, status reason, and
 * attribution belong to reviewer and sync actions, so an insert takes the
 * column defaults and an update leaves them as they are.
 */
export async function saveOverlayComplement(
  candidateId: string,
  fields: Pick<CandidateOverlayRow, "complement" | "complement_removes" | "salary_vector">,
) {
  if (!hasSupabase()) return;
  const supabase = getServiceSupabase();
  const { error } = await supabase.from("candidate_overlay").upsert(
    {
      candidate_id: candidateId,
      complement: fields.complement,
      complement_removes: fields.complement_removes,
      salary_vector: fields.salary_vector,
    },
    { onConflict: "candidate_id" },
  );
  if (error) console.error(`Failed to save overlay complement for ${candidateId}`, error);
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
