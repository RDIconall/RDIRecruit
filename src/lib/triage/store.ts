import "server-only";
import { hasSupabase } from "../env";
import { getServiceSupabase } from "../supabase/server";
import { chunkIds } from "../data/chunk";
import type { DecisionRead, WorkspaceSlice } from "./types";

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

const MAX_WRITE_ATTEMPTS = 8;

/**
 * A version stamp strictly different from the one read, so the compare-and-swap
 * below can never match a row another writer has already replaced.
 */
function nextVersion(previous: string | null): string {
  const now = Date.now();
  const prior = previous ? Date.parse(previous) : NaN;
  return new Date(Number.isFinite(prior) && now <= prior ? prior + 1 : now).toISOString();
}

/**
 * Read-modify-write a candidate's working file without losing concurrent edits.
 * `mutate` receives the row as it is committed right now and returns the fields
 * to change (workspace keys are shallow-merged). The write only lands if the row
 * is still at the version that was read (`updated_at`); otherwise the row is
 * re-read and `mutate` runs again on the newer state.
 */
export async function updateWorkingFile(
  candidateId: string,
  mutate: (current: WorkingFileRow | null) => WorkingFilePatch,
  updatedBy?: string,
): Promise<WorkingFileRow | null> {
  if (!hasSupabase()) return null;
  const supabase = getServiceSupabase();

  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    const existing = await getWorkingFile(candidateId);
    const patch = mutate(existing);
    const next: Record<string, unknown> = {
      candidate_id: candidateId,
      content: patch.content !== undefined ? patch.content : existing?.content ?? null,
      read: patch.read !== undefined ? patch.read : existing?.read ?? null,
      workspace:
        patch.workspace !== undefined
          ? { ...(existing?.workspace ?? {}), ...patch.workspace }
          : existing?.workspace ?? {},
      updated_at: nextVersion(existing?.updated_at ?? null),
      updated_by: updatedBy ?? existing?.updated_by ?? null,
    };

    if (!existing) {
      const { data, error } = await supabase.from("candidate_working_files").insert(next).select("*");
      if (error?.code === "23505") continue;
      if (error) {
        console.error(`Failed to create working file for ${candidateId}`, error);
        return null;
      }
      const row = (data ?? [])[0];
      return row ? normalize(row as WorkingFileRow) : null;
    }

    const base = supabase.from("candidate_working_files").update(next).eq("candidate_id", candidateId);
    const guarded = existing.updated_at === null ? base.is("updated_at", null) : base.eq("updated_at", existing.updated_at);
    const { data, error } = await guarded.select("*");
    if (error) {
      console.error(`Failed to update working file for ${candidateId}`, error);
      return null;
    }
    const row = (data ?? [])[0];
    if (row) return normalize(row as WorkingFileRow);
  }

  throw new Error(`Working file for ${candidateId} kept changing during save; please retry.`);
}

/** Merge-patch a candidate's working file. Only the provided fields are written. */
export async function upsertWorkingFile(
  candidateId: string,
  patch: WorkingFilePatch,
  updatedBy?: string,
): Promise<WorkingFileRow | null> {
  return updateWorkingFile(candidateId, () => patch, updatedBy);
}
