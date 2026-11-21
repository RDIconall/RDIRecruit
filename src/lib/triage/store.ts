import "server-only";
import { hasSupabase } from "../env";
import { getServiceSupabase } from "../supabase/server";
import { chunkIds } from "../data/chunk";
import type { CorrectionEntry, Decision, DecisionRead, ProcessStatus, WorkspaceSlice } from "./types";

export interface WorkingFileRow {
  candidate_id: string;
  content: string | null;
  read: DecisionRead | null;
  workspace: WorkspaceSlice;
  updated_at: string | null;
  updated_by: string | null;
}

function normalize(row: Partial<WorkingFileRow> & { candidate_id: string }): WorkingFileRow {
  return {
    candidate_id: row.candidate_id,
    content: row.content ?? null,
    read: (row.read as DecisionRead | null) ?? null,
    workspace: (row.workspace as WorkspaceSlice | null) ?? {},
    updated_at: row.updated_at ?? null,
    updated_by: row.updated_by ?? null,
  };
}

export async function getWorkingFiles(
  candidateIds: string[],
): Promise<Map<string, WorkingFileRow>> {
  const map = new Map<string, WorkingFileRow>();
  if (!hasSupabase() || !candidateIds.length) return map;

  const supabase = getServiceSupabase();
  for (const batch of chunkIds(candidateIds)) {
    const { data, error } = await supabase
      .from("candidate_working_files")
      .select("*")
      .in("candidate_id", batch);
    if (error) console.error("Failed to load working files batch", error);
    for (const row of (data ?? []) as WorkingFileRow[]) {
      map.set(row.candidate_id, normalize(row));
    }
  }
  return map;
}

/** The slice of a working file a multi-candidate list needs. */
export interface PoolWorkingFile {
  read: DecisionRead | null;
  decisionOverride: Decision | null;
  processStatus: ProcessStatus | null;
  /** At most the newest correction — what the board's reviewer-signal lens reads. */
  corrections: CorrectionEntry[];
}

/**
 * Load the list-view fields of many working files. Never selects `content` or the
 * whole `workspace`: those carry every pasted transcript, chat turn, and note for
 * the candidate, and reading them for a whole pool lets one account's edits make
 * the board slow or impossible to build. Open one candidate with getWorkingFile.
 */
export async function getPoolWorkingFiles(candidateIds: string[]): Promise<Map<string, PoolWorkingFile>> {
  const map = new Map<string, PoolWorkingFile>();
  if (!hasSupabase() || !candidateIds.length) return map;

  const supabase = getServiceSupabase();
  for (const batch of chunkIds(candidateIds)) {
    const { data, error } = await supabase
      .from("candidate_working_files")
      .select(
        "candidate_id, read, decisionOverride:workspace->decisionOverride, processStatus:workspace->processStatus, lastCorrection:workspace->corrections->-1",
      )
      .in("candidate_id", batch);
    if (error) console.error("Failed to load working files batch", error);
    // supabase-js cannot type a negative JSON index; PostgREST (>= v10.2) accepts it.
    for (const row of (data ?? []) as unknown as Array<{
      candidate_id: string;
      read?: DecisionRead | null;
      decisionOverride?: Decision | null;
      processStatus?: ProcessStatus | null;
      lastCorrection?: CorrectionEntry | null;
    }>) {
      const last = row.lastCorrection;
      map.set(row.candidate_id, {
        read: row.read ?? null,
        decisionOverride: row.decisionOverride ?? null,
        processStatus: row.processStatus ?? null,
        corrections: last && typeof last === "object" && typeof last.text === "string" ? [last] : [],
      });
    }
  }
  return map;
}

export async function getWorkingFile(candidateId: string): Promise<WorkingFileRow | null> {
  if (!hasSupabase()) return null;
  const supabase = getServiceSupabase();
  const { data } = await supabase
    .from("candidate_working_files")
    .select("*")
    .eq("candidate_id", candidateId)
    .maybeSingle();
  return data ? normalize(data as WorkingFileRow) : null;
}

export interface WorkingFilePatch {
  content?: string;
  read?: DecisionRead | null;
  workspace?: WorkspaceSlice;
}

/** Merge-patch a candidate's working file. Only the provided fields are written. */
export async function upsertWorkingFile(
  candidateId: string,
  patch: WorkingFilePatch,
  updatedBy?: string,
): Promise<WorkingFileRow | null> {
  if (!hasSupabase()) return null;
  const supabase = getServiceSupabase();

  const existing = await getWorkingFile(candidateId);
  const next: Record<string, unknown> = {
    candidate_id: candidateId,
    content: patch.content !== undefined ? patch.content : existing?.content ?? null,
    read: patch.read !== undefined ? patch.read : existing?.read ?? null,
    workspace:
      patch.workspace !== undefined
        ? { ...(existing?.workspace ?? {}), ...patch.workspace }
        : existing?.workspace ?? {},
    updated_at: new Date().toISOString(),
    updated_by: updatedBy ?? existing?.updated_by ?? null,
  };

  const { data } = await supabase
    .from("candidate_working_files")
    .upsert(next, { onConflict: "candidate_id" })
    .select("*")
    .maybeSingle();

  return data ? normalize(data as WorkingFileRow) : normalize(next as unknown as WorkingFileRow);
}
