import { hasSupabase } from "../env";
import { getServiceSupabase } from "../supabase/server";
import { chunkIds } from "./chunk";
import { MAX_CUT_REASON_CHARS } from "./cut-reason";
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

// Board loads hydrate every applicant in a pool, so they never pull the free-text
// status_reason; only single-candidate reads ask for it.
const BOARD_OVERLAY_COLUMNS =
  "candidate_id, status, complement, complement_removes, salary_vector, updated_by, updated_at";

export async function fetchOverlays(
  candidateIds: string[],
  options?: { withReason?: boolean },
): Promise<Map<string, CandidateOverlayRow>> {
  const map = new Map<string, CandidateOverlayRow>();
  if (!hasSupabase() || !candidateIds.length) return map;

  const withReason = options?.withReason === true;
  const supabase = getServiceSupabase();
  for (const batch of chunkIds(candidateIds)) {
    const { data, error } = await supabase
      .from("candidate_overlay")
      .select(withReason ? "*" : BOARD_OVERLAY_COLUMNS)
      .in("candidate_id", batch);
    if (error) console.error("Failed to load overlay batch", error);
    for (const row of (data ?? []) as unknown as CandidateOverlayRow[]) {
      map.set(row.candidate_id, withReason ? row : { ...row, status_reason: null });
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

export async function upsertOverlay(
  candidateId: string,
  patch: Partial<Omit<CandidateOverlayRow, "candidate_id" | "updated_at">>,
  updatedBy?: string,
) {
  if (!hasSupabase()) return;
  if (typeof patch.status_reason === "string" && patch.status_reason.length > MAX_CUT_REASON_CHARS) {
    throw new Error(`status_reason exceeds ${MAX_CUT_REASON_CHARS} characters`);
  }
  const supabase = getServiceSupabase();
  await supabase.from("candidate_overlay").upsert({
    candidate_id: candidateId,
    ...patch,
    updated_by: updatedBy ?? null,
    updated_at: new Date().toISOString(),
  });
}
