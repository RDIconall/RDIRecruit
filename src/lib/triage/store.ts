import "server-only";
import { hasSupabase } from "../env";
import { getServiceSupabase } from "../supabase/server";
import { chunkIds } from "../data/chunk";
import { keepRecent } from "./limits";
import type { ChatMessage, DecisionRead, WorkspaceSlice } from "./types";

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

const BATCH_WORKSPACE_KEYS = [
  "ovr",
  "replies",
  "corrections",
  "transcript",
  "deep",
  "decisionOverride",
  "processStatus",
] as const satisfies ReadonlyArray<keyof WorkspaceSlice>;

const BATCH_COLUMNS = [
  "candidate_id",
  "read",
  "updated_at",
  "updated_by",
  ...BATCH_WORKSPACE_KEYS.map((key) => `${key}:workspace->${key}`),
].join(", ");

/**
 * Batch load for pool-wide views. Leaves out the rendered .md and the war-room
 * chat thread so pool size, not conversation length, bounds the payload; load
 * those per candidate with getWorkingFile / getChatThread.
 */
export async function getWorkingFiles(
  candidateIds: string[],
): Promise<Map<string, WorkingFileRow>> {
  const map = new Map<string, WorkingFileRow>();
  if (!hasSupabase() || !candidateIds.length) return map;

  const supabase = getServiceSupabase();
  for (const batch of chunkIds(candidateIds)) {
    const { data, error } = await supabase
      .from("candidate_working_files")
      .select(BATCH_COLUMNS)
      .in("candidate_id", batch);
    if (error) console.error("Failed to load working files batch", error);
    for (const row of (data ?? []) as unknown as Array<Record<string, unknown>>) {
      const workspace: Record<string, unknown> = {};
      for (const key of BATCH_WORKSPACE_KEYS) {
        if (row[key] !== undefined && row[key] !== null) workspace[key] = row[key];
      }
      const candidateId = row.candidate_id as string;
      map.set(
        candidateId,
        normalize({
          candidate_id: candidateId,
          read: row.read as DecisionRead | null,
          workspace: workspace as WorkspaceSlice,
          updated_at: row.updated_at as string | null,
          updated_by: row.updated_by as string | null,
        }),
      );
    }
  }
  return map;
}

/** The most recent war-room turns for one candidate (loaded when the dossier opens). */
export async function getChatThread(candidateId: string): Promise<ChatMessage[]> {
  if (!hasSupabase()) return [];
  const supabase = getServiceSupabase();
  const { data } = await supabase
    .from("candidate_working_files")
    .select("chat:workspace->chat")
    .eq("candidate_id", candidateId)
    .maybeSingle();
  const chat = (data as { chat?: unknown } | null)?.chat;
  return Array.isArray(chat) ? keepRecent(chat as ChatMessage[]) : [];
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
