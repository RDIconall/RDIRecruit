import { getServiceSupabase } from "../supabase/server";
import { hasSupabase } from "../env";
import type { BoardCandidate, CandidateRow, RoAssessmentRow, ScoreRow } from "../types";
import { fetchOverlays } from "./overlay";

function latestByCandidate<T extends { candidate_id: string; created_at?: string }>(
  rows: T[],
): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) {
    const existing = map.get(row.candidate_id);
    if (!existing || (row.created_at ?? "") > (existing.created_at ?? "")) {
      map.set(row.candidate_id, row);
    }
  }
  return map;
}

/** Batch-fetch latest scores + RO assessments (2 queries total, not 2×N). */
export async function fetchScoresForCandidates(
  candidateIds: string[],
): Promise<Map<string, { score: ScoreRow | null; ro: RoAssessmentRow | null }>> {
  const result = new Map<string, { score: ScoreRow | null; ro: RoAssessmentRow | null }>();
  for (const id of candidateIds) result.set(id, { score: null, ro: null });

  if (!hasSupabase() || !candidateIds.length) return result;

  const supabase = getServiceSupabase();

  const [{ data: scoreRows }, { data: roRows }] = await Promise.all([
    supabase.from("scores").select("*").in("candidate_id", candidateIds),
    supabase.from("ro_assessments").select("*").in("candidate_id", candidateIds),
  ]);

  const latestScores = latestByCandidate((scoreRows ?? []) as ScoreRow[]);
  const latestRo = latestByCandidate((roRows ?? []) as RoAssessmentRow[]);

  for (const id of candidateIds) {
    result.set(id, {
      score: latestScores.get(id) ?? null,
      ro: latestRo.get(id) ?? null,
    });
  }
  return result;
}

/**
 * Batch-fetch the Evidence-view extras: the one-line investment read + salary
 * ask, both from the latest invest_head evaluation. One query.
 */
export async function fetchBoardExtras(
  candidateIds: string[],
): Promise<Map<string, { why: string | null; ask: string | null }>> {
  const map = new Map<string, { why: string | null; ask: string | null }>();
  if (!hasSupabase() || !candidateIds.length) return map;

  const supabase = getServiceSupabase();
  const { data: evalRows } = await supabase
    .from("evaluations")
    .select("candidate_id, payload, created_at")
    .eq("kind", "invest_head")
    .in("candidate_id", candidateIds);

  const latestEval = latestByCandidate(
    (evalRows ?? []) as Array<{ candidate_id: string; payload: Record<string, unknown>; created_at: string }>,
  );
  for (const [id, row] of latestEval) {
    const payload = row.payload as { summary?: string; ask?: string | null } | undefined;
    map.set(id, {
      why: payload?.summary ?? null,
      ask: (payload?.ask as string | null) ?? null,
    });
  }
  return map;
}

export async function getBoardFromSupabase(jobShortcode: string): Promise<BoardCandidate[] | null> {
  if (!hasSupabase()) return null;

  const supabase = getServiceSupabase();
  const { data: candidates } = await supabase
    .from("candidates")
    .select("*")
    .eq("job_shortcode", jobShortcode);

  if (!candidates?.length) return null;

  const ids = candidates.map((c) => c.workable_id as string);
  const [scoreMap, overlayMap, extrasMap] = await Promise.all([
    fetchScoresForCandidates(ids),
    fetchOverlays(ids),
    fetchBoardExtras(ids),
  ]);

  const board = (candidates as CandidateRow[]).map((candidate) => {
    const overlay = overlayMap.get(candidate.workable_id) ?? null;
    const extras = extrasMap.get(candidate.workable_id);
    const ro = scoreMap.get(candidate.workable_id)?.ro ?? null;
    return {
      candidate,
      score: scoreMap.get(candidate.workable_id)?.score ?? null,
      ro,
      overlay,
      why: extras?.why ?? null,
      ask: extras?.ask ?? null,
      sources: ro?.per_role?.length ?? 0,
      assignee: overlay?.updated_by ?? null,
    };
  });

  return board.sort((a, b) => {
    const aActive = !(
      a.overlay?.status === "disqualified" ||
      a.overlay?.status === "withdrawn" ||
      a.candidate.disqualified
    );
    const bActive = !(
      b.overlay?.status === "disqualified" ||
      b.overlay?.status === "withdrawn" ||
      b.candidate.disqualified
    );
    if (aActive !== bActive) return aActive ? -1 : 1;
    return (b.score?.total ?? -1) - (a.score?.total ?? -1);
  });
}

export async function getPoolStatsForJob(jobShortcode: string) {
  const board = await getBoardFromSupabase(jobShortcode);
  if (!board) return { active: 0, owners: 0, poolLine: "" };

  let active = 0;
  let disqualified = 0;
  let withdrawn = 0;
  for (const item of board) {
    const status =
      item.overlay?.status ?? (item.candidate.disqualified ? "disqualified" : "active");
    if (status === "active") active += 1;
    else if (status === "withdrawn") withdrawn += 1;
    else disqualified += 1;
  }

  const activeBoard = board.filter(
    (b) =>
      b.overlay?.status !== "withdrawn" &&
      b.overlay?.status !== "disqualified" &&
      !b.candidate.disqualified,
  );
  return {
    active: activeBoard.length,
    owners: activeBoard.filter((b) => b.overlay?.complement === "owner").length,
    poolLine: `${active} active · ${disqualified} disqualified · ${withdrawn} withdrawn`,
  };
}
