import "server-only";
import { hasSupabase } from "../env";
import { getServiceSupabase } from "../supabase/server";
import { chunkIds } from "../data/chunk";
import { TEXT_MAX } from "./limits";
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

/** What list views (pool, roster, cron worklists) need from a working file. */
export interface WorkingFileSummary {
  candidate_id: string;
  read: DecisionRead | null;
  /** Flags plus at most the latest correction; never transcripts, chat, replies, or timeline edits. */
  workspace: Pick<WorkspaceSlice, "deep" | "processStatus" | "decisionOverride" | "corrections">;
}

// Only the latest correction is read: the reviewer-signal lens looks at the
// newest one, and the full log can be long.
const SUMMARY_COLUMNS = [
  "candidate_id",
  "read",
  "deep:workspace->deep",
  "processStatus:workspace->processStatus",
  "decisionOverride:workspace->decisionOverride",
  "lastCorrection:workspace->corrections->-1",
].join(", ");

type SummaryRow = {
  candidate_id: string;
  read?: DecisionRead | null;
  deep?: unknown;
  processStatus?: unknown;
  decisionOverride?: unknown;
  lastCorrection?: unknown;
};

function lastCorrectionFrom(value: unknown): CorrectionEntry[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const entry = value as CorrectionEntry;
  if (typeof entry.text !== "string") return [];
  return [{ ...entry, text: entry.text.slice(0, TEXT_MAX) }];
}

/** Batch-load list-view summaries of working files, without the long-form workspace texts. */
export async function getWorkingFileSummaries(
  candidateIds: string[],
): Promise<Map<string, WorkingFileSummary>> {
  const map = new Map<string, WorkingFileSummary>();
  if (!hasSupabase() || !candidateIds.length) return map;

  const supabase = getServiceSupabase();
  for (const batch of chunkIds(candidateIds)) {
    const { data, error } = await supabase
      .from("candidate_working_files")
      .select(SUMMARY_COLUMNS)
      .in("candidate_id", batch);
    if (error) console.error("Failed to load working files batch", error);
    for (const row of (data ?? []) as unknown as SummaryRow[]) {
      map.set(row.candidate_id, {
        candidate_id: row.candidate_id,
        read: row.read ?? null,
        workspace: {
          deep: row.deep === true ? true : undefined,
          processStatus: typeof row.processStatus === "string" ? (row.processStatus as ProcessStatus) : null,
          decisionOverride: typeof row.decisionOverride === "string" ? (row.decisionOverride as Decision) : null,
          corrections: lastCorrectionFrom(row.lastCorrection),
        },
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
